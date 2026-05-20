import { describe, it, expect } from 'vitest';
import { AgentLoop, gateFor, type AgentDeps } from '../../src/agent/AgentLoop.js';
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
