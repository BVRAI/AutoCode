import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectMcpServers, describeServer, readProjectMcpServers } from '../../src/mcp/McpConfig.js';
import { expandEnv, transportKind } from '../../src/mcp/McpClientManager.js';
import { _resetPluginCacheForTests } from '../../src/agent/Plugins.js';

describe('MCP config sources', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-mcp-'));
    _resetPluginCacheForTests();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads Claude Code's .mcp.json and merges plugin servers under config ones", () => {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { jira: { url: 'https://mcp.example/jira', headers: { Authorization: 'Bearer ${JIRA_TOKEN}' } }, junk: { nope: 1 } } }));
    const plugin = join(root, '.autocode', 'plugins', 'tools');
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'tools' }));
    writeFileSync(join(plugin, 'mcp.json'), JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'mcp-fs'] }, jira: { command: 'ignored' } } }));
    expect(Object.keys(readProjectMcpServers(root))).toEqual(['jira']);
    const entries = collectMcpServers(root, { local: { command: 'node', args: ['srv.js'] } });
    expect(entries.map((e) => `${e.name}:${e.source}`)).toEqual(['fs:plugin', 'jira:project', 'local:config']);
    expect(entries.find((e) => e.name === 'jira')!.config.url).toBe('https://mcp.example/jira');
    expect(describeServer(entries[0]!)).toBe('fs (plugin tools): run `npx -y mcp-fs`');
    expect(describeServer(entries[1]!)).toContain('connect to https://mcp.example/jira');
  });

  it('picks the transport from type or url and expands ${ENV} in headers', () => {
    expect(transportKind({ command: 'x' })).toBe('stdio');
    expect(transportKind({ url: 'https://a' })).toBe('http');
    expect(transportKind({ type: 'sse', url: 'https://a' })).toBe('http');
    expect(transportKind({ type: 'stdio', command: 'x', url: 'https://a' })).toBe('stdio');
    expect(expandEnv('Bearer ${T}', { T: 'abc' } as NodeJS.ProcessEnv)).toBe('Bearer abc');
    expect(expandEnv('Bearer ${MISSING}', {} as NodeJS.ProcessEnv)).toBe('Bearer ');
  });
});
