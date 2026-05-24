// Plugins — Anthropic playbook step 7. Bundle skills + hooks (and
// later MCP) into installable directories so good setups don't stay
// tribal. A plugin is just a directory with a `plugin.json` manifest
// + optionally a `skills/` subdir and a `hooks.json`. autocode
// discovers them at session start and merges their contributions
// into the live registries.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter } from '../util/frontmatter.js';
import type { Skill } from './Skills.js';
import type { HookSpec } from '../auth/ConfigStore.js';

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
  hooks: PluginHooks;
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
  };
}

function readPluginSkills(dir: string): Skill[] {
  const skillsDir = join(dir, 'skills');
  if (!safeIsDir(skillsDir)) return [];
  let names: string[];
  try {
    names = readdirSync(skillsDir);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const path = join(skillsDir, name);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    if (!fm.hasFrontmatter) continue;
    const skillName = fm.meta.name;
    const description = fm.meta.description;
    if (!skillName || !description) continue;
    out.push({
      name: skillName,
      description,
      ...(fm.meta.match ? { match: fm.meta.match } : {}),
      body: fm.body,
      // Plugin skills inherit their plugin's source for precedence.
      // (Resolved at the Skills.ts merge layer.)
      source: 'user',
    });
  }
  return out;
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
