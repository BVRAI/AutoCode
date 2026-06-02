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
    // Pragmatic shortcut: Gemini's :streamGenerateContent?alt=sse exists, but
    // it adds a layer of format risk (proxy passthrough, SSE-vs-JSON-array
    // negotiation, partial-chunk handling) that's not worth the marginal UX
    // win of streaming text deltas in the TUI for now. Automax's own Gemini
    // path uses non-streaming via /v1/google/.../generateContent and works
    // reliably — so we do the same here: call complete(), then emit synthetic
    // stream events (text_delta + tool_use_*) followed by message_stop so the
    // AgentLoop's stream-consumer code works unchanged.
    //
    // If true streaming becomes worth chasing, swap this for an SSE-parsing
    // path against `:streamGenerateContent?alt=sse`. The risk surface is
    // entirely in the SSE chunk format, not in the request body.
    const resp = await this.complete(req);
    for (const block of resp.content) {
      if (block.type === 'text' && block.text.length > 0) {
        yield { type: 'text_delta', text: block.text };
      } else if (block.type === 'tool_use') {
        yield { type: 'tool_use_start', id: block.id, name: block.name };
        yield { type: 'tool_use_delta', argsJsonChunk: JSON.stringify(block.input ?? {}) };
        yield { type: 'tool_use_stop' };
      }
    }
    yield { type: 'message_stop', response: resp };
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
      },
    };

    return { url, headers, body };
  }
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
    for (const b of m.content) {
      switch (b.type) {
        case 'text':
          if (b.text.length > 0) parts.push({ text: b.text });
          break;
        case 'tool_use':
          parts.push({ functionCall: { name: b.name, args: b.input } });
          break;
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
          parts.push({ inlineData: { mimeType: b.mediaType, data: b.data } });
          break;
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

function fromGeminiResponse(r: GeminiResponse, requestedModel: string): CompletionResponse {
  const cand = r.candidates?.[0];
  const content: ContentBlock[] = [];
  let toolCallSeq = 0;
  if (cand?.content?.parts) {
    for (const part of cand.content.parts) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        content.push({ type: 'text', text: part.text });
      } else if (part.functionCall) {
        const id = `gem-${++toolCallSeq}`;
        content.push({
          type: 'tool_use',
          id,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        });
      }
    }
  }
  return {
    model: r.modelVersion ?? requestedModel,
    stopReason: cand?.finishReason ? mapFinishReason(cand.finishReason) : 'end_turn',
    content,
    usage: mapUsage(r.usageMetadata),
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
  };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
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
}
