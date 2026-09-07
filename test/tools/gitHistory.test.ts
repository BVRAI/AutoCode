import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchCommitsTool, ShowCommitTool } from '../../src/tools/gitHistory.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

let root: string;
let plain: string;

function session(dir: string): SessionContext {
  return { sessionId: 's', projectRoot: dir, dataDir: join(dir, 'data'), sessionDir: join(dir, 'session'), model: { provider: 'xai', model: 'm' }, startedAt: new Date().toISOString(), mode: 'autocode' };
}

function run(args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x' } });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'autocode-githist-'));
  plain = mkdtempSync(join(tmpdir(), 'autocode-githist-plain-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  run(['init', '-q']);
  writeFileSync(join(root, 'src', 'login.ts'), 'export function login() { return 1; }\n');
  writeFileSync(join(root, 'README.md'), '# demo\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'Add login page']);
  writeFileSync(join(root, 'src', 'login.ts'), 'export function login() { return rememberEmail(); }\nfunction rememberEmail() { return 2; }\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'Remember the email on the login page']);
  writeFileSync(join(root, 'README.md'), '# demo\n\nmore\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'Docs: expand readme']);
});

afterAll(() => {
  for (const d of [root, plain]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* windows */
    }
  }
});

describe('git history tools', () => {
  it('search_commits matches messages, case-insensitively, newest first', async () => {
    const r = await new SearchCommitsTool().execute({ query: 'login' }, { session: session(root) });
    expect(r.isError).toBeFalsy();
    const lines = r.content.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/Remember the email on the login page$/);
    expect(lines[1]).toMatch(/Add login page$/);
    expect(lines[0]).toMatch(/^[0-9a-f]{7,}  \d{4}-\d{2}-\d{2}  Test  /);
    expect(r.summary).toBe('2 commits match messages for "login"');
  });

  it('search_commits searches diffs with in_diff and filters by path', async () => {
    const byDiff = await new SearchCommitsTool().execute({ query: 'rememberEmail', in_diff: true }, { session: session(root) });
    expect(byDiff.content.split('\n')).toHaveLength(1);
    expect(byDiff.content).toMatch(/Remember the email/);
    const byPath = await new SearchCommitsTool().execute({ query: 'readme', path: 'README.md' }, { session: session(root) });
    expect(byPath.content.split('\n')).toHaveLength(1);
    expect(byPath.content).toMatch(/Docs: expand readme/);
    const none = await new SearchCommitsTool().execute({ query: 'nothing-like-this' }, { session: session(root) });
    expect(none.content).toMatch(/no commits match/);
  });

  it('show_commit returns the message, stat and diff, capped by max_lines and path', async () => {
    const found = await new SearchCommitsTool().execute({ query: 'Remember' }, { session: session(root) });
    const sha = found.content.split('  ')[0]!;
    const r = await new ShowCommitTool().execute({ sha }, { session: session(root) });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Remember the email on the login page');
    expect(r.content).toContain('src/login.ts');
    expect(r.content).toContain('+function rememberEmail()');
    const capped = await new ShowCommitTool().execute({ sha, max_lines: 20, path: 'src' }, { session: session(root) });
    expect(capped.content.split('\n').length).toBeLessThanOrEqual(22);
  });

  it('rejects bad references and reports a non-repository', async () => {
    const bad = await new ShowCommitTool().execute({ sha: '--output=x' }, { session: session(root) });
    expect(bad.isError).toBe(true);
    const nope = await new SearchCommitsTool().execute({ query: 'x' }, { session: session(plain) });
    expect(nope.isError).toBe(true);
    expect(nope.content).toMatch(/not a git repository/);
  });
});
