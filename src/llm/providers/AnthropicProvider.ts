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
// Server-side context editing (clear stale tool results after cache lookup).
const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';

  constructor(private readonly auth: AuthMode) {}

  // Server-side context editing: clears old tool results once the prompt
  // crosses the trigger, AFTER prompt-cache lookup — so unlike autocode's
  // client-side masking it preserves the cached prefix. BYOK-direct only
  // for now: the Automax proxy hasn't been verified to forward the
  // anthropic-beta header, and sending context_management without it 400s.
  private contextManagementParam(req: CompletionRequest):
    | { edits: Array<Record<string, unknown>> }
    | null {
    if (!req.contextEditing || req.contextEditing.triggerInputTokens <= 0) return null;
    if (this.auth.kind !== 'byok') return null;
    return {
      edits: [
        {
          type: 'clear_tool_uses_20250919',
          trigger: { type: 'input_tokens', value: req.contextEditing.triggerInputTokens },
          keep: { type: 'tool_uses', value: 5 },
          clear_at_least: { type: 'input_tokens', value: 2_000 },
        },
      ],
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (this.auth.kind === 'missing') {
      throw new Error(
        `anthropic credentials missing — set ANTHROPIC_API_KEY or AUTOMAX_PROXY_TOKEN`,
      );
    }
    const base = isProxyAuth(this.auth) ? this.auth.baseOverride : DEFAULT_BASE;
    const url = `${base}/messages`;

    const thinking = thinkingParam(req);
    const contextManagement = this.contextManagementParam(req);
    const body = {
      model: req.model,
      // With thinking enabled max_tokens must EXCEED the thinking budget —
      // keep at least 8K of visible output beyond it.
      max_tokens: thinking
        ? Math.max(req.maxTokens ?? 8192, thinking.budget_tokens + 8192)
        : (req.maxTokens ?? 8192),
      // Anthropic requires temperature 1 when extended thinking is on.
      temperature: thinking ? 1.0 : (req.temperature ?? 1.0),
      ...(thinking ? { thinking } : {}),
      ...(contextManagement ? { context_management: contextManagement } : {}),
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
      // Rolling breakpoint on the last message: without it the growing
      // conversation is re-billed as fresh input every turn — the system
      // and tools breakpoints only cache the fixed prefix.
      messages: withRollingCacheBreakpoint(req.messages.map(toAnthropicMessage)),
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': API_VERSION,
      ...(contextManagement ? { 'anthropic-beta': CONTEXT_MANAGEMENT_BETA } : {}),
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

    const thinking = thinkingParam(req);
    const contextManagement = this.contextManagementParam(req);
    const body = {
      model: req.model,
      max_tokens: thinking
        ? Math.max(req.maxTokens ?? 8192, thinking.budget_tokens + 8192)
        : (req.maxTokens ?? 8192),
      temperature: thinking ? 1.0 : (req.temperature ?? 1.0),
      ...(thinking ? { thinking } : {}),
      ...(contextManagement ? { context_management: contextManagement } : {}),
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
      messages: withRollingCacheBreakpoint(req.messages.map(toAnthropicMessage)),
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': API_VERSION,
      'accept': 'text/event-stream',
      ...(contextManagement ? { 'anthropic-beta': CONTEXT_MANAGEMENT_BETA } : {}),
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
    let currentThinkingIdx: number | null = null;

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
          const block = parsed.content_block as { type: string; id?: string; name?: string; text?: string; data?: string } | undefined;
          if (block?.type === 'text') {
            content.push({ type: 'text', text: '' });
            currentTextIdx = content.length - 1;
          } else if (block?.type === 'tool_use') {
            currentToolId = block.id;
            currentToolName = block.name;
            currentToolJson = '';
            yield { type: 'tool_use_start', id: block.id ?? '', name: block.name ?? '' };
          } else if (block?.type === 'thinking') {
            // Extended-thinking trace — capture it (text + signature deltas)
            // so it can be echoed back verbatim on the next tool-use turn.
            content.push({ type: 'thinking', text: '' });
            currentThinkingIdx = content.length - 1;
          } else if (block?.type === 'redacted_thinking') {
            content.push({ type: 'thinking', text: '', redactedData: block.data ?? '' });
          }
          break;
        }
        case 'content_block_delta': {
          const delta = parsed.delta as { type: string; text?: string; partial_json?: string; thinking?: string; signature?: string } | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            if (currentTextIdx !== null) {
              const blk = content[currentTextIdx];
              if (blk && blk.type === 'text') blk.text += delta.text;
            }
            yield { type: 'text_delta', text: delta.text };
          } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            currentToolJson += delta.partial_json;
            yield { type: 'tool_use_delta', argsJsonChunk: delta.partial_json };
          } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            if (currentThinkingIdx !== null) {
              const blk = content[currentThinkingIdx];
              if (blk && blk.type === 'thinking') blk.text += delta.thinking;
            }
            yield { type: 'thinking_delta', text: delta.thinking };
          } else if (delta?.type === 'signature_delta' && typeof delta.signature === 'string') {
            if (currentThinkingIdx !== null) {
              const blk = content[currentThinkingIdx];
              if (blk && blk.type === 'thinking') blk.signature = (blk.signature ?? '') + delta.signature;
            }
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
          currentThinkingIdx = null;
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

// Attach a rolling cache breakpoint to the last cacheable block of the last
// message, so the whole conversation prefix caches turn-over-turn. Uses the
// third of Anthropic's four allowed breakpoints (system + last tool are the
// other two). Mutates the freshly-mapped wire objects, never the source
// Messages. Thinking blocks can't carry cache_control — skip past them.
export function withRollingCacheBreakpoint(
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (typeof m.content === 'string') {
      if (m.content.length === 0) continue;
      m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }];
      return messages;
    }
    if (Array.isArray(m.content)) {
      for (let j = m.content.length - 1; j >= 0; j--) {
        const b = m.content[j] as { type?: string; cache_control?: unknown };
        if (b && typeof b === 'object' && b.type !== 'thinking' && b.type !== 'redacted_thinking') {
          b.cache_control = { type: 'ephemeral' };
          return messages;
        }
      }
    }
  }
  return messages;
}

