import { describe, it, expect } from 'vitest';
import { TodoWriteTool, currentTodos, markInProgressInterrupted } from '../../src/tools/todoWrite.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

let counter = 0;
function ctx(): ToolExecutionContext {
  // Unique session id per test so list state doesn't leak across cases.
  counter += 1;
  const session: SessionContext = {
    sessionId: `todo-test-${counter}-${Date.now()}`,
    projectRoot: '/tmp',
    dataDir: '/tmp',
    sessionDir: '/tmp',
    model: { provider: 'xai', model: 'm' },
    startedAt: new Date().toISOString(),
    mode: 'autocode',
  };
  return { session };
}

describe('todo_write — interrupted status', () => {
  it('accepts status:"interrupted" in action="set"', async () => {
    const c = ctx();
    const out = await new TodoWriteTool().execute(
      {
        action: 'set',
        items: [
          { id: 't1', text: 'do thing', status: 'interrupted' },
          { id: 't2', text: 'another', status: 'in_progress' },
        ],
      },
      c,
    );
    expect(out.isError).not.toBe(true);
    const list = currentTodos(c.session.sessionId);
    expect(list[0]!.status).toBe('interrupted');
    expect(list[1]!.status).toBe('in_progress');
  });

  it('accepts status:"interrupted" in action="update"', async () => {
    const c = ctx();
    await new TodoWriteTool().execute(
      { action: 'set', items: [{ id: 't1', text: 'do thing', status: 'in_progress' }] },
      c,
    );
    const out = await new TodoWriteTool().execute(
      { action: 'update', id: 't1', status: 'interrupted' },
      c,
    );
    expect(out.isError).not.toBe(true);
    expect(currentTodos(c.session.sessionId)[0]!.status).toBe('interrupted');
  });
});

describe('markInProgressInterrupted', () => {
  it('flips only in_progress todos and reports the count', async () => {
    const c = ctx();
    await new TodoWriteTool().execute(
      {
        action: 'set',
        items: [
          { id: 'a', text: 'A', status: 'in_progress' },
          { id: 'b', text: 'B', status: 'in_progress' },
          { id: 'c', text: 'C', status: 'pending' },
          { id: 'd', text: 'D', status: 'completed' },
        ],
      },
      c,
    );
    const flipped = markInProgressInterrupted(c.session.sessionId);
    expect(flipped).toBe(2);
    const list = currentTodos(c.session.sessionId);
    expect(list.find((t) => t.id === 'a')!.status).toBe('interrupted');
    expect(list.find((t) => t.id === 'b')!.status).toBe('interrupted');
    expect(list.find((t) => t.id === 'c')!.status).toBe('pending');
    expect(list.find((t) => t.id === 'd')!.status).toBe('completed');
  });

  it('returns 0 when there are no in_progress todos', async () => {
    const c = ctx();
    await new TodoWriteTool().execute(
      { action: 'set', items: [{ id: 'a', text: 'A', status: 'pending' }] },
      c,
    );
    expect(markInProgressInterrupted(c.session.sessionId)).toBe(0);
  });

  it('returns 0 for an unknown session id', () => {
    expect(markInProgressInterrupted('never-existed')).toBe(0);
  });
});
