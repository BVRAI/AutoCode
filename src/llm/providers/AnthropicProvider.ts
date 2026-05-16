import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  LlmProvider,
  Message,
} from '../types.js';
import type { AuthMode } from '../../auth/AuthResolver.js';

const DEFAULT_BASE = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';

  constructor(private readonly auth: AuthMode) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (this.auth.kind === 'missing') {
      throw new Error(
        `anthropic credentials missing — set ANTHROPIC_API_KEY or AUTOMAX_PROXY_TOKEN`,
      );
    }
    const base = this.auth.kind === 'automax' ? this.auth.baseOverride : DEFAULT_BASE;
    const url = `${base}/messages`;

    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 8192,
      temperature: req.temperature ?? 1.0,
      system: [
        {
          type: 'text',
          text: req.system,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: req.tools.map((t, idx) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        // Cache the last tool definition; Anthropic caches everything up to and including it.
        ...(idx === req.tools.length - 1
          ? { cache_control: { type: 'ephemeral' } }
          : {}),
      })),
      messages: req.messages.map(toAnthropicMessage),
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': API_VERSION,
    };
    if (this.auth.kind === 'byok') {
      headers['x-api-key'] = this.auth.apiKey;
    } else if (this.auth.kind === 'automax') {
      headers['authorization'] = `Bearer ${this.auth.token}`;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`anthropic ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as AnthropicResponse;
    return fromAnthropicResponse(json);
  }
}

function toAnthropicMessage(m: Message): { role: 'user' | 'assistant'; content: unknown } {
  if (m.role === 'system') {
    throw new Error('system messages should be passed via req.system, not in messages array');
  }
  if (typeof m.content === 'string') {
    return { role: m.role, content: m.content };
  }
  const blocks = m.content.map((b) => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text };
      case 'tool_use':
        return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: b.toolUseId,
          content: b.content,
          ...(b.isError ? { is_error: true } : {}),
        };
    }
  });
  return { role: m.role, content: blocks };
}

interface AnthropicResponse {
  id: string;
  model: string;
  stop_reason: string;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function fromAnthropicResponse(r: AnthropicResponse): CompletionResponse {
  const content: ContentBlock[] = r.content.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
  });
  const stopReason = normalizeStopReason(r.stop_reason);
  return {
    model: r.model,
    stopReason,
    content,
    usage: {
      inputTokens: r.usage.input_tokens,
      outputTokens: r.usage.output_tokens,
      cacheReadTokens: r.usage.cache_read_input_tokens,
      cacheWriteTokens: r.usage.cache_creation_input_tokens,
    },
  };
}

function normalizeStopReason(raw: string): CompletionResponse['stopReason'] {
  switch (raw) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
      return raw;
    default:
      return 'end_turn';
  }
}
