// Translator between autocode's provider-neutral CompletionRequest/Response and the
// OpenAI chat-completions wire shape. Used by xAI, OpenAI, and OpenRouter — they all
// share this format; only base URL and auth header differ.

import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  StreamEvent,
  ToolUseBlock,
} from '../types.js';
import { parseSseStream } from '../sse.js';

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAiChatBody {
  model: string;
  messages: OpenAiMessage[];
  tools?: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: unknown };
  }>;
  tool_choice?: 'auto' | 'none' | 'required';
  max_tokens?: number;
  temperature?: number;
}

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
    };
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export function buildBody(req: CompletionRequest): OpenAiChatBody {
  const messages: OpenAiMessage[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    messages.push(...toOpenAiMessages(m));
  }
  const body: OpenAiChatBody = {
    model: req.model,
    messages,
    max_tokens: req.maxTokens ?? 8192,
    temperature: req.temperature ?? 1.0,
  };
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

// One autocode Message can expand into multiple OpenAI messages:
//   - An assistant message with text + tool_use blocks stays as ONE assistant message
//     with the text in `content` and the tool_uses in `tool_calls`.
//   - A user message containing tool_result blocks becomes one OR MORE `role:"tool"`
//     messages (one per tool_result), each with `tool_call_id`.
function toOpenAiMessages(m: Message): OpenAiMessage[] {
  if (typeof m.content === 'string') {
    return [{ role: m.role === 'system' ? 'system' : m.role, content: m.content }];
  }
  if (m.role === 'assistant') {
    const textParts = m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text');
    const toolUses = m.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
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
    return [out];
  }
  // role === 'user': may contain text blocks and/or tool_result blocks
  const results: OpenAiMessage[] = [];
  const textParts: string[] = [];
  for (const b of m.content) {
    if (b.type === 'text') textParts.push(b.text);
    else if (b.type === 'tool_result') {
      results.push({
        role: 'tool',
        content: b.content,
        tool_call_id: b.toolUseId,
      });
    }
  }
  if (textParts.length > 0) {
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
  let stopReason: CompletionResponse['stopReason'] = 'end_turn';
  const usage: CompletionResponse['usage'] = { inputTokens: 0, outputTokens: 0 };

  // Track in-flight tool calls by index (OpenAI numbers them).
  type Pending = { id: string; name: string; args: string; emittedStart: boolean };
  const pending = new Map<number, Pending>();

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

  // Finalize tool_uses into content blocks.
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
