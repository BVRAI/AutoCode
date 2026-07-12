import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AnthropicProvider,
  toAnthropicMessage,
  withRollingCacheBreakpoint,
} from '../../src/llm/providers/AnthropicProvider.js';
import type { CompletionRequest, Message } from '../../src/llm/types.js';

const EPHEMERAL = { type: 'ephemeral' };

describe('withRollingCacheBreakpoint', () => {
  it('marks the last block of the last message', () => {
    const messages: Message[] = [
      { role: 'user', content: 'first' },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 't1', content: 'out1' },
          { type: 'tool_result', toolUseId: 't2', content: 'out2' },
        ],
      },
    ];
    const wire = withRollingCacheBreakpoint(messages.map(toAnthropicMessage));
    const last = wire[1]!.content as Array<Record<string, unknown>>;
    expect(last[0]!.cache_control).toBeUndefined();
    expect(last[1]!.cache_control).toEqual(EPHEMERAL);
    // Earlier messages untouched.
    expect(wire[0]!.content).toBe('first');
  });

  it('converts a string-content last message into a marked text block', () => {
    const wire = withRollingCacheBreakpoint(
      [{ role: 'user', content: 'hello' } as Message].map(toAnthropicMessage),
    );
    expect(wire[0]!.content).toEqual([
      { type: 'text', text: 'hello', cache_control: EPHEMERAL },
    ]);
  });

  it('never marks thinking blocks — falls back to the previous cacheable block', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'thinking', text: 'trace', signature: 'sig' },
        ],
      },
    ];
    const wire = withRollingCacheBreakpoint(messages.map(toAnthropicMessage));
    const blocks = wire[0]!.content as Array<Record<string, unknown>>;
    // Wire order: text, thinking. Thinking (last) skipped; text marked.
    const marked = blocks.filter((b) => b.cache_control !== undefined);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.type).toBe('text');
  });

  it('does not mutate the source Message objects', () => {
    const src: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];
    withRollingCacheBreakpoint(src.map(toAnthropicMessage));
    expect((src[0]!.content as Array<Record<string, unknown>>)[0]!.cache_control).toBeUndefined();
  });
});

describe('AnthropicProvider context management + rolling breakpoint (wire body)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const baseReq: CompletionRequest = {
    model: 'claude-opus-4-7',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
  };

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'm1',
          model: 'claude-opus-4-7',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function sent(): { body: Record<string, unknown>; headers: Record<string, string> } {
    const call = fetchSpy.mock.calls[0]!;
    const init = call[1] as { body: string; headers: Record<string, string> };
    return { body: JSON.parse(init.body) as Record<string, unknown>, headers: init.headers };
  }

  it('BYOK: sends context_management + beta header when contextEditing is requested', async () => {
    const p = new AnthropicProvider({ kind: 'byok', apiKey: 'k' });
    await p.complete({ ...baseReq, contextEditing: { triggerInputTokens: 100_000 } });
    const { body, headers } = sent();
    expect(headers['anthropic-beta']).toBe('context-management-2025-06-27');
    const cm = body.context_management as { edits: Array<Record<string, unknown>> };
    expect(cm.edits[0]!.type).toBe('clear_tool_uses_20250919');
    expect(cm.edits[0]!.trigger).toEqual({ type: 'input_tokens', value: 100_000 });
  });

  it('proxy auth: omits context_management (beta-header forwarding unverified)', async () => {
    const p = new AnthropicProvider({
      kind: 'automax',
      token: 't',
      baseOverride: 'https://proxy.example/v1/anthropic',
    } as never);
    await p.complete({ ...baseReq, contextEditing: { triggerInputTokens: 100_000 } });
    const { body, headers } = sent();
    expect(body.context_management).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('omits context_management entirely when not requested', async () => {
    const p = new AnthropicProvider({ kind: 'byok', apiKey: 'k' });
    await p.complete(baseReq);
    const { body, headers } = sent();
    expect(body.context_management).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('always applies the rolling breakpoint to the last message', async () => {
    const p = new AnthropicProvider({ kind: 'byok', apiKey: 'k' });
    await p.complete(baseReq);
    const { body } = sent();
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const lastBlocks = messages[messages.length - 1]!.content;
    expect(lastBlocks[lastBlocks.length - 1]!.cache_control).toEqual(EPHEMERAL);
  });
});
