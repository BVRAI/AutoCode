// Skills — reusable on-demand expertise modules. Where AUTOCODE.md is eagerly
// loaded into every session, skills appear in the system prompt as a
// name+description table only; the agent pulls a skill's full body via the
// `use_skill` tool (or the user invokes `/<skill-name>`) when it is relevant.
// Progressive disclosure: pay the body cost on demand, not on every call.
//
// Two on-disk forms (Phase 4.4):
//   - the Agent Skills standard (agentskills.io): a directory named after the
//     skill holding SKILL.md (frontmatter: name, description, optional
//     license, compatibility, metadata, allowed-tools) plus any scripts and
//     resources the body refers to by relative path;
//   - the flat `<name>.md` file with the same frontmatter (legacy).
// Locations, lowest precedence first: user plugins, ~/.autocode/skills,
// ~/.agents/skills, ~/.claude/skills, project plugins, .autocode/skills,
// .agents/skills, .claude/skills — so skills written for Claude Code or Codex
// are drop-in. Later locations override earlier ones on a name conflict.
//
// Discovery is cached for the life of the process keyed by projectRoot.
// Files added mid-session are not picked up — restart autocode (matches
// Claude Code's behaviour).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { _resetPluginCacheForTests, discoverPlugins } from './Plugins.js';
import { BUILTIN_SKILLS } from './builtinSkills.js';
import { readSkillDir } from './skillFiles.js';

export { parseSkill, readSkillDir, listResources, MAX_SKILL_NAME, MAX_SKILL_DESCRIPTION } from './skillFiles.js';

export interface Skill {
  name: string;
  description: string;
  /** Optional informational glob — the agent decides activation by description. */
  match?: string;
  body: string;
  /** "builtin" (compiled in), "user", or "project" — for debugging / precedence
   *  reasoning. Built-ins are lowest precedence; a user/project skill of the
   *  same name overrides them. */
  source: 'project' | 'user' | 'builtin';
  /** The skill's directory for the SKILL.md form (resources live under it). */
  dir?: string;
  /** Files under `dir` other than SKILL.md, relative with forward slashes. */
  resources?: string[];
  /** Agent Skills `allowed-tools` (informational here). */
  allowedTools?: string[];
  license?: string;
  compatibility?: string;
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

/** Skill directories under a root (project or home), in precedence order (last wins). */
export const SKILL_DIRS = ['.autocode/skills', '.agents/skills', '.claude/skills'];
/** Claude Code's listing rules: per-description cap and a share of the window. */
export const LISTING_DESCRIPTION_CAP = 1_536;
export const LISTING_BUDGET_FRACTION = 0.01;

const cache = new Map<string, Skill[]>();

/** Discover skills from the project, user-global, and plugin locations. Memoised per projectRoot. */
export function getSkills(projectRoot: string): Skill[] {
  const cached = cache.get(projectRoot);
  if (cached !== undefined) return cached;
  const skills = layerBuiltins(discoverSkills(projectRoot, homedir()));
  cache.set(projectRoot, skills);
  return skills;
}

function layerBuiltins(discovered: Skill[]): Skill[] {
  const byName = new Map<string, Skill>();
  for (const s of BUILTIN_SKILLS) byName.set(s.name, s);
  for (const s of discovered) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Pure: the disk + plugin skill cascade without the memo or built-ins. */
export function discoverSkills(projectRoot: string, userHome: string): Skill[] {
  const byName = new Map<string, Skill>();
  const plugins = discoverPlugins(projectRoot, userHome);
  for (const p of plugins.filter((p) => p.source === 'user')) {
    for (const s of p.skills) byName.set(s.name, s);
  }
  for (const dir of SKILL_DIRS) {
    for (const s of readSkillDir(join(userHome, dir), 'user')) byName.set(s.name, s);
  }
  for (const p of plugins.filter((p) => p.source === 'project')) {
    for (const s of p.skills) byName.set(s.name, s);
  }
  for (const dir of SKILL_DIRS) {
    for (const s of readSkillDir(join(projectRoot, dir), 'project')) byName.set(s.name, s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Pure: find a skill by name in a list. Case-sensitive. */
export function findSkill(skills: Skill[], name: string): Skill | null {
  for (const s of skills) {
    if (s.name === name) return s;
  }
  return null;
}

/** Skill names as slash commands (`/deploy-checklist`). */
export function skillForCommand(skills: Skill[], head: string): Skill | null {
  const key = head.trim().replace(/^\//, '').toLowerCase();
  if (!key) return null;
  for (const s of skills) if (s.name.toLowerCase() === key) return s;
  return null;
}

/** The message a `/<skill>` invocation submits: the body inline, then the request. */
export function renderSkillInvocation(skill: Skill, args: string): string {
  const request = args.trim();
  return (
    `Use the "${skill.name}" skill for this request.\n\n<skill name="${skill.name}">\n${skill.body.trim()}\n</skill>\n\n` +
    (request.length > 0 ? `Request: ${request}` : 'Apply the skill to the current task.')
  );
}

/**
 * Render the "Skills available" section for the system prompt, within a
 * character budget (Claude Code: ~1% of the context window, 1,536 chars per
 * description). Project skills are kept first when the budget bites; the
 * rest are named so `use_skill` still works for them.
 */
export function renderSkillsSection(skills: Skill[], opts: { budgetChars?: number } = {}): string {
  if (skills.length === 0) return '';
  const budget = opts.budgetChars ?? Number.POSITIVE_INFINITY;
  const rank = { project: 0, user: 1, builtin: 2 };
  const ordered = [...skills].sort((a, b) => rank[a.source] - rank[b.source] || a.name.localeCompare(b.name));
  const rows: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const s of ordered) {
    const desc = s.description.length > LISTING_DESCRIPTION_CAP ? `${s.description.slice(0, LISTING_DESCRIPTION_CAP - 1)}…` : s.description;
    const row = `- **${s.name}** — ${desc}`;
    if (used + row.length + 1 > budget && rows.length > 0) {
      omitted.push(s.name);
      continue;
    }
    rows.push(row);
    used += row.length + 1;
  }
  rows.sort((a, b) => a.localeCompare(b));
  const tail = omitted.length > 0 ? `\n\n(${omitted.length} more not listed to save context; \`use_skill\` works for them by name: ${omitted.sort().join(', ')})` : '';
  return (
    '\n# Skills available\n\n' +
    'Reusable knowledge modules for specific tasks. Call the `use_skill` tool ' +
    'with a skill name to pull its full body into context only when relevant — ' +
    "the descriptions below are deliberately short so you don't pay the cost up front. " +
    'A skill may ship scripts and reference files; `use_skill` lists them and returns any of them with `resource`.\n\n' +
    rows.join('\n') +
    tail +
    '\n'
  );
}

/** Test-only: clear the memoization cache. */
export function _resetSkillCacheForTests(): void {
  cache.clear();
  _resetPluginCacheForTests();
}
