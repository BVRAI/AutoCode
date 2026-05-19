import { describe, it, expect } from 'vitest';
import { McpTool } from '../../src/mcp/McpTool.js';
import type { McpClientManager } from '../../src/mcp/McpClientManager.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

function fakeManager(): McpClientManager {
  return {
    callTool: async (server: string, tool: string, args: Record<string, unknown>) => ({
      content: `called ${server}/${tool} with ${JSON.stringify(args)}`,
      isError: false,
    }),
  } as unknown as McpClientManager;
}

function fakeSession(): SessionContext {
  return {
    sessionId: 't',
    projectRoot: '/tmp',
    dataDir: '/tmp',
    sessionDir: '/tmp/s',
    model: { provider: 'xai', model: 'grok-code-fast-1' },
    startedAt: new Date().toISOString(),
    planMode: false,
  };
}

describe('McpTool', () => {
  it('exposes itself under mcp__<server>__<tool> naming', () => {
    const t = new McpTool(fakeManager(), {
      serverName: 'github',
      toolName: 'list_issues',
      description: 'List GitHub issues',
      inputSchema: { type: 'object', properties: {} },
    });
    expect(t.definition.name).toBe('mcp__github__list_issues');
    expect(t.definition.description).toContain('[MCP / github]');
    expect(t.definition.description).toContain('List GitHub issues');
  });

  it('passes args through the manager and returns its response', async () => {
    const t = new McpTool(fakeManager(), {
      serverName: 'fs',
      toolName: 'read',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    });
    const result = await t.execute({ path: '/tmp/x' }, { session: fakeSession() });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('called fs/read');
    expect(result.content).toContain('"path":"/tmp/x"');
  });

  it('propagates errors from the manager', async () => {
    const manager = {
      callTool: async () => ({ content: 'boom', isError: true }),
    } as unknown as McpClientManager;
    const t = new McpTool(manager, {
      serverName: 's',
      toolName: 't',
      description: '',
      inputSchema: { type: 'object', properties: {} },
    });
    const result = await t.execute({}, { session: fakeSession() });
    expect(result.isError).toBe(true);
    expect(result.summary).toMatch(/error/);
  });

  it('falls back to a generic input schema when none is provided', () => {
    const t = new McpTool(fakeManager(), {
      serverName: 's',
      toolName: 't',
      description: '',
      inputSchema: null as unknown as Record<string, unknown>,
    });
    expect(t.definition.inputSchema).toMatchObject({ type: 'object' });
  });
});
