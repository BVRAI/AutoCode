// Translator between autocode's provider-neutral CompletionRequest/Response and the
// OpenAI chat-completions wire shape. Used by xAI, OpenAI, and OpenRouter — they all
// share this format; only base URL and auth header differ.

import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  ToolUseBlock,
} from '../types.js';

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
