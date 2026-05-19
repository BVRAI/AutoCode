import { describe, it, expect } from 'vitest';
import { TaskTool } from '../../src/tools/task.js';
import type { SessionContext } from '../../src/session/SessionContext.js';
import type { ToolExecutionContext, SubagentFactory } from '../../src/tools/types.js';

function fakeSession(): SessionContext {
  return {
    sessionId: 'test',
    projectRoot: '/tmp/x',
    dataDir: '/tmp',
    sessionDir: '/tmp/x/session',
    model: { provider: 'xai', model: 'grok-code-fast-1' },
    startedAt: new Date().toISOString(),
    planMode: false,
  };
}

describe('TaskTool', () => {
  it('rejects unknown subagent_type', async () => {
    const t = new TaskTool();
    const result = await t.execute(
      { description: 'do thing', subagent_type: 'NotARealType', prompt: 'go' },
      { session: fakeSession() },
    );
    expect(result.isError).toBe(true);
    expect(result.summary).toMatch(/unknown subagent_type/);
  });

  it('refuses recursion (depth > 0)', async () => {
    const t = new TaskTool();
    const ctx: ToolExecutionContext = { session: fakeSession(), depth: 1 };
    const result = await t.execute(
      { description: 'inception', subagent_type: 'Explore', prompt: 'go' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.summary).toMatch(/recursion not allowed/);
  });

  it('errors if no subagent factory is attached', async () => {
    const t = new TaskTool();
    const result = await t.execute(
      { description: 'do thing', subagent_type: 'Explore', prompt: 'go' },
      { session: fakeSession() },
    );
    expect(result.isError).toBe(true);
    expect(result.summary).toMatch(/factory not available/);
  });

  it('passes inputs through to the factory and returns its text', async () => {
    const t = new TaskTool();
    let received: Parameters<SubagentFactory>[0] | null = null;
    const factory: SubagentFactory = async (input) => {
      received = input;
      return {
        text: 'subagent says hi',
        usage: { inputTokens: 100, outputTokens: 50 },
        iterations: 3,
      };
    };
    const result = await t.execute(
      { description: 'find auth', subagent_type: 'Explore', prompt: 'look at src/' },
      { session: fakeSession(), subagentFactory: factory },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('subagent says hi');
    expect(received).not.toBeNull();
    expect(received!.type).toBe('Explore');
    expect(received!.prompt).toBe('look at src/');
    expect(received!.description).toBe('find auth');
    expect(received!.parentDepth).toBe(0);
  });

  it('reports error when subagent factory returns an error', async () => {
    const t = new TaskTool();
    const factory: SubagentFactory = async () => ({
      text: 'partial answer',
      usage: { inputTokens: 50, outputTokens: 30 },
      iterations: 16,
      error: 'iteration cap reached',
    });
    const result = await t.execute(
      { description: 'big task', subagent_type: 'Explore', prompt: 'go' },
      { session: fakeSession(), subagentFactory: factory },
    );
    expect(result.isError).toBe(true);
    expect(result.summary).toMatch(/iteration cap/);
    expect(result.content).toBe('partial answer');
  });
});
