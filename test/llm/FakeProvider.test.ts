import { describe, it, expect } from 'vitest';
import { FakeProvider, lastMessageText, type FakeScript } from '../../src/llm/providers/FakeProvider.js';
import type { CompletionRequest, StreamEvent } from '../../src/llm/types.js';

const req = (text: string): CompletionRequest => ({
  model: 'fake-model',
  system: '',
  messages: [{ role: 'user', content: text }],
  tools: [],
});

const script: FakeScript = {
  chunk: 4,
  delayMs: 0,
  turns: [
    { when: 'hello', thinking: 'plan it', tools: [{ name: 'read_file', input: { path: 'a.ts' } }], usage: { inputTokens: 10, outputTokens: 5 } },
    { text: 'all done' },
  ],
};

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('FakeProvider', () => {
  it('streams a turn as thinking, tool use and message_stop in the real event shapes', async () => {
    const p = new FakeProvider(script);
    const events = await collect(p.completeStream(req('say hello')));
    expect(events.filter((e) => e.type === 'thinking_delta').map((e) => (e as { text: string }).text).join('')).toBe('plan it');
    expect(events.find((e) => e.type === 'tool_use_start')).toMatchObject({ name: 'read_file' });
    expect(events.find((e) => e.type === 'tool_use_delta')).toMatchObject({ argsJsonChunk: '{"path":"a.ts"}' });
    const stop = events[events.length - 1]!;
    expect(stop.type).toBe('message_stop');
    if (stop.type === 'message_stop') {
      expect(stop.response.stopReason).toBe('tool_use');
      expect(stop.response.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
      expect(stop.response.content.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    }
  });

  it('skips turns whose `when` does not match and answers with text once exhausted', async () => {
    const p = new FakeProvider(script);
    // "hello" turn skipped (no match) → the text turn plays; then exhaustion.
    const first = await p.complete(req('unrelated'));
    expect(first.stopReason).toBe('end_turn');
    expect(first.content).toEqual([{ type: 'text', text: 'all done' }]);
    const second = await p.complete(req('again'));
    expect(second.content[0]).toMatchObject({ type: 'text' });
    expect((second.content[0] as { text: string }).text).toMatch(/no more turns/);
  });

  it('reads tool results for `when` matching', () => {
    expect(
      lastMessageText([
        { role: 'user', content: 'x' },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 't', content: 'user declined: leave it' }] },
      ]),
    ).toBe('user declined: leave it');
  });
});
