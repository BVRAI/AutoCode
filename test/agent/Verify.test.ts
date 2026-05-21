import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVerifyCommand, runVerification } from '../../src/agent/Verify.js';

describe('resolveVerifyCommand', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autocode-verify-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const pkg = (scripts: Record<string, string>): void =>
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));

  it('uses an explicit override regardless of project type', () => {
    expect(resolveVerifyCommand(dir, 'make check')).toBe('make check');
  });

  it('trims an explicit override and ignores a blank one', () => {
    pkg({ test: 'vitest run' });
    expect(resolveVerifyCommand(dir, '  npm run lint  ')).toBe('npm run lint');
    expect(resolveVerifyCommand(dir, '   ')).toBe('npm test');
  });

  it('prefers a real test script for a node project', () => {
    pkg({ test: 'vitest run', build: 'tsc' });
    expect(resolveVerifyCommand(dir)).toBe('npm test');
  });

  it('falls through to build when the test script is npm\'s placeholder', () => {
    pkg({ test: 'echo "Error: no test specified" && exit 1', build: 'tsc' });
    expect(resolveVerifyCommand(dir)).toBe('npm run build');
  });

  it('falls through to tsc when there is only a tsconfig', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    expect(resolveVerifyCommand(dir)).toBe('npx tsc --noEmit');
  });

  it('returns null for a node project with nothing to run', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    expect(resolveVerifyCommand(dir)).toBeNull();
  });

  it('infers cargo check for a rust project', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]');
    expect(resolveVerifyCommand(dir)).toBe('cargo check');
  });

  it('infers go build for a go project', () => {
    writeFileSync(join(dir, 'go.mod'), 'module x');
    expect(resolveVerifyCommand(dir)).toBe('go build ./...');
  });

  it('returns null for an unknown / python project (requires explicit config)', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"');
    expect(resolveVerifyCommand(dir)).toBeNull();
    expect(resolveVerifyCommand(dir)).toBeNull();
  });
});

describe('runVerification', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autocode-verify-run-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports ok for a command that exits 0', async () => {
    const r = await runVerification('node -e "process.exit(0)"', dir, () => false);
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
  });

  it('reports failure and captures output for a non-zero exit', async () => {
    const r = await runVerification(
      'node -e "console.log(\'boom\'); process.exit(3)"',
      dir,
      () => false,
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
    expect(r.output).toContain('boom');
  });
});
