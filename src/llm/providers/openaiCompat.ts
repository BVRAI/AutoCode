// Translator between autocode's provider-neutral CompletionRequest/Response and the
// OpenAI chat-completions wire shape. Used by xAI, OpenAI, and OpenRouter — they all
// share this format; only base URL and auth header differ.

import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  StreamEvent,
  ThinkingBlock,
  ToolUseBlock,
} from '../types.js';
import { parseSseStream } from '../sse.js';

// How to echo a prior turn's reasoning back to the provider. Dialects differ:
//  - 'reasoning_content'  — xAI-style plain text field on the assistant message.
//  - 'reasoning_details'  — OpenRouter's opaque array, which their docs require
//                           to be passed back UNMODIFIED for reasoning continuity
//                           across tool calls (plain `reasoning` string fallback).
//  - 'none'               — omit entirely. The safe default: DeepSeek-style APIs
//                           return 400 if reasoning_content appears in the input.
import type { EffortLevel } from '../types.js';

export type ReasoningEcho = 'none' | 'reasoning_content' | 'reasoning_details';

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | OpenAiContentPart[];
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
  // Reasoning echo fields — set on outbound assistant messages according to
  // the provider's ReasoningEcho mode (see above). Never set in 'none' mode.
  reasoning_content?: string;
  reasoning?: string;
  reasoning_details?: unknown[];
}

export interface OpenAiChatBody {
  model: string;
  messages: OpenAiMessage[];
  tools?: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: unknown };
  }>;
  tool_choice?: 'auto' | 'none' | 'required';
  // Output-length cap. Standard chat models accept `max_tokens`; OpenAI's
  // reasoning-family models (o1/o3/o4 series) reject it and require
  // `max_completion_tokens` — only one of these fields is set per request.
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  // Reasoning depth for models that accept it (OpenAI o-series and gpt-5
  // family; xAI accepts low|high).
  reasoning_effort?: 'low' | 'medium' | 'high';
  // OpenRouter's unified reasoning param, normalized per upstream.
  reasoning?: { effort: 'low' | 'medium' | 'high' };
}

/** Which dialect of the reasoning knob a provider speaks. */
export type EffortStyle = 'openai' | 'xai' | 'openrouter';

export interface OpenAiChatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    finish_reason: string | null;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAiToolCall[];
      // Reasoning trace, when the provider surfaces one: xAI/DeepSeek-style
      // `reasoning_content`, OpenRouter's `reasoning` + `reasoning_details`.
      reasoning_content?: string | null;
      reasoning?: string | null;
      reasoning_details?: unknown[];
    };
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export function buildBody(
  req: CompletionRequest,
  opts?: { reasoningEcho?: ReasoningEcho; effortStyle?: EffortStyle },
): OpenAiChatBody {
  const reasoningEcho = opts?.reasoningEcho ?? 'none';
  const effortStyle = opts?.effortStyle ?? 'openai';
  // No cache-breakpoint support here — fold any volatile suffix onto the end
  // of the system message. OpenAI's automatic prefix caching still benefits
  // from the stable content coming first.
  const systemText = req.systemVolatile ? `${req.system}\n${req.systemVolatile}` : req.system;
  const messages: OpenAiMessage[] = [{ role: 'system', content: systemText }];
  for (const m of req.messages) {
    messages.push(...toOpenAiMessages(m, reasoningEcho));
  }
  const body: OpenAiChatBody = {
    model: req.model,
    messages,
  };
  // OpenAI reasoning models (o1/o3/o4 series) require `max_completion_tokens`
  // instead of `max_tokens`, and reject any `temperature` other than the
  // default 1.0. Detect by model-id prefix and adjust accordingly. The
  // OpenRouter route-prefix variant (`openai/o4-mini`) is matched too.
  // Every other naming convention used by xAI / Anthropic / Google / non-o
  // OpenRouter routes is safe — see isOpenAiReasoningModel below.
  if (isOpenAiReasoningModel(req.model)) {
    body.max_completion_tokens = req.maxTokens ?? 8192;
    // Omit temperature entirely — reasoning models accept only the default.
  } else {
    body.max_tokens = req.maxTokens ?? 8192;
    body.temperature = req.temperature ?? 1.0;
  }
  // Arm reasoning when requested. thinkingFor() only sets req.thinking for
  // models the catalog marks supportsThinking; the OpenAI dialect keeps a
  // name check too, because a BYOK list can flag models loosely.
  const level = effortLevelOf(req.thinking);
  if (level) {
    if (effortStyle === 'openrouter') {
      body.reasoning = { effort: clampEffort(level) };
    } else if (effortStyle === 'xai') {
      body.reasoning_effort = level === 'low' ? 'low' : 'high';
    } else if (isOpenAiReasoningModel(req.model) || /^(openai\/)?gpt-5/.test(req.model)) {
      body.reasoning_effort = clampEffort(level);
    }
  }
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
    body.tool_choice = 'auto';
  }
  return body;
}

/** The requested level, or null when thinking is off. A legacy budget request reads as medium. */
export function effortLevelOf(t: CompletionRequest['thinking']): EffortLevel | null {
  if (!t) return null;
  if (t.mode === 'effort') return t.effort ?? 'medium';
  return 'medium';
}

