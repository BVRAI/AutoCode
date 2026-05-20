import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRepoMap } from '../../src/agent/RepoMap.js';

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

  it('caps the digest size on a large repo', () => {
    for (let i = 0; i < 300; i++) {
      const syms = Array.from({ length: 10 }, (_, k) => `export function fn${i}_${k}() {}`).join('\n');
      writeFileSync(join(root, `file${i}.ts`), syms);
    }
    const map = buildRepoMap(root);
    expect(map.length).toBeLessThan(6500);
    expect(map).toContain('repo map truncated');
  });
});
