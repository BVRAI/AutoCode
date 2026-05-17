import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv } from '../../src/util/dotenv.js';

describe('loadDotEnv', () => {
  let tmp: string;
  const before = { ...process.env };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'autocode-dotenv-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...before };
  });

  it('reports zero loaded when no .env exists', () => {
    expect(loadDotEnv(tmp).loaded).toBe(0);
  });

  it('loads simple KEY=VALUE pairs', () => {
    writeFileSync(join(tmp, '.env'), 'AUTOCODE_TEST_FOO=bar\nAUTOCODE_TEST_BAZ=qux\n');
    const r = loadDotEnv(tmp);
    expect(r.loaded).toBe(2);
    expect(process.env.AUTOCODE_TEST_FOO).toBe('bar');
    expect(process.env.AUTOCODE_TEST_BAZ).toBe('qux');
  });

  it('skips comments and blank lines', () => {
    writeFileSync(
      join(tmp, '.env'),
      '# a comment\n\nAUTOCODE_TEST_REAL=v\n  # indented comment\n',
    );
    expect(loadDotEnv(tmp).loaded).toBe(1);
    expect(process.env.AUTOCODE_TEST_REAL).toBe('v');
  });

  it('strips a single layer of surrounding quotes', () => {
    writeFileSync(
      join(tmp, '.env'),
      `AUTOCODE_TEST_DQ="hello world"\nAUTOCODE_TEST_SQ='single quoted'\n`,
    );
    loadDotEnv(tmp);
    expect(process.env.AUTOCODE_TEST_DQ).toBe('hello world');
    expect(process.env.AUTOCODE_TEST_SQ).toBe('single quoted');
  });

  it('does not override an already-set env var', () => {
    process.env.AUTOCODE_TEST_PRESET = 'preset-value';
    writeFileSync(join(tmp, '.env'), 'AUTOCODE_TEST_PRESET=overridden\n');
    const r = loadDotEnv(tmp);
    expect(r.loaded).toBe(0);
    expect(process.env.AUTOCODE_TEST_PRESET).toBe('preset-value');
  });
});
