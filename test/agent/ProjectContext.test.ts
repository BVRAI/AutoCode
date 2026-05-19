import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProjectContext, formatContextLine } from '../../src/agent/ProjectContext.js';

describe('detectProjectContext', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autocode-pc-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty types and no git for a bare directory', () => {
    const ctx = detectProjectContext(dir);
    expect(ctx.types).toEqual([]);
    expect(ctx.git).toBeNull();
  });

  it('detects node from package.json', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    expect(detectProjectContext(dir).types).toContain('node');
  });

  it('detects typescript from .ts files', () => {
    writeFileSync(join(dir, 'index.ts'), 'export {};');
    expect(detectProjectContext(dir).types).toContain('typescript');
  });

  it('detects python from pyproject.toml', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"');
    expect(detectProjectContext(dir).types).toContain('python');
  });

  it('detects rust from Cargo.toml', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]');
    expect(detectProjectContext(dir).types).toContain('rust');
  });

  it('detects go from go.mod', () => {
    writeFileSync(join(dir, 'go.mod'), 'module x');
    expect(detectProjectContext(dir).types).toContain('go');
  });

  it('detects dotnet from .csproj', () => {
    writeFileSync(join(dir, 'thing.csproj'), '<Project />');
    expect(detectProjectContext(dir).types).toContain('dotnet');
  });

  it('detects git when .git directory exists', () => {
    mkdirSync(join(dir, '.git'));
    const ctx = detectProjectContext(dir);
    expect(ctx.git).not.toBeNull();
  });
});

describe('formatContextLine', () => {
  it('produces a readable summary', () => {
    const line = formatContextLine({
      root: '/x',
      types: ['node', 'typescript'],
      git: { branch: 'main', dirty: 0 },
    });
    expect(line).toBe('node, typescript · git@main (clean)');
  });

  it('shows dirty count when modifications exist', () => {
    const line = formatContextLine({
      root: '/x',
      types: ['rust'],
      git: { branch: 'feature', dirty: 5 },
    });
    expect(line).toBe('rust · git@feature (5 modified)');
  });

  it('omits the git suffix when not a git repo', () => {
    const line = formatContextLine({ root: '/x', types: ['python'], git: null });
    expect(line).toBe('python');
  });
});
