// The Review subagent's contract (Phase 4.1): an adversarial reader in a
// fresh context looks at the turn's diff before the turn ends and reports
// correctness bugs, regressions and scope creep as JSON. High-severity
// findings buy the main agent one fix round; the rest reach the user.

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { renderUnifiedDiff } from '../util/diff.js';
import type { CheckpointOp } from '../session/CheckpointStore.js';

export type ReviewSeverity = 'high' | 'medium' | 'low';

export interface ReviewFinding {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  issue: string;
  suggestion?: string;
}

export interface ReviewResult {
  verdict: 'approve' | 'request_changes';
  findings: ReviewFinding[];
  summary: string;
  /** Changes the request did not ask for, when the reviewer saw any. */
  scopeCreep?: string;
}

export interface TurnChange {
  /** Absolute path. */
  path: string;
  op: CheckpointOp;
  /** Absolute path of the pre-turn copy; null for created files. */
  backup: string | null;
}

const MAX_DIFF_CHARS = 60_000;
const MAX_FINDINGS = 12;
const MAX_HUNKS_PER_FILE = 20;

/** Unified diff of the turn's changes, file by file, bounded. */
export function buildTurnDiff(root: string, changes: TurnChange[]): { text: string; files: string[]; truncated: boolean } {
  const parts: string[] = [];
  const files: string[] = [];
  let size = 0;
  let truncated = false;
  for (const c of changes) {
    const rel = relative(root, c.path).replace(/\\/g, '/');
    const before = c.op === 'create' ? '' : safeRead(c.backup);
    const after = c.op === 'delete' ? '' : safeRead(c.path);
    if (before === after) continue;
    const body = c.op === 'delete' ? '(file deleted)' : c.op === 'create' ? `(new file, ${after.split(/\r?\n/).length} lines)\n${renderUnifiedDiff('', after, MAX_HUNKS_PER_FILE)}` : renderUnifiedDiff(before, after, MAX_HUNKS_PER_FILE);
    const chunk = `--- a/${rel}\n+++ b/${rel}\n${body}`;
    files.push(rel);
    if (size + chunk.length > MAX_DIFF_CHARS) {
      parts.push(`--- a/${rel}\n+++ b/${rel}\n(diff omitted: review size cap reached)`);
      truncated = true;
      continue;
    }
    parts.push(chunk);
    size += chunk.length;
  }
  return { text: parts.join('\n\n'), files, truncated };
}

/** The user message the Review subagent receives. */
export function buildReviewRequest(input: { request: string; diff: string; files: string[]; verification?: string; truncated?: boolean }): string {
  return [
    '# Review this turn',
    '',
    '## What the user asked for',
    input.request.trim() || '(no request text)',
    '',
    `## Files changed (${input.files.length})`,
    ...input.files.map((f) => `- ${f}`),
    '',
    input.verification ? `## Verification\n${input.verification}\n` : '',
    '## Diff' + (input.truncated ? ' (truncated to the size cap; read the files for the rest)' : ''),
    '```diff',
    input.diff,
    '```',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

export function parseReviewResult(text: string): ReviewResult | null {
  const candidate = extractJson(text);
  if (!candidate) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj['findings']) ? (obj['findings'] as unknown[]) : [];
  const findings: ReviewFinding[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const issue = typeof it['issue'] === 'string' ? it['issue'].trim() : typeof it['description'] === 'string' ? it['description'].trim() : '';
    if (!issue) continue;
    const f: ReviewFinding = { severity: severityOf(it['severity']), issue };
    if (typeof it['file'] === 'string' && it['file'].trim()) f.file = it['file'].replace(/\\/g, '/').trim();
    const line = numberOf(it['line']);
    if (line !== undefined) f.line = line;
    if (typeof it['suggestion'] === 'string' && it['suggestion'].trim()) f.suggestion = it['suggestion'].trim();
    findings.push(f);
    if (findings.length >= MAX_FINDINGS) break;
  }
  const verdictRaw = typeof obj['verdict'] === 'string' ? obj['verdict'].toLowerCase() : '';
  const verdict: ReviewResult['verdict'] =
    verdictRaw.includes('request') || verdictRaw.includes('change') || verdictRaw === 'fail' || verdictRaw === 'block'
      ? 'request_changes'
      : verdictRaw === 'approve' || verdictRaw === 'approved' || verdictRaw === 'pass' || verdictRaw === 'ok'
        ? 'approve'
        : findings.some((f) => f.severity === 'high')
          ? 'request_changes'
          : 'approve';
  return {
    verdict,
    findings,
    summary: typeof obj['summary'] === 'string' ? obj['summary'].trim() : '',
    scopeCreep: typeof obj['scopeCreep'] === 'string' && obj['scopeCreep'].trim() ? obj['scopeCreep'].trim() : typeof obj['scope_creep'] === 'string' && obj['scope_creep'].trim() ? obj['scope_creep'].trim() : undefined,
  };
}

/** Findings that cost the main agent a fix round. */
export function blockingFindings(r: ReviewResult): ReviewFinding[] {
  return r.findings.filter((f) => f.severity === 'high');
}

/** Transcript rendering: verdict line, findings best-first, scope note. */
export function renderReviewResult(r: ReviewResult): string {
  const lines: string[] = [];
  const order: Record<ReviewSeverity, number> = { high: 0, medium: 1, low: 2 };
  const sorted = [...r.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  lines.push(r.verdict === 'approve' ? `Approved${r.summary ? ` — ${r.summary}` : ''}` : `Changes requested${r.summary ? ` — ${r.summary}` : ''}`);
  for (const f of sorted) {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}  ` : '';
    lines.push(`[${f.severity}] ${where}${f.issue}${f.suggestion ? ` → ${f.suggestion}` : ''}`);
  }
  if (r.scopeCreep) lines.push(`Scope: ${r.scopeCreep}`);
  return lines.join('\n');
}

/** The fix-round message for the main agent. */
export function renderFixRequest(r: ReviewResult): string {
  const blocking = blockingFindings(r);
  const items = blocking.map((f, i) => `${i + 1}. ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}: ` : ''}${f.issue}${f.suggestion ? ` (suggestion: ${f.suggestion})` : ''}`);
  return (
    `[Code review] An independent review of your changes found ${blocking.length} high-severity issue${blocking.length === 1 ? '' : 's'}:\n\n` +
    items.join('\n') +
    '\n\nFix each one, or reply with a short explanation for any you believe is wrong, then stop. ' +
    'Verification re-runs automatically. Do not widen the change beyond what the user asked for.'
  );
}

function severityOf(v: unknown): ReviewSeverity {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s === 'high' || s === 'critical' || s === 'blocker' || s === 'error') return 'high';
  if (s === 'medium' || s === 'major' || s === 'warning' || s === 'warn') return 'medium';
  return 'low';
}

function numberOf(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v);
  return undefined;
}

function extractJson(text: string): string | null {
  const t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fence ? fence[1]!.trim() : t;
  if (body.startsWith('{')) return body;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) return body.slice(start, end + 1);
  return null;
}

function safeRead(path: string | null): string {
  if (!path) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
