// Plan mode as a workflow (Phase 4.2): a planning turn's answer becomes a
// plan file under .autocode/plans/, the user approves it with Claude Code's
// dialog, and the session switches mode and implements it. Pure helpers here;
// TerminalMode drives the dialog.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const PLANS_DIR = '.autocode/plans';
const MIN_PLAN_CHARS = 300;

/** Heuristic: does this planning-mode answer read like a plan worth saving? */
export function looksLikePlan(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_PLAN_CHARS) return false;
  const structured = /^(#{1,6}\s|\d+\.\s|[-*]\s)/m.test(t);
  const questions = (t.match(/\?/g) ?? []).length;
  // A wall of questions is a clarification, not a plan.
  return structured && questions <= 3;
}

export function planSlug(request: string): string {
  const words = request
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'add', 'make', 'please'].includes(w))
    .slice(0, 5);
  return words.join('-') || 'plan';
}

export function planStamp(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** Write the plan; returns the project-relative path. */
export function savePlan(projectRoot: string, request: string, plan: string, now = new Date()): string {
  const dir = join(projectRoot, PLANS_DIR);
  mkdirSync(dir, { recursive: true });
  let base = `${planStamp(now)}-${planSlug(request)}`;
  let path = join(dir, `${base}.md`);
  let n = 2;
  while (existsSync(path)) {
    path = join(dir, `${base}-${n}.md`);
    n += 1;
  }
  base = path;
  const content = `# Plan\n\n> Request: ${request.trim().replace(/\s+/g, ' ')}\n> Written by autocode in planning mode on ${now.toISOString()}\n\n${plan.trim()}\n`;
  writeFileSync(path, content, 'utf8');
  return relative(projectRoot, path).replace(/\\/g, '/');
}

export const PLAN_CHOICES = ['Yes, and auto-accept edits', 'Yes, manually approve edits', 'No, keep planning'] as const;

/** The message that starts implementation once a plan is approved. */
export function implementPlanMessage(planPath: string): string {
  return (
    `The plan above is approved and saved at \`${planPath}\`. Implement it now, step by step, in this order; ` +
    'read the file again if you lose track. Keep the todo list current. Do not widen the scope beyond the plan.'
  );
}
