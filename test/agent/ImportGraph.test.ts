import { describe, it, expect } from 'vitest';
import {
  buildImportGraph,
  extractImportSpecifiers,
  pageRank,
  resolveImport,
} from '../../src/agent/ImportGraph.js';

describe('extractImportSpecifiers', () => {
  it('extracts esm import / export-from / bare / dynamic / require specifiers', () => {
    const text = [
      "import { a } from './a.js';",
      "import def from '../lib/def';",
      "export { b } from './b';",
      "import './side-effect';",
      "const c = require('./c');",
      "const d = await import('./d.js');",
      "import pkg from 'external-package';", // non-relative — dropped
    ].join('\n');
    const specs = extractImportSpecifiers(text, '.ts');
    expect(specs).toContain('./a.js');
    expect(specs).toContain('../lib/def');
    expect(specs).toContain('./b');
    expect(specs).toContain('./side-effect');
    expect(specs).toContain('./c');
    expect(specs).toContain('./d.js');
    expect(specs).not.toContain('external-package');
  });

  it('extracts python from-imports and plain imports', () => {
    const text = 'from .sibling import thing\nfrom ..pkg import x\nimport utils.helpers\n';
    const specs = extractImportSpecifiers(text, '.py');
    expect(specs).toContain('.sibling');
    expect(specs).toContain('..pkg');
    expect(specs).toContain('utils.helpers');
  });

  it('extracts rust mod declarations and crate uses', () => {
    const text = 'mod parser;\npub mod lexer;\nuse crate::ast::Node;\n';
    const specs = extractImportSpecifiers(text, '.rs');
    expect(specs).toContain('mod:parser');
    expect(specs).toContain('mod:lexer');
    expect(specs).toContain('crate:ast/Node');
  });
});

describe('resolveImport', () => {
  it('resolves a NodeNext .js specifier to the .ts file', () => {
    const files = new Set(['src/agent/RepoMap.ts', 'src/tools/listDirectory.ts']);
    expect(resolveImport('../tools/listDirectory.js', 'src/agent/RepoMap.ts', files)).toBe(
      'src/tools/listDirectory.ts',
    );
  });

  it('resolves ./dir to dir/index.ts', () => {
    const files = new Set(['src/lib/index.ts', 'src/main.ts']);
    expect(resolveImport('./lib', 'src/main.ts', files)).toBe('src/lib/index.ts');
  });

  it('resolves extensionless specifiers by probing extensions', () => {
    const files = new Set(['src/a.tsx', 'src/b.ts']);
    expect(resolveImport('./a', 'src/b.ts', files)).toBe('src/a.tsx');
  });

  it('returns null when .. escapes the project root', () => {
    expect(resolveImport('../../outside', 'a.ts', new Set(['a.ts']))).toBeNull();
  });

  it('resolves a python relative from-import to a sibling module', () => {
    const files = new Set(['pkg/mod.py', 'pkg/sibling.py']);
    expect(resolveImport('.sibling', 'pkg/mod.py', files)).toBe('pkg/sibling.py');
  });

  it('resolves a python absolute import via src/ prefix and __init__', () => {
    const files = new Set(['src/utils/__init__.py', 'src/main.py']);
    expect(resolveImport('utils', 'src/main.py', files)).toBe('src/utils/__init__.py');
  });

  it('resolves rust mod to x.rs and x/mod.rs', () => {
    const flat = new Set(['src/main.rs', 'src/parser.rs']);
    expect(resolveImport('mod:parser', 'src/main.rs', flat)).toBe('src/parser.rs');
    const nested = new Set(['src/main.rs', 'src/lexer/mod.rs']);
    expect(resolveImport('mod:lexer', 'src/main.rs', nested)).toBe('src/lexer/mod.rs');
  });

  it('resolves use crate:: by stripping trailing item segments', () => {
    const files = new Set(['src/ast.rs', 'src/main.rs']);
    expect(resolveImport('crate:ast/Node', 'src/main.rs', files)).toBe('src/ast.rs');
  });
});

describe('pageRank + buildImportGraph', () => {
  it('ranks a hub imported by everything highest', () => {
    const texts: Record<string, string> = {
      'core.ts': "import { u } from './util.js';",
      'a.ts': "import { c } from './core.js';",
      'b.ts': "import { c } from './core.js';",
      'c.ts': "import { c } from './core.js';",
      'util.ts': 'export const u = 1;',
      'orphan.ts': 'export const o = 1;',
    };
    const g = buildImportGraph(Object.keys(texts), (rel) => texts[rel] ?? null);
    expect(g.importers.get('core.ts')).toHaveLength(3);
    expect(g.imports.get('core.ts')).toEqual(['util.ts']);
    const rank = (f: string): number => g.rank.get(f)!;
    expect(rank('core.ts')).toBeGreaterThan(rank('orphan.ts'));
    // util.ts inherits importance from core.ts (hub-of-hubs effect PageRank
    // captures and raw in-degree misses — both have in-degree ≤ 1).
    expect(rank('util.ts')).toBeGreaterThan(rank('orphan.ts'));
  });

  it('is deterministic across runs', () => {
    const nodes = ['a', 'b', 'c'];
    const edges = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', []],
    ]);
    const r1 = pageRank(nodes, edges);
    const r2 = pageRank(nodes, edges);
    expect([...r1.entries()]).toEqual([...r2.entries()]);
  });

  it('excludes self-imports and handles empty inputs', () => {
    const g = buildImportGraph(['self.ts'], () => "import { x } from './self.js';");
    expect(g.imports.get('self.ts')).toEqual([]);
    expect(pageRank([], new Map()).size).toBe(0);
  });
});
