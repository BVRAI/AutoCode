import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AnthropicProvider, toAnthropicMessage } from '../../src/llm/providers/AnthropicProvider.js';
import type { CompletionRequest, Message, StreamEvent } from '../../src/llm/types.js';

const req: CompletionRequest = {
  model: 'claude-sonnet-4-5',
  system: 'autocode',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
};

describe('toAnthropicMessage thinking round-trip', () => {
  it('round-trips thinking blocks with signatures verbatim', () => {
    const m: Message = {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'step by step', signature: 'sig-abc' },
        { type: 'text', text: 'done' },
      ],
    };
    const wire = toAnthropicMessage(m);
    expect(wire.content).toEqual([
      { type: 'thinking', thinking: 'step by step', signature: 'sig-abc' },
      { type: 'text', text: 'done' },
    ]);
  });

  it('maps redactedData to redacted_thinking', () => {
    const m: Message = {
      role: 'assistant',
      content: [{ type: 'thinking', text: '', redactedData: 'encrypted-blob' }],
    };
    const wire = toAnthropicMessage(m);
    expect(wire.content).toEqual([{ type: 'redacted_thinking', data: 'encrypted-blob' }]);
  });

  it('drops signature-less thinking blocks (foreign-provider history)', () => {
    // Reasoning captured from grok in the same session's history has no
    // Anthropic signature — echoing it would fail server-side validation.
    const m: Message = {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'grok reasoning with no signature' },
        { type: 'text', text: 'visible' },
      ],
    };
    const wire = toAnthropicMessage(m);
    expect(wire.content).toEqual([{ type: 'text', text: 'visible' }]);
  });
});

describe('AnthropicProvider thinking parsing', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('maps thinking + redacted_thinking response blocks to ThinkingBlocks', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'm1',
          model: 'claude-sonnet-4-5',
          stop_reason: 'end_turn',
          content: [
            { type: 'thinking', thinking: 'hmm', signature: 's1' },
            { type: 'redacted_thinking', data: 'blob' },
            { type: 'text', text: 'answer' },
          ],
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const p = new AnthropicProvider({ kind: 'byok', apiKey: 'k' });
    const resp = await p.complete(req);
    expect(resp.content).toEqual([
      { type: 'thinking', text: 'hmm', signature: 's1' },
      { type: 'thinking', text: '', redactedData: 'blob' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('parses streamed thinking_delta and signature_delta into a thinking block', async () => {
    const records = [
      ['message_start', { message: { usage: { input_tokens: 10 } } }],
      ['content_block_start', { content_block: { type: 'thinking' } }],
      ['content_block_delta', { delta: { type: 'thinking_delta', thinking: 'let me ' } }],
      ['content_block_delta', { delta: { type: 'thinking_delta', thinking: 'think' } }],
      ['content_block_delta', { delta: { type: 'signature_delta', signature: 'sig123' } }],
      ['content_block_stop', {}],
      ['content_block_start', { content_block: { type: 'text' } }],
      ['content_block_delta', { delta: { type: 'text_delta', text: 'answer' } }],
      ['content_block_stop', {}],
      ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
      ['message_stop', {}],
    ] as const;
    const sseText =
      records.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}`).join('\n\n') +
      '\n\n';
    fetchSpy.mockResolvedValue(new Response(sseText, { status: 200 }));

    const p = new AnthropicProvider({ kind: 'byok', apiKey: 'k' });
    const events: StreamEvent[] = [];
    for await (const e of p.completeStream(req)) events.push(e);

    const thinkingDeltas = events.filter((e) => e.type === 'thinking_delta');
    expect(thinkingDeltas).toHaveLength(2);
    const stop = events.at(-1)!;
    expect(stop.type).toBe('message_stop');
    if (stop.type === 'message_stop') {
      expect(stop.response.content[0]).toEqual({
        type: 'thinking',
        text: 'let me think',
        signature: 'sig123',
      });
      expect(stop.response.content[1]).toEqual({ type: 'text', text: 'answer' });
      expect(stop.response.usage.outputTokens).toBe(5);
    }
  });
});
