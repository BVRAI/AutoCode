// User-configurable permission rules (Phase 5.4), Claude Code's shape:
//
//   "permissions": {
//     "allow": ["Bash(git *)", "Read", "Edit(src/**)"],
//     "ask":   ["Bash(npm publish*)"],
//     "deny":  ["Bash(rm -rf *)", "Read(.env)"]
//   }
//
// Evaluated before the built-in classifier and the mode gate: deny wins,
// then ask, then allow. `Tool(prefix *)` matches the shell command or the
// file path; a bare tool name matches every call of that tool. Rules come
// from the user's config and, once the project is trusted, from
// `.autocode/permissions.json` or the `permissions` key of `.claude/settings.json`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matcherMatches } from '../agent/HookRunner.js';

export interface PermissionRules {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

export type PermissionDecision = 'allow' | 'ask' | 'deny' | null;

export const PROJECT_PERMISSION_FILES = ['.autocode/permissions.json', '.claude/settings.json'];

export function normalizeRules(raw: unknown): PermissionRules {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : undefined);
  return { allow: list(o['allow']), ask: list(o['ask']), deny: list(o['deny']) };
}

export function mergeRules(...sets: Array<PermissionRules | undefined | null>): PermissionRules {
  const out: PermissionRules = { allow: [], ask: [], deny: [] };
  for (const s of sets) {
    if (!s) continue;
    out.allow!.push(...(s.allow ?? []));
    out.ask!.push(...(s.ask ?? []));
    out.deny!.push(...(s.deny ?? []));
  }
  return out;
}

/** Project rules from disk (only meaningful once the project is trusted). */
export function readProjectRules(root: string): PermissionRules {
  for (const rel of PROJECT_PERMISSION_FILES) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const rules = parsed && typeof parsed === 'object' && parsed['permissions'] && typeof parsed['permissions'] === 'object' ? parsed['permissions'] : parsed;
      const n = normalizeRules(rules);
      if ((n.allow?.length ?? 0) + (n.ask?.length ?? 0) + (n.deny?.length ?? 0) > 0) return n;
    } catch {
      /* malformed: ignore */
    }
  }
  return {};
}

/** The rule that decides this call, deny > ask > allow; null when no rule matches. */
export function decide(rules: PermissionRules, toolName: string, input: Record<string, unknown>): { decision: PermissionDecision; rule?: string } {
  for (const [decision, list] of [
    ['deny', rules.deny],
    ['ask', rules.ask],
    ['allow', rules.allow],
  ] as const) {
    for (const rule of list ?? []) {
      if (matcherMatches(rule, toolName, input)) return { decision, rule };
    }
  }
  return { decision: null };
}
