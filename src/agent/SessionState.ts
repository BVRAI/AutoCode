// Curated working-state context injected into the system prompt every turn.
// Tells the agent what's actually IN-FLIGHT in the repo right now —
// which files are modified, which commits just landed, whether the
// repo is mid-rebase / mid-merge — instead of leaving it to guess or
// burn tool calls re-running `git status`.

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type RepoInProgress = 'rebase' | 'merge' | 'cherry-pick' | null;

export interface RecentCommit {
  sha: string;
  subject: string;
  relativeDate: string;
}

export interface GitWorkingState {
  branch: string;
  isDetachedHead: boolean;
  inProgress: RepoInProgress;
  modifiedFiles: string[];
  stagedFiles: string[];
  deletedFiles: string[];
  untrackedCount: number;
  recentCommits: RecentCommit[];
}

const FILE_LIST_CAP = 20;
const RECENT_COMMITS = 5;
const SUBJECT_TRUNCATE = 80;
const CACHE_TTL_MS = 2_000;

interface CacheEntry {
  state: GitWorkingState | null;
  at: number;
}

const cache = new Map<string, CacheEntry>();

/** Snapshot the repo's working state. Returns null when the directory is
 *  not a git repo. Cached for 2s per projectRoot — PromptBuilder runs on
 *  every agent iteration, and without caching we'd burn ~150ms each
 *  iteration shelling out to git. */
export function getGitWorkingState(projectRoot: string): GitWorkingState | null {
  const now = Date.now();
  const cached = cache.get(projectRoot);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.state;

  const state = collectGitWorkingState(projectRoot);
  cache.set(projectRoot, { state, at: now });
  return state;
}

function collectGitWorkingState(projectRoot: string): GitWorkingState | null {
  if (!existsSync(join(projectRoot, '.git'))) return null;

  const branch = readBranch(projectRoot);
  if (branch === null) return null; // not really a git repo

  const isDetachedHead = branch === 'HEAD';
  const inProgress = detectInProgress(projectRoot);
  const status = readStatus(projectRoot);
  const recentCommits = readRecentCommits(projectRoot);

  return {
    branch: isDetachedHead ? `(HEAD detached)` : branch,
    isDetachedHead,
    inProgress,
    modifiedFiles: status.modifiedFiles,
    stagedFiles: status.stagedFiles,
    deletedFiles: status.deletedFiles,
    untrackedCount: status.untrackedCount,
    recentCommits,
  };
}

function readBranch(cwd: string): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function detectInProgress(projectRoot: string): RepoInProgress {
  const git = join(projectRoot, '.git');
  if (existsSync(join(git, 'rebase-merge')) || existsSync(join(git, 'rebase-apply'))) return 'rebase';
  if (existsSync(join(git, 'MERGE_HEAD'))) return 'merge';
  if (existsSync(join(git, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  return null;
}

interface PorcelainStatus {
  modifiedFiles: string[];
  stagedFiles: string[];
  deletedFiles: string[];
  untrackedCount: number;
}

// Parse `git status --porcelain=v1`. Two-char status code per line:
//   XY <path>
//   X = index/staged status, Y = working-tree status
//   '?' = untracked
function readStatus(cwd: string): PorcelainStatus {
  const out: PorcelainStatus = { modifiedFiles: [], stagedFiles: [], deletedFiles: [], untrackedCount: 0 };
  let raw: string;
  try {
    raw = execSync('git status --porcelain=v1', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
  } catch {
    return out;
  }

  for (const line of raw.split(/\r?\n/)) {
    if (line.length < 3) continue;
    const x = line[0]!;
    const y = line[1]!;
    const path = line.slice(3).trim();
    if (path.length === 0) continue;
    if (x === '?' && y === '?') {
      out.untrackedCount += 1;
      continue;
    }
    // Deletions
    if (x === 'D' || y === 'D') {
      if (out.deletedFiles.length < FILE_LIST_CAP) out.deletedFiles.push(path);
      continue;
    }
    // Newly staged (A = added in index, or staged rename/copy)
    if ((x === 'A' || x === 'R' || x === 'C') && y === ' ') {
      if (out.stagedFiles.length < FILE_LIST_CAP) out.stagedFiles.push(path);
      continue;
    }
    // Modified (covers M_ , _M , MM , AM , etc.)
    if (x === 'M' || y === 'M' || x === 'A' || x === 'R' || x === 'C') {
      if (out.modifiedFiles.length < FILE_LIST_CAP) out.modifiedFiles.push(path);
      continue;
    }
  }
  return out;
}

function readRecentCommits(cwd: string): RecentCommit[] {
  let raw: string;
  try {
    raw = execSync(`git log -${RECENT_COMMITS} --format=%h%x1f%s%x1f%ar`, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
  } catch {
    return [];
  }
  const out: RecentCommit[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const [sha, subject, relativeDate] = line.split('\x1f');
    if (!sha || !subject || !relativeDate) continue;
    out.push({
      sha,
      subject: subject.length > SUBJECT_TRUNCATE ? subject.slice(0, SUBJECT_TRUNCATE) + '…' : subject,
      relativeDate,
    });
  }
  return out;
}

/** Render the prompt's working-state block. Returns "" when state is null
 *  (non-git project) so the section disappears cleanly. */
export function renderSessionStateSection(state: GitWorkingState | null): string {
  if (state === null) return '';

  const lines: string[] = [];
  lines.push('\n## Working state\n');

  // Branch + in-progress warning up top — the agent should see it first.
  if (state.isDetachedHead) {
    lines.push(`Branch: ${state.branch} — HEAD is detached. Any commits made here will be lost unless a branch points at them.`);
  } else {
    lines.push(`Branch: ${state.branch}`);
  }
  if (state.inProgress) {
    lines.push(`\n⚠ A ${state.inProgress} is in progress — the working tree may be in an interim state. Do not start unrelated edits until the user signals it's resolved.`);
  }

  // Modified / staged / deleted — each block omitted if empty.
  if (state.stagedFiles.length > 0) {
    lines.push('\nStaged:');
    for (const p of state.stagedFiles) lines.push(`- ${p}`);
  }
  if (state.modifiedFiles.length > 0) {
    lines.push('\nModified (unstaged):');
    for (const p of state.modifiedFiles) lines.push(`- ${p}`);
  }
  if (state.deletedFiles.length > 0) {
    lines.push('\nDeleted (tracked):');
    for (const p of state.deletedFiles) lines.push(`- ${p}`);
  }
  if (state.untrackedCount > 0) {
    lines.push(`\n(${state.untrackedCount} untracked file${state.untrackedCount === 1 ? '' : 's'} not listed)`);
  }

  if (state.recentCommits.length > 0) {
    lines.push('\nRecent commits (newest first):');
    for (const c of state.recentCommits) {
      lines.push(`- ${c.sha}  ${c.subject}  · ${c.relativeDate}`);
    }
  }

  // Closing nudge that this is fresh-every-turn — useful for the agent's
  // mental model.
  lines.push('\n(This section is refreshed each turn; treat it as the live state of the working tree.)');

  return lines.join('\n');
}

/** Test-only: clear the memoization cache. */
export function _resetSessionStateCacheForTests(): void {
  cache.clear();
}