/** OpenAI-style APIs know low|medium|high; `max` is clamped to high. */
export function clampEffort(level: EffortLevel): 'low' | 'medium' | 'high' {
  return level === 'max' ? 'high' : level;
}

// True for OpenAI's reasoning-family models (o1, o1-mini, o1-preview, o3,
// o3-mini, o3-pro, o4, o4-mini, future o5-* …). Pattern is unambiguous in
// practice — no other provider's naming convention starts with `o<digit>`:
// xAI is `grok-*`, Anthropic is `claude-*`, Google is `gemini-*`,
// OpenRouter prefixes everything else (`anthropic/...`, `meta-llama/...`).
export function isOpenAiReasoningModel(model: string): boolean {
  return /^(openai\/)?o\d/.test(model);
}

// One autocode Message can expand into multiple OpenAI messages:
//   - An assistant message with text + tool_use blocks stays as ONE assistant message
//     with the text in `content` and the tool_uses in `tool_calls`.
//   - A user message containing tool_result blocks becomes one OR MORE `role:"tool"`
//     messages (one per tool_result), each with `tool_call_id`.
function toOpenAiMessages(m: Message, reasoningEcho: ReasoningEcho = 'none'): OpenAiMessage[] {
  if (typeof m.content === 'string') {
    return [{ role: m.role === 'system' ? 'system' : m.role, content: m.content }];
  }
  if (m.role === 'assistant') {
    const textParts = m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text');
    const toolUses = m.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    const thinking = m.content.filter((b): b is ThinkingBlock => b.type === 'thinking');
    const out: OpenAiMessage = {
      role: 'assistant',
      content: textParts.map((t) => t.text).join('\n') || null,
    };
    if (toolUses.length > 0) {
      out.tool_calls = toolUses.map((tu) => ({
        id: tu.id,
        type: 'function',
        function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
      }));
    }
    if (thinking.length > 0 && reasoningEcho !== 'none') {
      if (reasoningEcho === 'reasoning_content') {
        const text = thinking.map((t) => t.text).filter((t) => t.length > 0).join('\n');
        if (text.length > 0) out.reasoning_content = text;
      } else {
        // 'reasoning_details': replay the provider-native opaque arrays
        // verbatim and in order — OpenRouter requires the sequence unmodified.
        // Plaintext `reasoning` is the fallback when no opaque payload exists.
        const details = thinking.flatMap((t) => (Array.isArray(t.opaque) ? t.opaque : []));
        if (details.length > 0) {
          out.reasoning_details = details;
        } else {
          const text = thinking.map((t) => t.text).filter((t) => t.length > 0).join('\n');
          if (text.length > 0) out.reasoning = text;
        }
      }
    }
    return [out];
  }
  // role === 'user': may contain text, image, and/or tool_result blocks
  const results: OpenAiMessage[] = [];
  const textParts: string[] = [];
  const imageParts: OpenAiContentPart[] = [];
  for (const b of m.content) {
    if (b.type === 'text') textParts.push(b.text);
    else if (b.type === 'image') {
      imageParts.push({ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
    } else if (b.type === 'tool_result') {
      results.push({
        role: 'tool',
        content: b.content,
        tool_call_id: b.toolUseId,
      });
    }
  }
  if (imageParts.length > 0) {
    // OpenAI multimodal: content becomes an array of text + image parts.
    const parts: OpenAiContentPart[] = [];
    if (textParts.length > 0) parts.push({ type: 'text', text: textParts.join('\n') });
    parts.push(...imageParts);
    results.unshift({ role: 'user', content: parts });
  } else if (textParts.length > 0) {
    results.unshift({ role: 'user', content: textParts.join('\n') });
  }
  return results;
}

export function parseResponse(json: OpenAiChatResponse): CompletionResponse {
  const choice = json.choices[0];
  if (!choice) {
    throw new Error('openai-compat response has no choices');
  }
  const content: ContentBlock[] = [];
  // Reasoning trace first — it precedes the visible answer in generation
  // order, and echo-out reads blocks in order.
  const reasoningText = choice.message.reasoning_content ?? choice.message.reasoning ?? '';
  const reasoningDetails = choice.message.reasoning_details;
  if (reasoningText.length > 0 || (reasoningDetails && reasoningDetails.length > 0)) {
    content.push({
      type: 'thinking',
      text: reasoningText,
      ...(reasoningDetails && reasoningDetails.length > 0 ? { opaque: reasoningDetails } : {}),
    });
  }
  if (choice.message.content && choice.message.content.length > 0) {
    content.push({ type: 'text', text: choice.message.content });
  }
  for (const tc of choice.message.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
    } catch {
      input = { _raw: tc.function.arguments };
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  return {
    model: json.model,
    stopReason: normalizeStopReason(choice.finish_reason),
    content,
    usage: {
      inputTokens: json.usage.prompt_tokens,
      outputTokens: json.usage.completion_tokens,
      cacheReadTokens: json.usage.prompt_tokens_details?.cached_tokens,
    },
  };
}

function normalizeStopReason(raw: string | null): CompletionResponse['stopReason'] {
  switch (raw) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
      return 'end_turn';
    case 'content_filter':
      return 'error';
    default:
      return 'end_turn';
  }
}

// Stream OpenAI-compatible chat-completions SSE. Each chunk's delta may contain
// either text content or partial tool_call entries (function name + arguments
// arrive incrementally; arguments is a JSON string built up across chunks).
export async function* streamOpenAiCompat(
  res: Response,
  model: string,
): AsyncIterable<StreamEvent> {
  // Accumulators for the final message_stop event.
  const finalContent: ContentBlock[] = [];
  let textBuf = '';
  let reasoningBuf = '';
  let stopReason: CompletionResponse['stopReason'] = 'end_turn';
  const usage: CompletionResponse['usage'] = { inputTokens: 0, outputTokens: 0 };

  // Track in-flight tool calls by index (OpenAI numbers them).
  type Pending = { id: string; name: string; args: string; emittedStart: boolean };
  const pending = new Map<number, Pending>();

  // OpenRouter streams reasoning_details entries incrementally, keyed by
  // `index`. Reconstruct by concatenating the text-ish fields per index and
  // letting the last non-empty value win for identity fields — the shape must
  // round-trip verbatim for the echo requirement, so keep every field we see.
  const detailsByIndex = new Map<number, Record<string, unknown>>();
  const mergeReasoningDetails = (entries: Array<Record<string, unknown>>): void => {
    for (const e of entries) {
      const idx = typeof e.index === 'number' ? e.index : 0;
      const acc = detailsByIndex.get(idx) ?? {};
      for (const [k, v] of Object.entries(e)) {
        if (v === undefined || v === null) continue;
        if ((k === 'text' || k === 'summary' || k === 'data') && typeof v === 'string') {
          acc[k] = `${typeof acc[k] === 'string' ? acc[k] : ''}${v}`;
        } else {
          acc[k] = v;
        }
      }
      detailsByIndex.set(idx, acc);
    }
  };

  for await (const evt of parseSseStream(res.body)) {
    if (evt.data === '[DONE]') break;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(evt.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const choices = parsed.choices as Array<{
      index?: number;
      finish_reason?: string | null;
      delta?: {
        content?: string | null;
        reasoning_content?: string | null;
        reasoning?: string | null;
        reasoning_details?: Array<Record<string, unknown>>;
        tool_calls?: Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }> | undefined;
    if (choices && choices.length > 0) {
      const choice = choices[0]!;
      const delta = choice.delta;
      const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoningDelta && reasoningDelta.length > 0) {
        reasoningBuf += reasoningDelta;
        yield { type: 'thinking_delta', text: reasoningDelta };
      }
      if (delta?.reasoning_details && delta.reasoning_details.length > 0) {
        mergeReasoningDetails(delta.reasoning_details);
      }
      if (delta?.content && delta.content.length > 0) {
        textBuf += delta.content;
        yield { type: 'text_delta', text: delta.content };
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          let p = pending.get(idx);
          if (!p) {
            p = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? '', args: '', emittedStart: false };
            pending.set(idx, p);
          }
          if (!p.emittedStart && p.name.length > 0) {
            yield { type: 'tool_use_start', id: p.id, name: p.name };
            p.emittedStart = true;
          } else if (tc.function?.name && p.name.length === 0) {
            p.name = tc.function.name;
            yield { type: 'tool_use_start', id: p.id, name: p.name };
            p.emittedStart = true;
          }
          if (tc.function?.arguments) {
            p.args += tc.function.arguments;
            yield { type: 'tool_use_delta', argsJsonChunk: tc.function.arguments };
          }
        }
      }
      if (choice.finish_reason) {
        stopReason = normalizeStopReason(choice.finish_reason);
      }
    }
    const u = parsed.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
    if (u) {
      if (u.prompt_tokens !== undefined) usage.inputTokens = u.prompt_tokens;
      if (u.completion_tokens !== undefined) usage.outputTokens = u.completion_tokens;
      if (u.prompt_tokens_details?.cached_tokens !== undefined) {
        usage.cacheReadTokens = u.prompt_tokens_details.cached_tokens;
      }
    }
  }

  // Finalize: thinking first (generation order), then text, then tool_uses.
  if (reasoningBuf.length > 0 || detailsByIndex.size > 0) {
    const details = [...detailsByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v);
    finalContent.push({
      type: 'thinking',
      text: reasoningBuf,
      ...(details.length > 0 ? { opaque: details } : {}),
    });
  }
  if (textBuf.length > 0) finalContent.push({ type: 'text', text: textBuf });
  for (const [, p] of pending) {
    let input: Record<string, unknown> = {};
    try {
      input = p.args.length > 0 ? (JSON.parse(p.args) as Record<string, unknown>) : {};
    } catch {
      input = { _raw: p.args };
    }
    finalContent.push({ type: 'tool_use', id: p.id, name: p.name, input });
    yield { type: 'tool_use_stop' };
  }

  yield {
    type: 'message_stop',
    response: { model, stopReason, content: finalContent, usage },
  };
}
