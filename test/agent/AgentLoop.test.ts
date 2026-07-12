import { describe, it, expect } from 'vitest';
import {
  AgentLoop,
  gateFor,
  findCompactionCut,
  maskOldToolResults,
  type AgentDeps,
} from '../../src/agent/AgentLoop.js';
import type { Message } from '../../src/llm/types.js';

// loadState / cumulativeUsage / clearConversation touch only the conversation
// array and the cumulative counters — none of the deps — so a bare cast is
// enough to exercise them.
function makeLoop(): AgentLoop {
  return new AgentLoop({} as AgentDeps);
}

describe('AgentLoop.loadState', () => {
  it('replaces the conversation with the loaded messages', () => {
    const loop = makeLoop();
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    loop.loadState({
      messages,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    // clearConversation returns the message count it cleared.
    expect(loop.clearConversation()).toBe(2);
  });

  it('restores cumulative token counters', () => {
    const loop = makeLoop();
    loop.loadState({
      messages: [],
      usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 56, cacheWriteTokens: 7 },
    });
    expect(loop.cumulativeUsage()).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 56,
      cacheWriteTokens: 7,
    });
  });

});

describe('gateFor', () => {
  const mutating = ['edit_file', 'write_file', 'create_directory', 'run_shell'];
  const readonly = ['read_file', 'list_directory', 'glob', 'grep', 'web_search'];

  it('blocks mutating tools in planning mode', () => {
    for (const t of mutating) expect(gateFor('planning', t)).toBe('block');
  });

  it('requires approval for mutating tools in default mode', () => {
    for (const t of mutating) expect(gateFor('default', t)).toBe('approve');
  });

  it('allows mutating tools in autocode mode', () => {
    for (const t of mutating) expect(gateFor('autocode', t)).toBe('allow');
  });

  it('always allows read-only tools regardless of mode', () => {
    for (const mode of ['planning', 'default', 'autocode'] as const) {
      for (const t of readonly) expect(gateFor(mode, t)).toBe('allow');
    }
  });
});

describe('AgentLoop.loadState extra', () => {
  it('overwrites a previously loaded state on a second call', () => {
    const loop = makeLoop();
    loop.loadState({
      messages: [{ role: 'user', content: 'first' }],
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    loop.loadState({
      messages: [
        { role: 'user', content: 'second' },
        { role: 'user', content: 'third' },
      ],
      usage: { inputTokens: 99, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(loop.clearConversation()).toBe(2);
    expect(loop.cumulativeUsage().inputTokens).toBe(99);
  });
});

describe('findCompactionCut', () => {
  it('returns 0 when there are fewer user turns than keepPairs', () => {
    const convo = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ];
    expect(findCompactionCut(convo as never, 4)).toBe(0);
  });

  it('cuts before the keepPairs-th most recent user turn', () => {
    const convo = [
      { role: 'user', content: 't1' },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: 't2' },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      { role: 'user', content: 't3' },
    ];
    expect(findCompactionCut(convo as never, 2)).toBe(2);
  });

  it('ignores tool-result user messages as turn boundaries', () => {
    const convo = [
      { role: 'user', content: 'real-turn' },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'x', content: 'r' }] },
      { role: 'user', content: 'real-turn-2' },
    ];
    expect(findCompactionCut(convo as never, 1)).toBe(2);
  });
});

describe('maskOldToolResults', () => {
  const BIG = 'x'.repeat(3_000);

  // A conversation shaped like real agent history: old turn with bulky tool
  // results, then recent turns whose outputs must survive.
  function convo(): Message[] {
    return [
      { role: 'user', content: 'old task' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'planning' },
          { type: 'text', text: 'reading' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: BIG }] },
      { role: 'user', content: 'middle task' },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't2', content: BIG }] },
      { role: 'user', content: 'recent task' },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't3', content: BIG }] },
    ];
  }

  it('masks only tool_results older than the keepPairs-th user turn', () => {
    const c = convo();
    const n = maskOldToolResults(c, 2);
    expect(n).toBe(1); // only the t1 result, before 'middle task'
    const first = (c[2]!.content as Array<{ type: string; content: string }>)[0]!;
    expect(first.content).toMatch(/cleared to save context/);
    // Recent results untouched.
    const recent = (c[6]!.content as Array<{ type: string; content: string }>)[0]!;
    expect(recent.content).toBe(BIG);
  });

  it('is idempotent — a second pass masks nothing new', () => {
    const c = convo();
    expect(maskOldToolResults(c, 2)).toBe(1);
    expect(maskOldToolResults(c, 2)).toBe(0);
  });

  it('skips short tool results (no meaningful savings)', () => {
    const c: Message[] = [
      { role: 'user', content: 'old' },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't', content: 'tiny' }] },
      { role: 'user', content: 'new1' },
      { role: 'user', content: 'new2' },
    ];
    expect(maskOldToolResults(c, 2)).toBe(0);
    expect((c[1]!.content as Array<{ content: string }>)[0]!.content).toBe('tiny');
  });

  it('skips the pass entirely when total savings are trivial', () => {
    const c: Message[] = [
      { role: 'user', content: 'old' },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't', content: 'y'.repeat(600) }] },
      { role: 'user', content: 'new1' },
      { role: 'user', content: 'new2' },
    ];
    // 600 chars saved < 2000 threshold — not worth a prompt-cache bust.
    expect(maskOldToolResults(c, 2)).toBe(0);
  });

  it('leaves text, tool_use, and thinking blocks untouched', () => {
    const c = convo();
    maskOldToolResults(c, 2);
    const asst = c[1]!.content as Array<{ type: string; text?: string }>;
    expect(asst[0]).toEqual({ type: 'thinking', text: 'planning' });
    expect(asst[1]).toEqual({ type: 'text', text: 'reading' });
    expect(asst[2]).toMatchObject({ type: 'tool_use', id: 't1' });
  });

  it('returns 0 when the conversation is too short to have an old span', () => {
    const c: Message[] = [{ role: 'user', content: 'only turn' }];
    expect(maskOldToolResults(c, 2)).toBe(0);
  });
});
