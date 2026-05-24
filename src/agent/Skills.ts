// Skills — Anthropic playbook step 4. Reusable on-demand expertise
// modules. Where AUTOCODE.md is eagerly loaded into every session,
// skills appear in the system prompt as a name+description table only;
// the agent pulls a skill's full body via the `use_skill` tool when it
// decides one is relevant. This is "progressive disclosure" — pay the
// body cost on demand, not on every call.
//
// Discovery is cached for the life of the process keyed by projectRoot.
// Files added mid-session won't be picked up — restart autocode to
// rediscover. (Matches Claude Code's behaviour.)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter } from '../util/frontmatter.js';
import { _resetPluginCacheForTests, discoverPlugins } from './Plugins.js';

export interface Skill {
  name: string;
  description: string;
  /** Optional informational glob — the agent decides activation by description. */
  match?: string;
  body: string;
  /** "project" or "user" — for debugging / future precedence reasoning. */
  source: 'project' | 'user';
}

export interface SkillMeta {
  name: string;
  description: string;
  match?: string;
}

export interface ParsedSkill {
  meta: SkillMeta;
  body: string;
}

const cache = new Map<string, Skill[]>();

/** Discover skills from the project, user-global, and plugin locations.
 *  Precedence (last wins for the same name): user plugins → user-global
 *  skills → project plugins → project-local skills. Memoised per projectRoot. */
export function getSkills(projectRoot: string): Skill[] {
  const cached = cache.get(projectRoot);
  if (cached !== undefined) return cached;
  const skills = discoverSkills(projectRoot, homedir());
  cache.set(projectRoot, skills);
  return skills;
}

/** Pure: same as getSkills but without the memo, for tests + explicit
 *  re-discovery (not currently exposed but harmless to keep public). */
export function discoverSkills(projectRoot: string, userHome: string): Skill[] {
  const byName = new Map<string, Skill>();

  // Plugins import Skill as a type-only — no runtime cycle.
  const plugins = discoverPlugins(projectRoot, userHome);

  // Precedence cascade — later set() calls overwrite earlier ones.
  // 1. user-global plugins
  for (const p of plugins.filter((p) => p.source === 'user')) {
    for (const s of p.skills) byName.set(s.name, s);
  }
  // 2. user-global skills (loose files)
  for (const s of readSkillDir(join(userHome, '.autocode', 'skills'), 'user')) {
    byName.set(s.name, s);
  }
  // 3. project plugins
  for (const p of plugins.filter((p) => p.source === 'project')) {
    for (const s of p.skills) byName.set(s.name, s);
  }
  // 4. project-local skills (loose files) — highest precedence
  for (const s of readSkillDir(join(projectRoot, '.autocode', 'skills'), 'project')) {
    byName.set(s.name, s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readSkillDir(dir: string, source: 'project' | 'user'): Skill[] {
  if (!safeIsDir(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const path = join(dir, name);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseSkill(raw);
    if (!parsed) continue;
    out.push({ ...parsed.meta, body: parsed.body, source });
  }
  return out;
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Pure: parse a skill markdown file. Returns null when the required
 *  frontmatter fields (name + description) are missing. Tested in isolation. */
export function parseSkill(content: string): ParsedSkill | null {
  const fm = parseFrontmatter(content);
  if (!fm.hasFrontmatter) return null;
  const { name, description, match } = fm.meta;
  if (!name || !description) return null;
  return {
    meta: { name, description, ...(match ? { match } : {}) },
    body: fm.body,
  };
}

/** Pure: find a skill by name in a list. Case-sensitive. */
export function findSkill(skills: Skill[], name: string): Skill | null {
  for (const s of skills) {
    if (s.name === name) return s;
  }
  return null;
}

/** Render the "Skills available" section that goes into the system prompt.
 *  Empty string when no skills are configured (the section disappears). */
export function renderSkillsSection(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const rows = skills
    .map((s) => `- **${s.name}** — ${s.description}`)
    .join('\n');
  return (
    '\n# Skills available\n\n' +
    'Reusable knowledge modules for specific tasks. Call the `use_skill` tool ' +
    'with a skill name to pull its full body into context only when relevant — ' +
    "the descriptions below are deliberately short so you don't pay the cost up front.\n\n" +
    rows +
    '\n'
  );
}

/** Test-only: clear the memoization cache. Not exported via barrels; only
 *  the test file imports it directly. */
export function _resetSkillCacheForTests(): void {
  cache.clear();
  _resetPluginCacheForTests();
}
