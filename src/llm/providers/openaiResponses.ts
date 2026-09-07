// OpenAI Responses API — request building, response parsing, streaming.
//
// Stateless use (`store: false`): the conversation is replayed as input items
// every call, and reasoning items come back with `encrypted_content` (asked
// for via `include`) so a reasoning model keeps its chain of thought across
// tool calls. Those items are captured into ThinkingBlock.opaque and replayed
// verbatim, the same role the ReasoningEcho plays for Chat Completions.
//
// Event mapping (stream):
//   response.output_item.added (function_call)      → tool_use_start
//   response.function_call_arguments.delta          → tool_use_delta
//   response.function_call_arguments.done           → tool_use_stop
//   response.output_text.delta                      → text_delta
//   response.reasoning_summary_text.delta           → thinking_delta
//   response.completed / response.incomplete        → message_stop
//   response.failed / error                         → throws

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
import { clampEffort, effortLevelOf, isOpenAiReasoningModel } from './openaiCompat.js';

// ── request shapes ──────────────────────────────────────────────────────────

export type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' }
  | { type: 'input_file'; filename: string; file_data: string };

export type ResponsesInputItem =
  | { role: 'user' | 'assistant'; content: ResponsesContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | ReasoningItem;

export interface ReasoningItem {
  type: 'reasoning';
  id?: string;
  summary: Array<{ type: 'summary_text'; text: string }>;
  encrypted_content?: string;
}

export interface ResponsesBody {
  model: string;
  instructions?: string;
  input: ResponsesInputItem[];
  tools?: Array<{ type: 'function'; name: string; description: string; parameters: unknown }>;
  tool_choice?: 'auto';
  max_output_tokens?: number;
  temperature?: number;
  reasoning?: { effort: 'low' | 'medium' | 'high'; summary?: 'auto' };
  include?: string[];
  store?: boolean;
  stream?: boolean;
}

// ── response shapes ─────────────────────────────────────────────────────────

export type ResponsesOutputItem =
  | ReasoningItem
  | {
      type: 'message';
      id?: string;
      role: 'assistant';
      content: Array<{ type: 'output_text'; text: string } | { type: 'refusal'; refusal: string }>;
    }
  | { type: 'function_call'; id?: string; call_id: string; name: string; arguments: string };

export interface ResponsesResult {
  id?: string;
  model: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output: ResponsesOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

/** True for the model families that take `reasoning` on the Responses API. */
export function isReasoningFamily(model: string): boolean {
  return isOpenAiReasoningModel(model) || /^(openai\/)?gpt-5/.test(model);
}

export function buildResponsesBody(req: CompletionRequest): ResponsesBody {
  const instructions = req.systemVolatile ? `${req.system}\n${req.systemVolatile}` : req.system;
  const input: ResponsesInputItem[] = [];
  for (const m of req.messages) input.push(...toResponsesItems(m));

  const body: ResponsesBody = {
    model: req.model,
    ...(instructions ? { instructions } : {}),
    input,
    max_output_tokens: req.maxTokens ?? 8192,
    store: false,
  };
  const level = effortLevelOf(req.thinking);
  const reasoning = level !== null && isReasoningFamily(req.model);
  if (reasoning) {
    body.reasoning = { effort: clampEffort(level), ...(req.thinking?.summary ? { summary: 'auto' } : {}) };
    body.include = ['reasoning.encrypted_content'];
  } else if (!isReasoningFamily(req.model)) {
    // Reasoning models accept only the default temperature.
    body.temperature = req.temperature ?? 1.0;
  }
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
    body.tool_choice = 'auto';
  }
  return body;
}

/** One autocode Message → the Responses input items it stands for, in generation order. */
export function toResponsesItems(m: Message): ResponsesInputItem[] {
  if (m.role === 'system') return []; // carried in `instructions`
  if (typeof m.content === 'string') {
    return m.role === 'assistant'
      ? [{ role: 'assistant', content: [{ type: 'output_text', text: m.content }] }]
      : [{ role: 'user', content: [{ type: 'input_text', text: m.content }] }];
  }
  if (m.role === 'assistant') {
    const out: ResponsesInputItem[] = [];
    const texts: string[] = [];
    const calls: ToolUseBlock[] = [];
    for (const b of m.content) {
      if (b.type === 'thinking') {
        const item = reasoningItemOf(b);
        if (item) out.push(item);
      } else if (b.type === 'text') texts.push(b.text);
      else if (b.type === 'tool_use') calls.push(b);
    }
    const text = texts.join('\n');
    if (text.length > 0) out.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
    for (const c of calls) {
      out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.input ?? {}) });
    }
    return out;
  }
  // user: tool results first (they answer the preceding function calls), then any text/images.
  const out: ResponsesInputItem[] = [];
  const parts: ResponsesContentPart[] = [];
  for (const b of m.content) {
    if (b.type === 'tool_result') out.push({ type: 'function_call_output', call_id: b.toolUseId, output: b.content });
    else if (b.type === 'text') parts.push({ type: 'input_text', text: b.text });
    else if (b.type === 'image') parts.push({ type: 'input_image', image_url: `data:${b.mediaType};base64,${b.data}` });
    else if (b.type === 'document') {
      parts.push({ type: 'input_file', filename: b.name ?? 'document.pdf', file_data: `data:${b.mediaType};base64,${b.data}` });
    }
  }
  if (parts.length > 0) out.push({ role: 'user', content: parts });
  return out;
}

