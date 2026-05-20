import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HARD_BLOCK, SOFT_CONFIRM, type SafetyPattern } from './patterns.js';
import { fencedReason } from './fencedZones.js';

export type SafetyVerdict =
  | { kind: 'allow' }
  | { kind: 'confirm'; reason: string; pattern: string }
  | { kind: 'block'; reason: string; pattern: string };

// Verbs that delete, move, or overwrite — the operations whose blast radius
// matters when the target is outside the project or in a protected zone.
const DESTRUCTIVE_VERB =
  /\b(rm|rmdir|rd|del|erase|unlink|mv|move|move-item|remove-item|ri)\b/i;

// Redirect targets that are harmless even though they look out-of-root.
const NULL_SINK = /^(\/dev\/null|nul|nul:)$/i;

export function classifyCommand(command: string, projectRoot?: string): SafetyVerdict {
  const trimmed = command.trim();
  if (trimmed.length === 0) return { kind: 'allow' };

  const hard = firstMatch(trimmed, HARD_BLOCK);
  if (hard) return { kind: 'block', reason: hard.reason, pattern: hard.re.source };

  // Path-aware pass: block destructive commands that escape the project root
  // or target a fenced system/credential zone. Heuristic — true containment
  // needs OS sandboxing — but it catches the obvious dangerous cases.
  if (projectRoot) {
    const pathVerdict = pathAwareVerdict(trimmed, projectRoot);
    if (pathVerdict) return pathVerdict;
  }

  const soft = firstMatch(trimmed, SOFT_CONFIRM);
  if (soft) return { kind: 'confirm', reason: soft.reason, pattern: soft.re.source };

  return { kind: 'allow' };
}

function firstMatch(command: string, patterns: SafetyPattern[]): SafetyPattern | undefined {
  for (const p of patterns) {
    if (p.re.test(command)) return p;
  }
  return undefined;
}

function pathAwareVerdict(command: string, projectRoot: string): SafetyVerdict | null {
  const destructive = DESTRUCTIVE_VERB.test(command);
  const candidates: string[] = [];

  // Path-like arguments of a destructive command.
  if (destructive) {
    for (const tok of tokenize(command)) {
      if (isPathLike(tok)) candidates.push(tok);
    }
  }
  // Redirect targets (`> file`, `>> file`) — a `>` truncates its target.
  for (const m of command.matchAll(/>>?\s*("[^"]*"|'[^']*'|\S+)/g)) {
    const t = (m[1] ?? '').replace(/^["']|["']$/g, '');
    if (t && !NULL_SINK.test(t)) candidates.push(t);
  }

  for (const raw of candidates) {
    // An unresolved variable inside a destructive command cannot be verified.
    if (/[$%]/.test(raw)) {
      return {
        kind: 'block',
        reason: 'destructive command with an unresolved path variable — cannot verify it is safe',
        pattern: raw,
      };
    }
    const abs = resolvePathToken(raw, projectRoot);
    const fenced = fencedReason(abs);
    if (fenced) {
      return { kind: 'block', reason: `targets a protected system zone (${fenced})`, pattern: raw };
    }
    if (isOutsideRoot(abs, projectRoot)) {
      return { kind: 'block', reason: 'targets a path outside the project root', pattern: raw };
    }
  }
  return null;
}

function tokenize(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

function isPathLike(token: string): boolean {
  if (token.length === 0 || token.startsWith('-')) return false;
  return (
    token.includes('/') ||
    token.includes('\\') ||
    /^[a-zA-Z]:/.test(token) ||
    token.startsWith('~') ||
    token.startsWith('..')
  );
}

function resolvePathToken(token: string, projectRoot: string): string {
  let t = token;
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) {
    t = join(homedir(), t.slice(1));
  }
  return isAbsolute(t) ? resolve(t) : resolve(projectRoot, t);
}

function isOutsideRoot(abs: string, projectRoot: string): boolean {
  const rel = relative(resolve(projectRoot), abs);
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
}
