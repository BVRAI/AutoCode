// Reading skills from disk — shared by the skills cascade (Skills.ts) and the
// plugin loader (Plugins.ts), which cannot import each other at runtime.
// Two forms: the Agent Skills standard (`<name>/SKILL.md` + resources) and
// the flat `<name>.md` file.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseFrontmatter } from '../util/frontmatter.js';
import type { ParsedSkill, Skill } from './Skills.js';

/** Agent Skills spec limits. */
export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 1_024;
const MAX_RESOURCES = 50;
const MAX_WALK_DEPTH = 4;

/** Pure: parse a skill markdown file. Null when name or description is missing. */
export function parseSkill(content: string): ParsedSkill | null {
  const fm = parseFrontmatter(content);
  if (!fm.hasFrontmatter) return null;
  const { name, description, match } = fm.meta;
  if (!name || !description) return null;
  return {
    meta: { name: name.slice(0, MAX_SKILL_NAME), description: description.slice(0, MAX_SKILL_DESCRIPTION), ...(match ? { match } : {}) },
    body: fm.body,
  };
}

/**
 * Read one skills directory: flat `<name>.md` files and `<name>/SKILL.md`
 * directories (with their resources listed).
 */
export function readSkillDir(dir: string, source: 'project' | 'user'): Skill[] {
  if (!safeIsDir(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (name.endsWith('.md')) {
      const raw = safeRead(path);
      if (raw === null) continue;
      const parsed = parseSkill(raw);
      if (!parsed) continue;
      out.push({ ...parsed.meta, body: parsed.body, source, ...extras(raw) });
      continue;
    }
    if (!safeIsDir(path)) continue;
    const skillFile = join(path, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const raw = safeRead(skillFile);
    if (raw === null) continue;
    const parsed = parseSkill(raw);
    if (!parsed) continue;
    // The spec ties the name to the directory; a mismatch keeps the file's
    // name (it is what the body refers to) while the directory serves it.
    out.push({ ...parsed.meta, body: parsed.body, source, dir: path, resources: listResources(path), ...extras(raw) });
  }
  return out;
}

function extras(raw: string): Pick<Skill, 'allowedTools' | 'license' | 'compatibility'> {
  const fm = parseFrontmatter(raw);
  const meta = fm.meta as Record<string, string | undefined>;
  const out: Pick<Skill, 'allowedTools' | 'license' | 'compatibility'> = {};
  const tools = meta['allowed-tools'] ?? meta['allowed_tools'] ?? meta['allowedtools'];
  if (tools) out.allowedTools = tools.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  if (meta['license']) out.license = meta['license'];
  if (meta['compatibility']) out.compatibility = meta['compatibility'];
  return out;
}

/** Files under a skill directory (besides SKILL.md), bounded. */
export function listResources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || out.length >= MAX_RESOURCES) return;
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_RESOURCES) return;
      if (e.startsWith('.') || e === 'node_modules') continue;
      const full = join(d, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (!(depth === 0 && e === 'SKILL.md')) out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir, 0);
  return out;
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeRead(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
