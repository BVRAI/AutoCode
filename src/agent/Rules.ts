// Path-scoped rules (Phase 4.8): `.autocode/rules/*.md` (and `.claude/rules`
// for repos set up for Claude Code) with a `paths:` (or `globs:`) frontmatter
// list. A rule without paths is always on and joins the project instructions;
// a scoped rule is injected the first time a file it covers is read or
// changed in the session — appended to that tool result, so it costs nothing
// until it matters and never disturbs the cached prompt prefix.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from '../util/frontmatter.js';

export interface Rule {
  name: string;
  /** Glob patterns relative to the project root; empty = always on. */
  paths: string[];
  body: string;
  file: string;
}

export const RULE_DIRS = ['.autocode/rules', '.claude/rules'];
const MAX_RULE_BYTES = 20_000;
const MAX_RULES = 100;

const cache = new Map<string, Rule[]>();

export function getRules(projectRoot: string): Rule[] {
  const cached = cache.get(projectRoot);
  if (cached) return cached;
  const rules = discoverRules(projectRoot);
  cache.set(projectRoot, rules);
  return rules;
}

export function _resetRulesCacheForTests(): void {
  cache.clear();
}

export function discoverRules(projectRoot: string): Rule[] {
  const out: Rule[] = [];
  for (const rel of RULE_DIRS) {
    const dir = join(projectRoot, rel);
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.md') || out.length >= MAX_RULES) continue;
      const file = join(dir, name);
      let raw: string;
      try {
        if (!statSync(file).isFile()) continue;
        raw = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const fm = parseFrontmatter(raw);
      const meta = (fm.hasFrontmatter ? fm.meta : {}) as Record<string, string | undefined>;
      const pathsRaw = meta['paths'] ?? meta['globs'] ?? '';
      const body = (fm.hasFrontmatter ? fm.body : raw).trim().slice(0, MAX_RULE_BYTES);
      if (body.length === 0) continue;
      out.push({ name: name.replace(/\.md$/, ''), paths: parsePathList(pathsRaw), body, file });
    }
  }
  return out;
}

/** `["src/**", "lib/*.ts"]`, `src/**, lib/*.ts` or a bare pattern. */
export function parsePathList(raw: string): string[] {
  const t = raw.trim();
  if (!t) return [];
  const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
  return inner
    .split(',')
    .map((p) => p.trim().replace(/^["']|["']$/g, ''))
    .filter((p) => p.length > 0);
}

/** Minimal glob: `**` any depth, `*` within a segment, `?` one char. */
export function globMatches(pattern: string, path: string): boolean {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const f = path.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === '*') {
      if (p[i + 1] === '*') {
        const slashAfter = p[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(f);
}

export function alwaysOnRules(rules: Rule[]): Rule[] {
  return rules.filter((r) => r.paths.length === 0);
}

export function rulesForPath(rules: Rule[], relPath: string): Rule[] {
  return rules.filter((r) => r.paths.length > 0 && r.paths.some((g) => globMatches(g, relPath)));
}

export function renderRule(rule: Rule): string {
  return `[Project rule "${rule.name}" applies to ${rule.paths.join(', ')}]\n${rule.body}`;
}
