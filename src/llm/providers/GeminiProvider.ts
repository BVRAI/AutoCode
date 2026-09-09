// Google Gemini provider. Targets generativelanguage.googleapis.com directly
// in BYOK mode; when hosted by Automax V6, baseOverride routes through the
// proxy's /v1/google passthrough which forwards the same path and swaps the
// auth header to the proxy's master key.
//
// Gemini's REST API differs meaningfully from Anthropic/OpenAI:
//   - URL bakes the API version: POST {base}/v1beta/models/{model}:generateContent
//   - The system prompt lives at top-level `systemInstruction`, not in `contents`
//   - Roles are 'user' / 'model' (no 'assistant')
//   - Tool definitions live under `tools[0].functionDeclarations`
//   - Tool calls come back as parts: { functionCall: { name, args } }
//   - Tool results go back as parts: { functionResponse: { name, response } }
//     — matched by NAME, not by an opaque id (Anthropic-style tool_use_id),
//     so we resolve toolUseId → name by scanning prior assistant turns.
//   - Streaming uses :streamGenerateContent?alt=sse, which yields chunks
//     shaped exactly like the non-streaming response but emitted as SSE.
//
// We yield only the high-level StreamEvent shape autocode's core expects;
// any Gemini specifics that aren't needed (safety ratings, citation
// metadata, etc.) are dropped.
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  LlmProvider,
  Message,
  StreamEvent,
  ToolSchema,
} from '../types.js';
import { isProxyAuth, type AuthMode } from '../../auth/AuthResolver.js';
import type { EffortLevel } from '../types.js';
import { parseSseStream } from '../sse.js';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';

export class GeminiProvider implements LlmProvider {
  readonly name = 'google';

