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

/** Discover skills from the project and the user-global locations, with
 *  project-local skills overriding user-global on name conflict. Memoized
 *  per projectRoot for the life of the process. */
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

  // User-global first, so project-local overrides.
  for (const s of readSkillDir(join(userHome, '.autocode', 'skills'), 'user')) {
    byName.set(s.name, s);
  }
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
  // Frontmatter must be the first thing in the file: `---\n…\n---\n`.
  if (!content.startsWith('---')) return null;
  // Find the closing `---` on its own line.
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return null;

  const meta: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && value) meta[key] = value;
  }

  if (!meta.name || !meta.description) return null;
  const body = lines.slice(endIdx + 1).join('\n').trim();
  return {
    meta: {
      name: meta.name,
      description: meta.description,
      ...(meta.match ? { match: meta.match } : {}),
    },
    body,
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
}