/** The reasoning item captured on the way in, replayed verbatim; text-only traces are not replayable. */
function reasoningItemOf(b: ThinkingBlock): ReasoningItem | null {
  const o = b.opaque;
  if (o && typeof o === 'object' && (o as { type?: unknown }).type === 'reasoning') return o as ReasoningItem;
  return null;
}

export function parseResponsesOutput(json: ResponsesResult): CompletionResponse {
  const content: ContentBlock[] = [];
  let sawCall = false;
  for (const item of json.output ?? []) {
    if (item.type === 'reasoning') {
      const text = (item.summary ?? []).map((s) => s.text).join('\n');
      content.push({ type: 'thinking', text, opaque: item });
    } else if (item.type === 'message') {
      const text = item.content
        .map((c) => (c.type === 'output_text' ? c.text : c.type === 'refusal' ? c.refusal : ''))
        .join('');
      if (text.length > 0) content.push({ type: 'text', text });
    } else if (item.type === 'function_call') {
      sawCall = true;
      let input: Record<string, unknown> = {};
      try {
        input = item.arguments ? (JSON.parse(item.arguments) as Record<string, unknown>) : {};
      } catch {
        input = { _raw: item.arguments };
      }
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input });
    }
  }
  const incomplete = json.status === 'incomplete';
  const stopReason: CompletionResponse['stopReason'] = sawCall
    ? 'tool_use'
    : incomplete && json.incomplete_details?.reason === 'max_output_tokens'
      ? 'max_tokens'
      : json.status === 'failed'
        ? 'error'
        : 'end_turn';
  return {
    model: json.model,
    stopReason,
    content,
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      cacheReadTokens: json.usage?.input_tokens_details?.cached_tokens,
    },
  };
}

interface StreamEnvelope {
  type?: string;
  item?: ResponsesOutputItem;
  delta?: string;
  response?: ResponsesResult;
  error?: { message?: string };
  message?: string;
}

export async function* streamResponses(res: Response, model: string): AsyncIterable<StreamEvent> {
  let finished = false;
  for await (const evt of parseSseStream(res.body)) {
    if (evt.data === '[DONE]') break;
    let data: StreamEnvelope;
    try {
      data = JSON.parse(evt.data) as StreamEnvelope;
    } catch {
      continue;
    }
    const type = data.type ?? evt.event ?? '';
    switch (type) {
      case 'response.output_item.added':
        if (data.item?.type === 'function_call') {
          yield { type: 'tool_use_start', id: data.item.call_id, name: data.item.name };
        }
        break;
      case 'response.function_call_arguments.delta':
        if (typeof data.delta === 'string') yield { type: 'tool_use_delta', argsJsonChunk: data.delta };
        break;
      case 'response.function_call_arguments.done':
        yield { type: 'tool_use_stop' };
        break;
      case 'response.output_text.delta':
        if (typeof data.delta === 'string') yield { type: 'text_delta', text: data.delta };
        break;
      case 'response.reasoning_summary_text.delta':
        if (typeof data.delta === 'string') yield { type: 'thinking_delta', text: data.delta };
        break;
      case 'response.completed':
      case 'response.incomplete': {
        const response = data.response ?? { model, output: [] };
        finished = true;
        yield { type: 'message_stop', response: parseResponsesOutput({ ...response, model: response.model || model }) };
        break;
      }
      case 'response.failed':
      case 'error': {
        const msg = data.error?.message ?? data.message ?? data.response?.incomplete_details?.reason ?? 'response failed';
        throw new Error(`openai responses: ${msg}`);
      }
      default:
        break;
    }
  }
  if (!finished) {
    yield {
      type: 'message_stop',
      response: { model, stopReason: 'error', content: [], usage: { inputTokens: 0, outputTokens: 0 } },
    };
  }
}
