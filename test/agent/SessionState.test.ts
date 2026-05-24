import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetSessionStateCacheForTests,
  getGitWorkingState,
  renderSessionStateSection,
} from '../../src/agent/SessionState.js';

// Helpers ---------------------------------------------------------------

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

function initRepo(cwd: string): void {
  sh('git init -q -b main', cwd);
  // Local identity so commits work without a global config.
  sh('git config user.email "test@example.com"', cwd);
  sh('git config user.name "Test"', cwd);
  // Disable signing if the user's global config requires it.
  sh('git config commit.gpgsign false', cwd);
}

function commit(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content, 'utf8');
  sh(`git add "${file}"`, cwd);
  sh(`git commit -q -m "${message}"`, cwd);
}

// Windows git is slow (~700ms per init/commit); under vitest's parallel
// load the suite-wide testTimeout (5s) is too tight. Each test below
// resets the cache + initialises a repo + does one or more commits; the
// per-describe timeout makes the suite robust regardless of contention.
const SESSION_TEST_TIMEOUT_MS = 25_000;

describe('getGitWorkingState', () => {
  let dir: string;
  beforeEach(() => {
    _resetSessionStateCacheForTests();
    dir = mkdtempSync(join(tmpdir(), 'autocode-session-state-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a non-git directory', () => {
    expect(getGitWorkingState(dir)).toBeNull();
  }, SESSION_TEST_TIMEOUT_MS);

  it('returns a populated state for a fresh repo with one commit', () => {
    initRepo(dir);
    commit(dir, 'a.txt', 'hello', 'initial commit');
    const s = getGitWorkingState(dir);
    expect(s).not.toBeNull();
    expect(s!.branch).toBe('main');
    expect(s!.isDetachedHead).toBe(false);
    expect(s!.inProgress).toBeNull();
    expect(s!.modifiedFiles).toEqual([]);
    expect(s!.stagedFiles).toEqual([]);
    expect(s!.recentCommits).toHaveLength(1);
    expect(s!.recentCommits[0]!.subject).toBe('initial commit');
  }, SESSION_TEST_TIMEOUT_MS);

  it('reports an unstaged modification under modifiedFiles', () => {
    initRepo(dir);
    commit(dir, 'a.txt', 'v1', 'init');
    writeFileSync(join(dir, 'a.txt'), 'v2', 'utf8');
    _resetSessionStateCacheForTests();
    const s = getGitWorkingState(dir);
    expect(s!.modifiedFiles).toEqual(['a.txt']);
    expect(s!.stagedFiles).toEqual([]);
  }, SESSION_TEST_TIMEOUT_MS);

  it('reports a newly-added staged file under stagedFiles', () => {
    initRepo(dir);
    commit(dir, 'seed.txt', 'seed', 'seed');
    writeFileSync(join(dir, 'b.txt'), 'new', 'utf8');
    sh('git add b.txt', dir);
    _resetSessionStateCacheForTests();
    const s = getGitWorkingState(dir);
    expect(s!.stagedFiles).toEqual(['b.txt']);
  }, SESSION_TEST_TIMEOUT_MS);

  it('reports a deleted tracked file under deletedFiles', () => {
    initRepo(dir);
    commit(dir, 'doomed.txt', 'bye', 'add doomed');
    rmSync(join(dir, 'doomed.txt'));
    _resetSessionStateCacheForTests();
    const s = getGitWorkingState(dir);
    expect(s!.deletedFiles).toEqual(['doomed.txt']);
  }, SESSION_TEST_TIMEOUT_MS);

  it('reports untracked files as a COUNT only, not a list', () => {
    initRepo(dir);
    commit(dir, 'seed.txt', 'seed', 'seed');
    writeFileSync(join(dir, 'noise1.txt'), '', 'utf8');
    writeFileSync(join(dir, 'noise2.txt'), '', 'utf8');
    _resetSessionStateCacheForTests();
    const s = getGitWorkingState(dir);
    expect(s!.untrackedCount).toBe(2);
    expect(s!.modifiedFiles).toEqual([]);
  }, SESSION_TEST_TIMEOUT_MS);

  it('detects an in-progress merge', () => {
    initRepo(dir);
    commit(dir, 'a.txt', 'one', 'first');
    // Simulate mid-merge by creating MERGE_HEAD (without actually merging
    // anything — the indicator file is all our detector looks at).
    writeFileSync(join(dir, '.git', 'MERGE_HEAD'), 'deadbeef\n', 'utf8');
    _resetSessionStateCacheForTests();
    const s = getGitWorkingState(dir);
    expect(s!.inProgress).toBe('merge');
  }, SESSION_TEST_TIMEOUT_MS);

  it('detects an in-progress rebase via .git/rebase-merge', () => {
    initRepo(dir);
    commit(dir, 'a.txt', 'one', 'first');
    mkdirSync(join(dir, '.git', 'rebase-merge'));
    _resetSessionStateCacheForTests();
    const s = getGitWorkingState(dir);
    expect(s!.inProgress).toBe('rebase');
  }, SESSION_TEST_TIMEOUT_MS);

  it('lists recent commits newest-first', () => {
    initRepo(dir);
    commit(dir, 'a.txt', 'a', 'first');
    commit(dir, 'b.txt', 'b', 'second');
    commit(dir, 'c.txt', 'c', 'third');
    _resetSessionStateCacheForTests();
    const s = getGitWorkingState(dir);
    expect(s!.recentCommits.map((c) => c.subject)).toEqual(['third', 'second', 'first']);
  }, SESSION_TEST_TIMEOUT_MS);

  it('caches results within the TTL', () => {
    initRepo(dir);
    commit(dir, 'a.txt', 'one', 'init');
    const a = getGitWorkingState(dir);
    const b = getGitWorkingState(dir);
    // Same reference identity proves the cache returned the prior object.
    expect(a).toBe(b);
  }, SESSION_TEST_TIMEOUT_MS);
});

describe('renderSessionStateSection', () => {
  it('returns empty string when state is null (non-git project)', () => {
    expect(renderSessionStateSection(null)).toBe('');
  });

  it('renders branch + commits + modified files in a readable shape', () => {
    const out = renderSessionStateSection({
      branch: 'main',
      isDetachedHead: false,
      inProgress: null,
      modifiedFiles: ['src/a.ts'],
      stagedFiles: [],
      deletedFiles: [],
      untrackedCount: 0,
      recentCommits: [{ sha: 'abc1234', subject: 'do a thing', relativeDate: '5 min ago' }],
    });
    expect(out).toContain('## Working state');
    expect(out).toContain('Branch: main');
    expect(out).toContain('src/a.ts');
    expect(out).toContain('abc1234');
    expect(out).toContain('do a thing');
  });

  it('surfaces the in-progress warning prominently', () => {
    const out = renderSessionStateSection({
      branch: 'main',
      isDetachedHead: false,
      inProgress: 'rebase',
      modifiedFiles: [],
      stagedFiles: [],
      deletedFiles: [],
      untrackedCount: 0,
      recentCommits: [],
    });
    expect(out).toContain('⚠');
    expect(out).toContain('rebase');
  });

  it('omits empty sections (no Staged: header when none)', () => {
    const out = renderSessionStateSection({
      branch: 'main',
      isDetachedHead: false,
      inProgress: null,
      modifiedFiles: ['x.ts'],
      stagedFiles: [],
      deletedFiles: [],
      untrackedCount: 0,
      recentCommits: [],
    });
    expect(out).toContain('Modified (unstaged)');
    expect(out).not.toContain('Staged:');
    expect(out).not.toContain('Deleted (tracked)');
  });

  it('flags a detached HEAD', () => {
    const out = renderSessionStateSection({
      branch: '(HEAD detached)',
      isDetachedHead: true,
      inProgress: null,
      modifiedFiles: [],
      stagedFiles: [],
      deletedFiles: [],
      untrackedCount: 0,
      recentCommits: [],
    });
    expect(out).toContain('HEAD is detached');
  });
});
