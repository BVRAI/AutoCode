// Git workflow helpers (Phase 4.3): staging and committing with a generated
// conventional message (`/commit`), and per-session worktrees (`--worktree`).
// Plain git commands, no library; every function is safe to call on a
// non-repository (it says so instead of throwing).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIFF_CAP_CHARS = 30_000;

function git(root: string, args: string[], opts: { input?: string } = {}): { ok: boolean; out: string } {
  try {
    const out = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      input: opts.input,
    });
    return { ok: true, out: out.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: (err.stderr || err.stdout || err.message || String(e)).toString().trim() };
  }
}

export function isGitRepo(root: string): boolean {
  return git(root, ['rev-parse', '--is-inside-work-tree']).ok;
}

export interface StagedSummary {
  files: string[];
  stat: string;
  diff: string;
  truncated: boolean;
}

/** `git add -A` then describe what is staged. */
export function stageAll(root: string): { ok: boolean; error?: string } {
  const r = git(root, ['add', '-A']);
  return r.ok ? { ok: true } : { ok: false, error: r.out };
}

export function stagedSummary(root: string): StagedSummary {
  const files = git(root, ['diff', '--cached', '--name-only']).out.split(/\r?\n/).filter((l) => l.length > 0);
  const stat = git(root, ['diff', '--cached', '--stat']).out;
  const full = git(root, ['diff', '--cached']).out;
  const truncated = full.length > DIFF_CAP_CHARS;
  return { files, stat, diff: truncated ? full.slice(0, DIFF_CAP_CHARS) : full, truncated };
}

/** The prompt that turns a staged diff into a conventional commit message. */
export function commitMessagePrompt(summary: StagedSummary, hint?: string): { system: string; user: string } {
  return {
    system:
      'You write git commit messages. Reply with the message only: a conventional-commit subject line ' +
      '(type(scope): summary, imperative, ≤ 72 chars, no trailing period), then a blank line, then 1–5 short ' +
      'bullet lines saying what changed and why when the diff warrants it. No code fences, no preamble.',
    user:
      `${hint ? `The author's hint: ${hint}\n\n` : ''}Files:\n${summary.stat}\n\nDiff${summary.truncated ? ' (truncated)' : ''}:\n\`\`\`diff\n${summary.diff}\n\`\`\``,
  };
}

/** Strip fences and stray quotes a model may add around the message. */
export function cleanCommitMessage(text: string): string {
  let t = text.trim();
  const fence = /^```[a-z]*\s*([\s\S]*?)```$/i.exec(t);
  if (fence) t = fence[1]!.trim();
  t = t.replace(/^["'`]+|["'`]+$/g, '').trim();
  return t;
}

export function commit(root: string, message: string, trailer?: string): { ok: boolean; hash?: string; error?: string } {
  const full = trailer ? `${message.trim()}\n\n${trailer}` : message.trim();
  const r = git(root, ['commit', '-F', '-'], { input: full });
  if (!r.ok) return { ok: false, error: r.out };
  const hash = git(root, ['rev-parse', '--short', 'HEAD']).out;
  return { ok: true, hash };
}

export function currentBranch(root: string): string | null {
  const r = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.out : null;
}

// ── worktrees ───────────────────────────────────────────────────────────────

export const WORKTREE_DIR = '.autocode/worktrees';

export interface WorktreeInfo {
  path: string;
  branch: string;
  created: boolean;
}

/**
 * Give a session its own worktree under `.autocode/worktrees/<name>` on a
 * new branch `autocode/<name>` from HEAD (Claude Code keeps its worktrees the
 * same way under .claude/worktrees). The folder is excluded from git status
 * through .git/info/exclude so the main tree stays clean.
 */
export function createWorktree(root: string, name: string): WorktreeInfo | { error: string } {
  if (!isGitRepo(root)) return { error: `${root} is not a git repository` };
  const safe = name.replace(/[^\w.-]+/g, '-').slice(0, 40) || 'session';
  const dir = join(root, WORKTREE_DIR, safe);
  const branch = `autocode/${safe}`;
  if (existsSync(dir)) return { path: dir, branch, created: false };
  mkdirSync(join(root, WORKTREE_DIR), { recursive: true });
  excludeFromGit(root, `${WORKTREE_DIR}/`);
  const r = git(root, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  if (!r.ok) return { error: r.out };
  return { path: dir, branch, created: true };
}

export function removeWorktree(root: string, path: string): { ok: boolean; error?: string } {
  const r = git(root, ['worktree', 'remove', '--force', path]);
  return r.ok ? { ok: true } : { ok: false, error: r.out };
}

function excludeFromGit(root: string, pattern: string): void {
  const gitDir = git(root, ['rev-parse', '--git-common-dir']).out || '.git';
  const file = join(root, gitDir, 'info', 'exclude');
  try {
    mkdirSync(join(root, gitDir, 'info'), { recursive: true });
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (current.split(/\r?\n/).includes(pattern)) return;
    writeFileSync(file, `${current.replace(/\s*$/, '')}\n${pattern}\n`, 'utf8');
  } catch {
    /* the worktree still works; status just shows the folder */
  }
}