// Map the provider-neutral thinking request to Anthropic's param shape.
function thinkingParam(req: CompletionRequest): { type: 'enabled'; budget_tokens: number } | null {
  if (!req.thinking || req.thinking.budgetTokens <= 0) return null;
  // Anthropic's documented minimum budget is 1024.
  return { type: 'enabled', budget_tokens: Math.max(1024, req.thinking.budgetTokens) };
}

export function toAnthropicMessage(m: Message): { role: 'user' | 'assistant'; content: unknown } {
  if (m.role === 'system') {
    throw new Error('system messages should be passed via req.system, not in messages array');
  }
  if (typeof m.content === 'string') {
    return { role: m.role, content: m.content };
  }
  const blocks: unknown[] = [];
  for (const b of m.content) {
    switch (b.type) {
      case 'text':
        blocks.push({ type: 'text', text: b.text });
        break;
      case 'tool_use':
        blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        break;
      case 'tool_result':
        blocks.push({
          type: 'tool_result',
          tool_use_id: b.toolUseId,
          content: b.content,
          ...(b.isError ? { is_error: true } : {}),
        });
        break;
      case 'image':
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: b.mediaType, data: b.data },
        });
        break;
      case 'thinking':
        // Anthropic requires thinking blocks passed back byte-for-byte with
        // their signature during tool use — it validates them server-side.
        // Signature-less blocks (reasoning captured from another provider in
        // this session's history) would fail that validation, so drop them.
        if (b.redactedData !== undefined) {
          blocks.push({ type: 'redacted_thinking', data: b.redactedData });
        } else if (b.signature !== undefined) {
          blocks.push({ type: 'thinking', thinking: b.text, signature: b.signature });
        }
        break;
    }
  }
  return { role: m.role, content: blocks };
}

interface AnthropicResponse {
  id: string;
  model: string;
  stop_reason: string;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'thinking'; thinking: string; signature?: string }
    | { type: 'redacted_thinking'; data: string }
  >;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function fromAnthropicResponse(r: AnthropicResponse): CompletionResponse {
  const content: ContentBlock[] = r.content.map((b): ContentBlock => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'thinking') {
      return { type: 'thinking', text: b.thinking, ...(b.signature ? { signature: b.signature } : {}) };
    }
    if (b.type === 'redacted_thinking') {
      return { type: 'thinking', text: '', redactedData: b.data };
    }
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
