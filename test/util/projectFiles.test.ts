import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fuzzyRankPaths, listProjectFiles } from '../../src/util/projectFiles.js';

describe('fuzzyRankPaths', () => {
  const paths = ['src/app.ts', 'src/util/parseArgs.ts', 'scripts/test.mjs', 'README.md', 'src/cli.ts', 'node_modules/x/cli.js'];

  it('lists shallow paths first for an empty query', () => {
    expect(fuzzyRankPaths(paths, '', 3)).toEqual(['README.md', 'scripts/test.mjs', 'src/app.ts']);
  });

  it('prefers basename matches and keeps every query character in order', () => {
    expect(fuzzyRankPaths(paths, 'cli')[0]).toBe('src/cli.ts');
    expect(fuzzyRankPaths(paths, 'app')[0]).toBe('src/app.ts');
    expect(fuzzyRankPaths(paths, 'parg')[0]).toBe('src/util/parseArgs.ts');
    expect(fuzzyRankPaths(paths, 'zzz')).toEqual([]);
  });

  it('is case-insensitive and honors the limit', () => {
    expect(fuzzyRankPaths(paths, 'README')).toEqual(['README.md']);
    expect(fuzzyRankPaths(paths, 's', 2)).toHaveLength(2);
  });
});

describe('listProjectFiles', () => {
  it('walks a plain folder (no git) and skips build folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'pf-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), '');
    writeFileSync(join(root, 'b.md'), '');
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), '');
    const files = listProjectFiles(root);
    expect(files).toEqual(['b.md', 'src/a.ts']);
  });
});
