import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanCommitMessage, commit, commitMessagePrompt, createWorktree, currentBranch, isGitRepo, removeWorktree, stageAll, stagedSummary } from '../../src/agent/GitWorkflow.js';
import { implementPlanMessage, looksLikePlan, planSlug, savePlan } from '../../src/agent/PlanFile.js';

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

describe('git workflow', { timeout: 40_000 }, () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-git-'));
    sh(root, ['init', '-q', '-b', 'main']);
    sh(root, ['config', 'user.email', 't@t']);
    sh(root, ['config', 'user.name', 't']);
    writeFileSync(join(root, 'a.txt'), 'one\n');
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '-m', 'init']);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('stages, summarizes and commits with a cleaned message', () => {
    expect(isGitRepo(root)).toBe(true);
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(root, 'b.txt'), 'new\n');
    expect(stageAll(root).ok).toBe(true);
    const s = stagedSummary(root);
    expect(s.files.sort()).toEqual(['a.txt', 'b.txt']);
    expect(s.stat).toContain('2 files changed');
    const prompt = commitMessagePrompt(s, 'add b');
    expect(prompt.user).toContain("The author's hint: add b");
    expect(prompt.user).toContain('```diff');
    const msg = cleanCommitMessage('```\nfeat(core): add b and extend a\n\n- adds b.txt\n```');
    expect(msg).toBe('feat(core): add b and extend a\n\n- adds b.txt');
    const r = commit(root, msg, 'Co-Authored-By: Test <t@t>');
    expect(r.ok).toBe(true);
    expect(sh(root, ['log', '-1', '--format=%B'])).toContain('Co-Authored-By: Test');
    expect(currentBranch(root)).toBe('main');
  });

  it('creates a worktree on its own branch, excluded from status, and removes it', () => {
    const wt = createWorktree(root, 'sess-1');
    expect('error' in wt).toBe(false);
    if ('error' in wt) return;
    expect(wt.created).toBe(true);
    expect(wt.branch).toBe('autocode/sess-1');
    expect(existsSync(join(wt.path, 'a.txt'))).toBe(true);
    expect(currentBranch(wt.path)).toBe('autocode/sess-1');
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('.autocode/worktrees/');
    expect(sh(root, ['status', '--porcelain'])).toBe('');
    const again = createWorktree(root, 'sess-1');
    expect('error' in again ? false : !again.created).toBe(true);
    expect(removeWorktree(root, wt.path).ok).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
  });

  it('reports a non-repository instead of throwing', () => {
    const plain = mkdtempSync(join(tmpdir(), 'autocode-nogit-'));
    expect(isGitRepo(plain)).toBe(false);
    expect('error' in createWorktree(plain, 'x')).toBe(true);
    rmSync(plain, { recursive: true, force: true });
  });
});

describe('plan files', () => {
  it('recognizes structured plans and saves them under .autocode/plans', () => {
    const plan = '# Plan\n\n1. Add the flag in cli.ts\n2. Thread it into run()\n3. Print timings\n\n' + 'Details: '.repeat(40);
    expect(looksLikePlan(plan)).toBe(true);
    expect(looksLikePlan('Can you clarify? Which file? What flag? When?')).toBe(false);
    expect(looksLikePlan('short')).toBe(false);
    expect(planSlug('Please add a --verbose flag to the CLI that prints tool timings')).toBe('verbose-flag-cli-prints-tool');
    const root = mkdtempSync(join(tmpdir(), 'autocode-plan-'));
    const rel = savePlan(root, 'add a --verbose flag', plan, new Date(2026, 8, 7, 1, 45));
    expect(rel).toBe('.autocode/plans/20260907-0145-verbose-flag.md');
    expect(readFileSync(join(root, rel), 'utf8')).toContain('> Request: add a --verbose flag');
    const second = savePlan(root, 'add a --verbose flag', plan, new Date(2026, 8, 7, 1, 45));
    expect(second).toBe('.autocode/plans/20260907-0145-verbose-flag-2.md');
    expect(implementPlanMessage(rel)).toContain(rel);
    rmSync(root, { recursive: true, force: true });
  });
});
