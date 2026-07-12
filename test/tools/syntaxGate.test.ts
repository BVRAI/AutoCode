import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkFileSyntax,
  gateAfterWrite,
  runChecker,
  resetSyntaxGateStateForTests,
  resetPythonCacheForTests,
} from '../../src/tools/syntaxGate.js';
import { EditFileTool } from '../../src/tools/editFile.js';
import { WriteFileTool } from '../../src/tools/writeFile.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

// Is any usable python on this machine? Mirrors the gate's own probing so the
// python cases skip cleanly on python-less CI.
const pythonAvailable = (() => {
  const candidates = platform() === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-c', 'print(1)'], { timeout: 5000 });
      if (r.status === 0) return true;
    } catch {
      /* try next */
    }
  }
  return false;
})();

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'autocode-gate-'));
  resetSyntaxGateStateForTests();
  resetPythonCacheForTests();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.AUTOCODE_NO_SYNTAX_GATE;
});

function ctx(): { session: SessionContext } {
  return {
    session: {
      sessionId: 't',
      projectRoot: tmp,
      dataDir: tmp,
      sessionDir: tmp,
      model: { provider: 'xai', model: 'm' },
      startedAt: new Date().toISOString(),
      mode: 'autocode',
    },
  };
}

describe('checkFileSyntax', () => {
  it('valid JSON passes', async () => {
    const r = await checkFileSyntax(join(tmp, 'a.json'), '{"x": 1}', tmp);
    expect(r.ok).toBe(true);
    expect(r.checker).toBe('json');
  });

  it('invalid JSON fails with diagnostics', async () => {
    const r = await checkFileSyntax(join(tmp, 'a.json'), '{ nope', tmp);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  it('valid .mjs with import/export passes', async () => {
    const p = join(tmp, 'a.mjs');
    const content = "import { join } from 'node:path'; export const x = join('a','b');";
    writeFileSync(p, content, 'utf8');
    const r = await checkFileSyntax(p, content, tmp);
    expect(r.ok).toBe(true);
    expect(r.checker).toBe('node');
  }, 15_000);

  it('broken .js fails with node diagnostics', async () => {
    const p = join(tmp, 'b.js');
    const content = 'function broken( {';
    writeFileSync(p, content, 'utf8');
    const r = await checkFileSyntax(p, content, tmp);
    expect(r.ok).toBe(false);
    expect(r.checker).toBe('node');
    expect(r.diagnostics.length).toBeGreaterThan(0);
  }, 15_000);

  it('.js with ESM syntax and no type field passes via the stdin retry', async () => {
    // No package.json in tmp → .js defaults to CJS, import statement would
    // fail --check; the ESM-signature retry must absolve it.
    const p = join(tmp, 'esm.js');
    const content = "import { x } from './y.js'; export const z = x;";
    writeFileSync(p, content, 'utf8');
    const r = await checkFileSyntax(p, content, tmp);
    expect(r.ok).toBe(true);
  }, 15_000);

  it('.js with ESM syntax in a type:module project passes directly', async () => {
    writeFileSync(join(tmp, 'package.json'), '{"type":"module"}', 'utf8');
    const p = join(tmp, 'esm2.js');
    const content = "export function f() { return 1; }";
    writeFileSync(p, content, 'utf8');
    const r = await checkFileSyntax(p, content, tmp);
    expect(r.ok).toBe(true);
  }, 15_000);

  it('broken .ts fails with a line-numbered diagnostic (autocode fallback typescript)', async () => {
    const r = await checkFileSyntax(join(tmp, 'a.ts'), 'const x: = 5;\nfunction f( {', tmp);
    // autocode's own dev install has typescript resolvable; if a prod install
    // ever lacks it this becomes skipped=true — assert conditionally.
    if (!r.skipped) {
      expect(r.ok).toBe(false);
      expect(r.checker).toBe('typescript');
      expect(r.diagnostics).toMatch(/line \d+/);
    }
  });

  it('valid .ts passes without type-checking (type errors are NOT syntax errors)', async () => {
    // `const n: number = 'string'` is a TYPE error but parses fine — the gate
    // must not reject it.
    const r = await checkFileSyntax(join(tmp, 'ok.ts'), "const n: number = 'string';", tmp);
    if (!r.skipped) expect(r.ok).toBe(true);
  });

  it.skipIf(!pythonAvailable)('broken .py fails via ast.parse sentinel', async () => {
    const p = join(tmp, 'bad.py');
    writeFileSync(p, 'def broken(:\n    pass\n', 'utf8');
    const r = await checkFileSyntax(p, 'def broken(:\n    pass\n', tmp);
    expect(r.ok).toBe(false);
    expect(r.checker).toBe('python');
  }, 15_000);

  it.skipIf(!pythonAvailable)('valid .py passes', async () => {
    const p = join(tmp, 'ok.py');
    writeFileSync(p, 'def fine():\n    return 1\n', 'utf8');
    const r = await checkFileSyntax(p, 'def fine():\n    return 1\n', tmp);
    expect(r.ok).toBe(true);
  }, 15_000);

  it('.md is skipped', async () => {
    const r = await checkFileSyntax(join(tmp, 'a.md'), '# anything ((( goes', tmp);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });
});

describe('runChecker', () => {
  it('treats a timeout as failedToRun (→ skip), not a syntax failure', async () => {
    const r = await runChecker(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {
      timeoutMs: 500,
    });
    expect(r.failedToRun).toBe(true);
  }, 15_000);

  it('treats a missing binary as failedToRun', async () => {
    const r = await runChecker('definitely-not-a-real-binary-xyz', ['--version'], {});
    expect(r.failedToRun).toBe(true);
  });
});

describe('gateAfterWrite via edit_file / write_file', () => {
  it('reverts a syntax-breaking edit and keeps the original content', async () => {
    const p = join(tmp, 'a.json');
    writeFileSync(p, '{"ok": true}', 'utf8');
    const result = await new EditFileTool().execute(
      { path: 'a.json', old_text: 'true}', new_text: 'true' },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.summary).toMatch(/syntax error/);
    expect(result.content).toMatch(/reverted/);
    expect(readFileSync(p, 'utf8')).toBe('{"ok": true}');
  });

  it('write_file create that fails the gate leaves no file on disk', async () => {
    const result = await new WriteFileTool().execute(
      { path: 'new.json', content: '{ broken' },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/removed/);
    expect(existsSync(join(tmp, 'new.json'))).toBe(false);
  });

  it('a clean edit passes the gate untouched', async () => {
    const p = join(tmp, 'b.json');
    writeFileSync(p, '{"n": 1}', 'utf8');
    const result = await new EditFileTool().execute(
      { path: 'b.json', old_text: '1', new_text: '2' },
      ctx(),
    );
    expect(result.isError).toBeFalsy();
    expect(readFileSync(p, 'utf8')).toBe('{"n": 2}');
  });

  it('third consecutive failure on one file is kept with a warning, and the counter resets', async () => {
    const p = join(tmp, 'c.json');
    writeFileSync(p, '{"n": 1}', 'utf8');
    const t = new WriteFileTool();
    const bad = { path: 'c.json', content: '{ still broken', mode: 'overwrite' };
    const r1 = await t.execute(bad, ctx());
    const r2 = await t.execute(bad, ctx());
    expect(r1.isError).toBe(true);
    expect(r2.isError).toBe(true);
    const r3 = await t.execute(bad, ctx());
    expect(r3.isError).toBeFalsy();
    expect(r3.content).toMatch(/WARNING/);
    expect(readFileSync(p, 'utf8')).toBe('{ still broken');
    // Gate is re-armed: the next bad write is rejected again.
    const r4 = await t.execute({ path: 'c.json', content: '{ broken again', mode: 'overwrite' }, ctx());
    expect(r4.isError).toBe(true);
  });

  it('AUTOCODE_NO_SYNTAX_GATE=1 disables the gate', async () => {
    process.env.AUTOCODE_NO_SYNTAX_GATE = '1';
    const p = join(tmp, 'd.json');
    writeFileSync(p, '{"n": 1}', 'utf8');
    const result = await new WriteFileTool().execute(
      { path: 'd.json', content: '{ broken on purpose', mode: 'overwrite' },
      ctx(),
    );
    expect(result.isError).toBeFalsy();
    expect(readFileSync(p, 'utf8')).toBe('{ broken on purpose');
  });

  it('gateAfterWrite passes through non-checkable extensions', async () => {
    const p = join(tmp, 'notes.md');
    writeFileSync(p, 'x', 'utf8');
    const out = await gateAfterWrite({
      target: p,
      relPath: 'notes.md',
      projectRoot: tmp,
      original: '',
      existedBefore: true,
      content: 'x',
    });
    expect(out.action).toBe('pass');
  });
});
