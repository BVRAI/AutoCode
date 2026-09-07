import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { DEFER_THRESHOLD, ToolRegistry } from '../../src/agent/ToolRegistry.js';
import { ToolSearchTool } from '../../src/tools/toolSearch.js';
import type { Tool } from '../../src/tools/types.js';

function fakeTool(name: string, description: string): Tool {
  return {
    definition: { name, description, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    execute: async () => ({ summary: 'ok', content: 'ok' }),
  };
}

// The built-in optional tools (git history) would shift the counts below;
// this file is about the deferral mechanics, so keep the registry to the
// eager core plus the fakes it registers.
const savedGitTools = process.env.AUTOCODE_NO_GIT_TOOLS;
const savedLsp = process.env.AUTOCODE_NO_LSP;
beforeAll(() => {
  process.env.AUTOCODE_NO_GIT_TOOLS = '1';
  process.env.AUTOCODE_NO_LSP = '1';
});
afterAll(() => {
  if (savedGitTools === undefined) delete process.env.AUTOCODE_NO_GIT_TOOLS;
  else process.env.AUTOCODE_NO_GIT_TOOLS = savedGitTools;
  if (savedLsp === undefined) delete process.env.AUTOCODE_NO_LSP;
  else process.env.AUTOCODE_NO_LSP = savedLsp;
});

describe('deferred tools', () => {
  it('keeps a small optional set eager and defers past the threshold with a tool_search tool', () => {
    const r = new ToolRegistry();
    const base = r.schemas().length;
    r.registerOptional(fakeTool('mcp__a__one', 'first optional'));
    expect(r.schemas().map((s) => s.name)).toContain('mcp__a__one');
    expect(r.schemas().map((s) => s.name)).not.toContain('tool_search');
    const needed = DEFER_THRESHOLD - r.schemas().length + 3;
    for (let i = 0; i < needed; i++) r.registerOptional(fakeTool(`mcp__srv__tool${i}`, `does thing ${i} with jira ${i % 2 === 0 ? 'issues' : 'boards'}`));
    const names = r.schemas().map((s) => s.name);
    expect(names).toContain('tool_search');
    // Past the threshold every optional tool waits behind tool_search,
    // whatever the registration order — the prompt prefix stays stable.
    expect(names.filter((n) => n.startsWith('mcp__'))).toEqual([]);
    expect(r.deferredNames().length).toBe(needed + 1);
    expect(names.length).toBe(base + 1);
  });

  it('tool_search loads matching deferred tools into the schema list', async () => {
    const r = new ToolRegistry();
    for (let i = 0; i < DEFER_THRESHOLD + 2; i++) r.registerOptional(fakeTool(`mcp__x__t${i}`, i === 7 ? 'create a jira issue' : `misc ${i}`));
    expect(r.isDeferred('mcp__x__t7')).toBe(true);
    const search = new ToolSearchTool(r);
    const res = await search.execute({ query: 'jira issue' }, { session: {} as never });
    expect(res.summary).toContain('mcp__x__t7');
    expect(res.content).toContain('Input schema');
    expect(r.isDeferred('mcp__x__t7')).toBe(false);
    expect(r.schemas().map((s) => s.name)).toContain('mcp__x__t7');
    const none = await search.execute({ query: 'zzz-nothing' }, { session: {} as never });
    expect(none.content).toContain('available on demand');
  });
});
