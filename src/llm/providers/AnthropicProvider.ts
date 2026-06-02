import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  LlmProvider,
  Message,
  StreamEvent,
} from '../types.js';
import { isProxyAuth, type AuthMode } from '../../auth/AuthResolver.js';
import { parseSseStream } from '../sse.js';

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
    const base = isProxyAuth(this.auth) ? this.auth.baseOverride : DEFAULT_BASE;
    const url = `${base}/messages`;

    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 8192,
      temperature: req.temperature ?? 1.0,
      // The cache breakpoint sits on the stable `system` block. Any volatile
      // suffix (live git working-state) goes in a SECOND block after it, so it
      // refreshes every turn without invalidating the cached prefix.
      system: [
        {
          type: 'text',
          text: req.system,
          cache_control: { type: 'ephemeral' },
        },
        ...(req.systemVolatile ? [{ type: 'text', text: req.systemVolatile }] : []),
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
    } else if (isProxyAuth(this.auth)) {
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

  async *completeStream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    if (this.auth.kind === 'missing') {
      throw new Error('anthropic credentials missing — set ANTHROPIC_API_KEY or AUTOMAX_PROXY_TOKEN');
    }
    const base = isProxyAuth(this.auth) ? this.auth.baseOverride : DEFAULT_BASE;
    const url = `${base}/messages`;

    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 8192,
      temperature: req.temperature ?? 1.0,
      stream: true,
      system: [
        { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } },
        ...(req.systemVolatile ? [{ type: 'text', text: req.systemVolatile }] : []),
      ],
      tools: req.tools.map((t, idx) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        ...(idx === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
      })),
      messages: req.messages.map(toAnthropicMessage),
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': API_VERSION,
      'accept': 'text/event-stream',
    };
    if (this.auth.kind === 'byok') headers['x-api-key'] = this.auth.apiKey;
    else if (isProxyAuth(this.auth)) headers['authorization'] = `Bearer ${this.auth.token}`;

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

    // Accumulate full response as we go, for the final message_stop event.
    const content: ContentBlock[] = [];
    let stopReason: CompletionResponse['stopReason'] = 'end_turn';
    const usage: CompletionResponse['usage'] = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let currentToolJson = '';
    let currentToolId: string | undefined;
    let currentToolName: string | undefined;
    let currentTextIdx: number | null = null;

    for await (const evt of parseSseStream(res.body)) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(evt.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      switch (evt.event) {
        case 'message_start': {
          const m = parsed.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined;
          if (m?.usage) {
            usage.inputTokens = m.usage.input_tokens ?? 0;
            usage.cacheReadTokens = m.usage.cache_read_input_tokens ?? 0;
            usage.cacheWriteTokens = m.usage.cache_creation_input_tokens ?? 0;
          }
          break;
        }
        case 'content_block_start': {
          const block = parsed.content_block as { type: string; id?: string; name?: string; text?: string } | undefined;
          if (block?.type === 'text') {
            content.push({ type: 'text', text: '' });
            currentTextIdx = content.length - 1;
          } else if (block?.type === 'tool_use') {
            currentToolId = block.id;
            currentToolName = block.name;
            currentToolJson = '';
            yield { type: 'tool_use_start', id: block.id ?? '', name: block.name ?? '' };
          }
          break;
        }
        case 'content_block_delta': {
          const delta = parsed.delta as { type: string; text?: string; partial_json?: string } | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            if (currentTextIdx !== null) {
              const blk = content[currentTextIdx];
              if (blk && blk.type === 'text') blk.text += delta.text;
            }
            yield { type: 'text_delta', text: delta.text };
          } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            currentToolJson += delta.partial_json;
            yield { type: 'tool_use_delta', argsJsonChunk: delta.partial_json };
          }
          break;
        }
        case 'content_block_stop': {
          if (currentToolId !== undefined && currentToolName !== undefined) {
            let input: Record<string, unknown> = {};
            try {
              input = currentToolJson.length > 0 ? (JSON.parse(currentToolJson) as Record<string, unknown>) : {};
            } catch {
              input = { _raw: currentToolJson };
            }
            content.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input });
            yield { type: 'tool_use_stop' };
            currentToolId = undefined;
            currentToolName = undefined;
            currentToolJson = '';
          }
          currentTextIdx = null;
          break;
        }
        case 'message_delta': {
          const delta = parsed.delta as { stop_reason?: string } | undefined;
          const u = parsed.usage as { output_tokens?: number } | undefined;
          if (u?.output_tokens !== undefined) usage.outputTokens = u.output_tokens;
          if (delta?.stop_reason) stopReason = normalizeStopReason(delta.stop_reason);
          break;
        }
        case 'message_stop':
          // Final event; we'll emit our own below.
          break;
        default:
          break;
      }
    }

    yield {
      type: 'message_stop',
      response: { model: req.model, stopReason, content, usage },
    };
  }
}

export function toAnthropicMessage(m: Message): { role: 'user' | 'assistant'; content: unknown } {
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
      case 'image':
        return {
          type: 'image',
          source: { type: 'base64', media_type: b.mediaType, data: b.data },
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
