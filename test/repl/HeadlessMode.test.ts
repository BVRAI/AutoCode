import { describe, it, expect } from 'vitest';
import { runHeadless } from '../../src/repl/HeadlessMode.js';
import type { AgentHandler } from '../../src/repl/TerminalMode.js';
import type { ConsoleRenderer } from '../../src/repl/ConsoleRenderer.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

function fakeCtx(): SessionContext {
  return {
    sessionId: 't',
    projectRoot: '/tmp',
    dataDir: '/tmp',
    sessionDir: '/tmp/s',
    model: { provider: 'xai', model: 'grok-code-fast-1' },
    startedAt: new Date().toISOString(),
  };
}

function fakeRenderer(): { renderer: ConsoleRenderer; errors: string[] } {
  const errors: string[] = [];
  const renderer = { error: (t: string) => errors.push(t) } as unknown as ConsoleRenderer;
  return { renderer, errors };
}

function baseAgent(overrides: Partial<AgentHandler>): AgentHandler {
  return {
    submit: async () => {},
    stop: () => {},
    clearConversation: () => 0,
    compactConversation: () => ({ before: 0, after: 0 }),
    cumulativeUsage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ...overrides,
  };
}

describe('runHeadless', () => {
  it('submits the prompt exactly once and returns 0', async () => {
    const calls: string[] = [];
    const agent = baseAgent({
      submit: async (text: string) => {
        calls.push(text);
      },
    });
    const { renderer } = fakeRenderer();
    const code = await runHeadless(agent, renderer, fakeCtx(), 'do the thing');
    expect(code).toBe(0);
    expect(calls).toEqual(['do the thing']);
  });

  it('returns 1 and renders the error when submit throws', async () => {
    const agent = baseAgent({
      submit: async () => {
        throw new Error('boom');
      },
    });
    const { renderer, errors } = fakeRenderer();
    const code = await runHeadless(agent, renderer, fakeCtx(), 'do the thing');
    expect(code).toBe(1);
    expect(errors).toEqual(['boom']);
  });
});
