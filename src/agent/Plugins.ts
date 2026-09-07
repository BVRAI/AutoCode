// Plugins — Anthropic playbook step 7. Bundle skills + hooks (and
// later MCP) into installable directories so good setups don't stay
// tribal. A plugin is just a directory with a `plugin.json` manifest
// + optionally a `skills/` subdir and a `hooks.json`. autocode
// discovers them at session start and merges their contributions
// into the live registries.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Skill } from './Skills.js';
import type { HookSpec, McpServerConfig } from '../auth/ConfigStore.js';
import { readSkillDir } from './skillFiles.js';
import { normalizeHooks, type HookEventName, type HookGroup, type HooksConfig } from './HookRunner.js';

export interface PluginHooks {
  pre_tool?: HookSpec[];
  post_tool?: HookSpec[];
  stop?: HookSpec[];
}

export interface Plugin {
  name: string;
  description?: string;
  version?: string;
  /** Absolute path to the plugin's directory. */
  dir: string;
  /** "project" or "user" — for precedence + display. */
  source: 'project' | 'user';
  skills: Skill[];
  /** Legacy flat shape (pre_tool / post_tool / stop), kept for `/plugins`. */
  hooks: PluginHooks;
  /** Every hook in the file, either shape, normalized per event (Phase 4.5). */
  hookGroups: Map<HookEventName, HookGroup[]>;
  /** MCP servers from the plugin's mcp.json (Agent Plugins 1.0). */
  mcpServers: Record<string, McpServerConfig>;
}

const cache = new Map<string, Plugin[]>();

/** Discover plugins from both locations, with project-local plugins
 *  overriding user-global on name conflict. Memoised per projectRoot. */
export function getPlugins(projectRoot: string): Plugin[] {
  const cached = cache.get(projectRoot);
  if (cached !== undefined) return cached;
  const plugins = discoverPlugins(projectRoot, homedir());
  cache.set(projectRoot, plugins);
  return plugins;
}

/** Pure: same as getPlugins but no memoization. */
export function discoverPlugins(projectRoot: string, userHome: string): Plugin[] {
  const byName = new Map<string, Plugin>();
  // User-global first, so project plugins override.
  for (const p of readPluginDir(join(userHome, '.autocode', 'plugins'), 'user')) {
    byName.set(p.name, p);
  }
  for (const p of readPluginDir(join(projectRoot, '.autocode', 'plugins'), 'project')) {
    byName.set(p.name, p);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readPluginDir(root: string, source: 'project' | 'user'): Plugin[] {
  if (!safeIsDir(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: Plugin[] = [];
  for (const entry of entries) {
    const dir = join(root, entry);
    if (!safeIsDir(dir)) continue;
    const plugin = readPluginManifest(dir, source);
    if (plugin) out.push(plugin);
  }
  return out;
}

function readPluginManifest(dir: string, source: 'project' | 'user'): Plugin | null {
  const manifestPath = join(dir, 'plugin.json');
  if (!existsSync(manifestPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (name.length === 0) return null;
  const description = typeof o.description === 'string' ? o.description : undefined;
  const version = typeof o.version === 'string' ? o.version : undefined;
  return {
    name,
    description,
    version,
    dir,
    source,
    skills: readPluginSkills(dir),
    hooks: readPluginHooks(dir),
    hookGroups: readPluginHookGroups(dir),
    mcpServers: readPluginMcpServers(dir),
  };
}

// A plugin's `skills/`: flat `<name>.md` files or `<name>/SKILL.md`
// directories (Agent Plugins 1.0). Plugin skills carry the 'user' source;
// precedence is resolved at the Skills.ts merge layer.
function readPluginSkills(dir: string): Skill[] {
  return readSkillDir(join(dir, 'skills'), 'user');
}

// A plugin's `mcp.json` (`{ "mcpServers": { name: config } }` or a bare map):
// servers the plugin brings along, started with the session's own.
function readPluginMcpServers(dir: string): Record<string, McpServerConfig> {
  const path = join(dir, 'mcp.json');
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

/** Every hook in hooks.json — the legacy flat shape, Claude Code's event
 *  shape, or `{ "hooks": { … } }` — normalized per event. */
function readPluginHookGroups(dir: string): Map<HookEventName, HookGroup[]> {
  const path = join(dir, 'hooks.json');
  if (!existsSync(path)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return new Map();
    const inner = parsed['hooks'] && typeof parsed['hooks'] === 'object' && !Array.isArray(parsed['hooks']) ? (parsed['hooks'] as HooksConfig) : (parsed as HooksConfig);
    return normalizeHooks(inner);
  } catch {
    return new Map();
  }
}

function readPluginHooks(dir: string): PluginHooks {
  const path = join(dir, 'hooks.json');
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const o = parsed as Record<string, unknown>;
  return {
    ...(Array.isArray(o.pre_tool) ? { pre_tool: o.pre_tool as HookSpec[] } : {}),
    ...(Array.isArray(o.post_tool) ? { post_tool: o.post_tool as HookSpec[] } : {}),
    ...(Array.isArray(o.stop) ? { stop: o.stop as HookSpec[] } : {}),
  };
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Convenience: collect all hook specs contributed by the given plugins
 *  for a single event. Returns [] if none. Useful in AgentLoop +
 *  TerminalMode where we merge plugin contributions with the user's own
 *  hooks at execution time. */
export function pluginHooksForEvent(
  plugins: Plugin[],
  event: 'pre_tool' | 'post_tool' | 'stop',
): HookSpec[] {
  const out: HookSpec[] = [];
  for (const p of plugins) {
    const hs = p.hooks[event];
    if (Array.isArray(hs)) out.push(...hs);
  }
  return out;
}

/** Test-only: clear the memoization cache. */
export function _resetPluginCacheForTests(): void {
  cache.clear();
}
