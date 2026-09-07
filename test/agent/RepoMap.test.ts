import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRepoMap, getImportGraph, repoFileCount } from '../../src/agent/RepoMap.js';

describe('RepoMap', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-repomap-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('extracts top-level symbols from a TypeScript file', () => {
    writeFileSync(
      join(root, 'a.ts'),
      'export function doThing() {}\nexport class Widget {}\nfunction helperLocal() {}\nexport const SETTING = 1;\ninterface Shape {}\n',
    );
    const map = buildRepoMap(root);
    expect(map).toContain('a.ts');
    for (const sym of ['doThing', 'Widget', 'helperLocal', 'SETTING', 'Shape']) {
      expect(map).toContain(sym);
    }
  });

  it('skips indented (member / local) declarations', () => {
    writeFileSync(
      join(root, 'b.ts'),
      'export class C {}\nconst local = function inner() {};\n  function indented() {}\n',
    );
    const map = buildRepoMap(root);
    expect(map).toContain('C');
    expect(map).not.toContain('inner');
    expect(map).not.toContain('indented');
  });

  it('extracts Python def and class', () => {
    writeFileSync(join(root, 's.py'), 'def run():\n    pass\nclass Engine:\n    pass\n');
    const map = buildRepoMap(root);
    expect(map).toContain('run');
    expect(map).toContain('Engine');
  });

  it('skips noise directories like node_modules', () => {
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'junk.js'), 'export function junk(){}');
    writeFileSync(join(root, 'real.js'), 'export function real(){}');
    const map = buildRepoMap(root);
    expect(map).toContain('real.js');
    expect(map).not.toContain('junk');
  });

  it('lists css/html source files without symbols', () => {
    writeFileSync(join(root, 'index.html'), '<html></html>');
    writeFileSync(join(root, 'style.css'), 'body{}');
    const map = buildRepoMap(root);
    expect(map).toContain('index.html');
    expect(map).toContain('style.css');
  });

  it('repoFileCount counts scanned source files only', () => {
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'c.ts'), 'export const c = 3;\n');
    writeFileSync(join(root, 'notes.txt'), 'not a source file');
    expect(repoFileCount(root)).toBe(3);
  });

  // 300-file fixtures: slow under a loaded full-suite run (tree-sitter tests
  // in sibling workers), so give them room instead of racing the default 5 s.
  it('caps the digest size on a large repo', { timeout: 40_000 }, () => {
    for (let i = 0; i < 300; i++) {
      const syms = Array.from({ length: 10 }, (_, k) => `export function fn${i}_${k}() {}`).join('\n');
      writeFileSync(join(root, `file${i}.ts`), syms);
    }
    const map = buildRepoMap(root);
    expect(map.length).toBeLessThan(6500);
    expect(map).toContain('repo map truncated');
  });

  // ── Importance ranking (import graph + PageRank) ────────────────────────

  function writeRankedFixture(dir: string): void {
    // core.ts is imported by a/b/c; util.ts only by core; orphan.ts by nobody.
    writeFileSync(join(dir, 'core.ts'), "import { u } from './util.js';\nexport function core() {}\n");
    writeFileSync(join(dir, 'util.ts'), 'export const u = 1;\n');
    writeFileSync(join(dir, 'a.ts'), "import { core } from './core.js';\nexport function fa() {}\n");
    writeFileSync(join(dir, 'b.ts'), "import { core } from './core.js';\nexport function fb() {}\n");
    writeFileSync(join(dir, 'c.ts'), "import { core } from './core.js';\nexport function fc() {}\n");
    writeFileSync(join(dir, 'orphan.ts'), 'export function fo() {}\n');
  }

  it('orders the digest by importance, hub first', () => {
    writeRankedFixture(root);
    const map = buildRepoMap(root);
    const firstLine = map.split('\n')[0]!;
    expect(firstLine).toContain('core.ts');
    expect(map.indexOf('core.ts')).toBeLessThan(map.indexOf('orphan.ts'));
  });

  it('annotates multi-importer files with their in-degree', () => {
    writeRankedFixture(root);
    const map = buildRepoMap(root);
    expect(map).toContain('(imported by 3)');
    // Single-importer files are not annotated (noise).
    expect(map).not.toContain('(imported by 1)');
  });

  it('keeps unfit files visible as bare paths under an other-files divider', { timeout: 40_000 }, () => {
    for (let i = 0; i < 300; i++) {
      const syms = Array.from({ length: 10 }, (_, k) => `export function g${i}_${k}() {}`).join('\n');
      writeFileSync(join(root, `mod${i}.ts`), syms);
    }
    const map = buildRepoMap(root);
    expect(map).toContain('— other files —');
  });

  it('exposes the import graph via getImportGraph', () => {
    writeRankedFixture(root);
    const g = getImportGraph(root);
    expect(g.importers.get('core.ts')).toHaveLength(3);
    expect(g.imports.get('core.ts')).toEqual(['util.ts']);
  });
});
