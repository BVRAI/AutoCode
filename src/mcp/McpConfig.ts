// Where a session's MCP servers come from (Phase 4.6), lowest precedence
// first: the user's config.json, plugin mcp.json files, and the project's
// `.mcp.json` (Claude Code's format, `{ "mcpServers": { … } }`). Project
// servers are repo content that spawns processes, so they only start after
// the user approves them once per project (remembered in the project state).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServerConfig } from '../auth/ConfigStore.js';
import { getPlugins } from '../agent/Plugins.js';

export type McpSource = 'config' | 'plugin' | 'project';

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  source: McpSource;
  /** Plugin name for plugin servers. */
  plugin?: string;
}

export function readProjectMcpServers(root: string): Record<string, McpServerConfig> {
  const path = join(root, '.mcp.json');
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};
    const map = parsed['mcpServers'] && typeof parsed['mcpServers'] === 'object' ? (parsed['mcpServers'] as Record<string, unknown>) : parsed;
    const out: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(map)) {
      if (!cfg || typeof cfg !== 'object') continue;
      const c = cfg as Record<string, unknown>;
      if (typeof c['command'] !== 'string' && typeof c['url'] !== 'string') continue;
      out[name] = c as unknown as McpServerConfig;
    }
    return out;
  } catch {
    return {};
  }
}

/** Every server the session could start, deduplicated by name (later sources win). */
export function collectMcpServers(root: string, configServers: Record<string, McpServerConfig> | undefined): McpServerEntry[] {
  const byName = new Map<string, McpServerEntry>();
  for (const [name, config] of Object.entries(configServers ?? {})) byName.set(name, { name, config, source: 'config' });
  for (const p of getPlugins(root)) {
    for (const [name, config] of Object.entries(p.mcpServers ?? {})) byName.set(name, { name, config, source: 'plugin', plugin: p.name });
  }
  for (const [name, config] of Object.entries(readProjectMcpServers(root))) byName.set(name, { name, config, source: 'project' });
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One line describing what approving a server means. */
export function describeServer(entry: McpServerEntry): string {
  const c = entry.config;
  const how = typeof c.url === 'string' && c.url ? `connect to ${c.url}` : `run \`${c.command ?? '?'}${c.args && c.args.length > 0 ? ' ' + c.args.join(' ') : ''}\``;
  return `${entry.name} (${entry.source === 'plugin' ? `plugin ${entry.plugin}` : entry.source}): ${how}`;
}