  constructor(private readonly auth: AuthMode) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const { url, headers, body } = this.prepare(req, /*stream=*/ false);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`google ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as GeminiResponse;
    return fromGeminiResponse(json, req.model);
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    // :streamGenerateContent?alt=sse — each SSE chunk is shaped like the
    // non-streaming response and carries the parts generated since the last
    // chunk (thought text, visible text, whole function calls).
    const { url, headers, body } = this.prepare(req, /*stream=*/ true);
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`google ${res.status}: ${text.slice(0, 500)}`);
    }
    yield* streamGemini(res, req.model);
  }

  // Shared request prep — encodes auth, builds the URL, and translates the
  // provider-neutral CompletionRequest into Gemini's shape.
  private prepare(req: CompletionRequest, stream: boolean): {
    url: string;
    headers: Record<string, string>;
    body: GeminiRequestBody;
  } {
    if (this.auth.kind === 'missing') {
      throw new Error('google credentials missing — set GOOGLE_API_KEY or AUTOMAX_PROXY_TOKEN');
    }
    const base = isProxyAuth(this.auth) ? this.auth.baseOverride : DEFAULT_BASE;
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `${base}/${API_VERSION}/models/${encodeURIComponent(req.model)}:${action}`;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.auth.kind === 'byok') {
      // Direct Google API uses the proprietary x-goog-api-key header. Bearer
      // also works on /v1beta but x-goog-api-key is the documented path.
      headers['x-goog-api-key'] = this.auth.apiKey;
    } else if (isProxyAuth(this.auth)) {
      // Proxy expects Firebase ID token (automax) or sk_amx_ key (amxkey);
      // it swaps to x-goog-api-key upstream either way.
      headers['authorization'] = `Bearer ${this.auth.token}`;
    }

    // Gemini caching is via an explicit cachedContents resource (unused here),
    // so there's no inline breakpoint — fold any volatile suffix onto the
    // system instruction text, stable content first.
    const systemText = req.systemVolatile ? `${req.system}\n${req.systemVolatile}` : req.system;
    const body: GeminiRequestBody = {
      contents: messagesToGeminiContents(req.messages),
      ...(systemText
        ? { systemInstruction: { parts: [{ text: systemText }] } }
        : {}),
      ...(req.tools.length > 0 ? { tools: toolsToGeminiTools(req.tools) } : {}),
      generationConfig: {
        temperature: req.temperature ?? 1.0,
        maxOutputTokens: req.maxTokens ?? 8192,
        // Gemini 3 takes a level, Gemini 2.5 a budget; thinkingFor() picks the
        // mode per model (and keeps google disarmed until the outbound
        // thoughtSignature echo exists — enabling thoughts without it breaks
        // tool use).
        ...(req.thinking
          ? {
              thinkingConfig: {
                includeThoughts: true,
                ...(req.thinking.mode === 'effort'
                  ? { thinkingLevel: geminiThinkingLevel(req.thinking.effort) }
                  : { thinkingBudget: req.thinking.budgetTokens ?? 8192 }),
              },
            }
          : {}),
      },
    };

    return { url, headers, body };
  }
}

/** Gemini 3 thinking levels; `max` and unset read as HIGH. */
function geminiThinkingLevel(effort: EffortLevel | undefined): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (effort === 'low') return 'LOW';
  if (effort === 'medium') return 'MEDIUM';
  return 'HIGH';
}

// ── Translation helpers ────────────────────────────────────────────────────

function messagesToGeminiContents(messages: Message[]): GeminiContent[] {
  // Gemini requires functionResponse parts to carry the tool NAME, but our
  // ToolResultBlock only knows the toolUseId. We resolve by walking back
  // through prior assistant turns and collecting tool_use blocks by id.
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') toolNameById.set(b.id, b.name);
    }
  }

  const out: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      throw new Error('system messages should be passed via req.system, not in messages array');
    }
    const role = m.role === 'assistant' ? 'model' : 'user';

    if (typeof m.content === 'string') {
      if (m.content.length > 0) out.push({ role, parts: [{ text: m.content }] });
      continue;
    }

    const parts: GeminiPart[] = [];
    // thoughtSignatures ride on the function-call or text part they arrived
    // with; a signature captured on a thought block attaches to the next part.
    let pendingSignature: string | undefined;
    const takeSignature = (b: { opaque?: unknown }): string | undefined => {
      const own = signatureOf(b.opaque);
      if (own) return own;
      const carried = pendingSignature;
      pendingSignature = undefined;
      return carried;
    };
    for (const b of m.content) {
      switch (b.type) {
        case 'text': {
          if (b.text.length === 0) break;
          const sig = takeSignature(b);
          parts.push(sig ? { text: b.text, thoughtSignature: sig } : { text: b.text });
          break;
        }
        case 'tool_use': {
          const sig = takeSignature(b);
          parts.push(
            sig
              ? { functionCall: { name: b.name, args: b.input }, thoughtSignature: sig }
              : { functionCall: { name: b.name, args: b.input } },
          );
          break;
        }
        case 'tool_result': {
          const name = toolNameById.get(b.toolUseId) ?? b.toolUseId;
          // Gemini wants a structured `response` object. If the agent passed
          // a plain string back from the tool, wrap it as { output: "..." }.
          const responseObj: Record<string, unknown> = b.isError
            ? { error: b.content }
            : { output: b.content };
          parts.push({ functionResponse: { name, response: responseObj } });
          break;
        }
        case 'image':
        case 'document':
          parts.push({ inlineData: { mimeType: b.mediaType, data: b.data } });
          break;
        case 'thinking': {
          // Thought text is never replayed; only its signature is, on the
          // next function-call or text part (Gemini 2.5 puts it there).
          const sig = signatureOf(b.opaque);
          if (sig) pendingSignature = sig;
          break;
        }
      }
    }
    if (parts.length > 0) out.push({ role, parts });
  }
  return out;
}

function toolsToGeminiTools(tools: ToolSchema[]): GeminiToolBlock[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        // Gemini expects an OpenAPI-ish parameters schema, which is what
        // autocode tools already store in ToolSchema.inputSchema. Pass
        // through unchanged.
        parameters: t.inputSchema as Record<string, unknown>,
      })),
    },
  ];
}

function signatureOf(opaque: unknown): string | undefined {
  if (!opaque || typeof opaque !== 'object') return undefined;
  const s = (opaque as { thoughtSignature?: unknown }).thoughtSignature;
  return typeof s === 'string' && s.length > 0 ? s : undefined;
}

type GeminiResponsePart = NonNullable<NonNullable<NonNullable<GeminiResponse['candidates']>[number]['content']>['parts']>[number];

/**
 * Folds response parts (whole or streamed) into content blocks. Consecutive
 * thought text and consecutive visible text each merge into one block;
 * every function call is its own block; a thoughtSignature stays on the block
 * that carried it, so the outbound pass can put it back on the same part.
 */
class GeminiAccumulator {
  private readonly out: ContentBlock[] = [];
  private toolCallSeq = 0;

  *push(part: GeminiResponsePart): Iterable<StreamEvent> {
    // Check `thought` BEFORE text — thought parts also carry `text`, and
    // reasoning must not leak into the visible reply.
    if (part.thought === true) {
      const text = typeof part.text === 'string' ? part.text : '';
      const last = this.out[this.out.length - 1];
      if (last && last.type === 'thinking') last.text += text;
      else this.out.push({ type: 'thinking', text });
      if (part.thoughtSignature) this.attachSignature(part.thoughtSignature);
      if (text.length > 0) yield { type: 'thinking_delta', text };
      return;
    }
    if (part.functionCall) {
      const id = `gem-${++this.toolCallSeq}`;
      const block: ContentBlock = {
        type: 'tool_use',
        id,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
        ...(part.thoughtSignature ? { opaque: { thoughtSignature: part.thoughtSignature } } : {}),
      };
      this.out.push(block);
      yield { type: 'tool_use_start', id, name: part.functionCall.name };
      yield { type: 'tool_use_delta', argsJsonChunk: JSON.stringify(part.functionCall.args ?? {}) };
      yield { type: 'tool_use_stop' };
      return;
    }
    if (typeof part.text === 'string' && part.text.length > 0) {
      const last = this.out[this.out.length - 1];
      if (last && last.type === 'text') last.text += part.text;
      else this.out.push({ type: 'text', text: part.text });
      if (part.thoughtSignature) this.attachSignature(part.thoughtSignature);
      yield { type: 'text_delta', text: part.text };
      return;
    }
    // A part carrying only a signature (end of a streamed answer).
    if (part.thoughtSignature) this.attachSignature(part.thoughtSignature);
  }

  private attachSignature(sig: string): void {
    const last = this.out[this.out.length - 1];
    if (!last || last.type === 'tool_result' || last.type === 'image') return;
    (last as { opaque?: unknown }).opaque = { thoughtSignature: sig };
  }

  blocks(): ContentBlock[] {
    return this.out;
  }
}

function fromGeminiResponse(r: GeminiResponse, requestedModel: string): CompletionResponse {
  const cand = r.candidates?.[0];
  const acc = new GeminiAccumulator();
  for (const part of cand?.content?.parts ?? []) {
    for (const _ of acc.push(part)) {
      /* events are not needed for the non-streaming path */
    }
  }
  return {
    model: r.modelVersion ?? requestedModel,
    stopReason: cand?.finishReason ? mapFinishReason(cand.finishReason) : 'end_turn',
    content: acc.blocks(),
    usage: mapUsage(r.usageMetadata),
    usageAvailable: hasBillingUsage(r.usageMetadata),
    accountingUsage: billingUsage(r.usageMetadata),
  };
}

export async function* streamGemini(res: Response, requestedModel: string): AsyncIterable<StreamEvent> {
  const acc = new GeminiAccumulator();
  let modelVersion: string | undefined;
  let finish: string | undefined;
  let usage: GeminiUsage | undefined;
  for await (const evt of parseSseStream(res.body)) {
    let chunk: GeminiResponse;
    try {
      chunk = JSON.parse(evt.data) as GeminiResponse;
    } catch {
      continue;
    }
    modelVersion = chunk.modelVersion ?? modelVersion;
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    const cand = chunk.candidates?.[0];
    if (cand?.finishReason) finish = cand.finishReason;
    for (const part of cand?.content?.parts ?? []) {
      for (const ev of acc.push(part)) yield ev;
    }
  }
  yield {
    type: 'message_stop',
    response: {
      model: modelVersion ?? requestedModel,
      stopReason: finish ? mapFinishReason(finish) : 'end_turn',
      content: acc.blocks(),
      usage: mapUsage(usage),
      usageAvailable: hasBillingUsage(usage),
      accountingComplete: !!finish,
      accountingUsage: billingUsage(usage),
    },
  };
}

function mapFinishReason(g: string): CompletionResponse['stopReason'] {
  switch (g) {
    case 'STOP':
      return 'end_turn';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'stop_sequence';
    case 'OTHER':
    default:
      // Any tool-call finish ('TOOL_USE' isn't a real Gemini reason — the API
      // returns 'STOP' even when the model emitted a functionCall part — so
      // the agent loop infers tool_use from the response content, not from
      // stopReason. Map unknowns to 'end_turn' so the loop doesn't bail.
      return 'end_turn';
  }
}

function hasBillingUsage(u: GeminiUsage | undefined): boolean {
  return typeof u?.promptTokenCount === 'number' && typeof u?.candidatesTokenCount === 'number';
}

// Keep legacy budget/context counters unchanged. Billing excludes cached input
// from fresh input and includes Gemini's separately reported thinking tokens.
function billingUsage(u: GeminiUsage | undefined): CompletionResponse['usage'] {
  return {
    inputTokens: Math.max(0, (u?.promptTokenCount ?? 0) - (u?.cachedContentTokenCount ?? 0)),
    outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
    cacheReadTokens: u?.cachedContentTokenCount,
  };
}

function mapUsage(u: GeminiUsage | undefined): CompletionResponse['usage'] {
  if (!u) return { inputTokens: 0, outputTokens: 0 };
  // Gemini's promptTokenCount INCLUDES the cached subset (cachedContentTokenCount)
  // when a cachedContents resource is in use. We expose the full input total
  // here; pricing.ts handles the multiplier on cache reads.
  return {
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
    cacheReadTokens: u.cachedContentTokenCount ?? 0,
  };
}

// ── Gemini API shapes (subset we use) ──────────────────────────────────────

interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  tools?: GeminiToolBlock[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    thinkingConfig?: { includeThoughts?: boolean; thinkingBudget?: number; thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH' };
  };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

type GeminiPart =
  | { text: string; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args?: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiToolBlock {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

interface GeminiResponse {
  modelVersion?: string;
  candidates?: Array<{
    content?: {
      role?: string;
      parts?: Array<{
        text?: string;
        functionCall?: { name: string; args?: Record<string, unknown> };
        // Thinking-model parts: `thought: true` marks a reasoning summary;
        // `thoughtSignature` is the opaque continuity token (Gemini 2.5+).
        thought?: boolean;
        thoughtSignature?: string;
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsage;
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}
