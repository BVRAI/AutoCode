import { describe, it, expect } from 'vitest';
import { AskUserTool } from '../../src/tools/askUser.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

function ctx(choose?: ToolExecutionContext['choose']): ToolExecutionContext {
  const session: SessionContext = {
    sessionId: 't',
    projectRoot: '/tmp',
    dataDir: '/tmp',
    sessionDir: '/tmp/s',
    model: { provider: 'xai', model: 'm' },
    startedAt: new Date().toISOString(),
    mode: 'default',
  };
  return { session, choose };
}

describe('ask_user', () => {
  it('maps the selected index to the option text (single)', async () => {
    const out = await new AskUserTool().execute(
      { question: 'pick one', options: ['Red', 'Green', 'Blue'] },
      ctx(async () => [2]),
    );
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('C) Blue');
    expect(out.metadata?.selected).toEqual([2]);
  });

  it('maps multiple selected indices (multi)', async () => {
    const out = await new AskUserTool().execute(
      { question: 'pick some', options: ['a', 'b', 'c'], multi_select: true },
      ctx(async () => [0, 2]),
    );
    expect(out.content).toContain('A) a');
    expect(out.content).toContain('C) c');
  });

  it('reports no selection when the user picks nothing', async () => {
    const out = await new AskUserTool().execute(
      { question: 'q', options: ['a', 'b'] },
      ctx(async () => []),
    );
    expect(out.isError).toBeFalsy();
    expect(out.content).toMatch(/no selection/i);
  });

  it('errors when there is no interactive user', async () => {
    const out = await new AskUserTool().execute({ question: 'q', options: ['a', 'b'] }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/no interactive user/i);
  });

  it('rejects fewer than two options', async () => {
    const out = await new AskUserTool().execute(
      { question: 'q', options: ['only one'] },
      ctx(async () => [0]),
    );
    expect(out.isError).toBe(true);
  });
});
