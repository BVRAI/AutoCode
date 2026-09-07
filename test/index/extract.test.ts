import { describe, it, expect } from 'vitest';
import { extractSymbols } from '../../src/index/extract.js';
import { languageForPath, isTextPath } from '../../src/index/languages.js';

describe('languageForPath', () => {
  it('maps extensions to grammars and flags text files', () => {
    expect(languageForPath('src/a.ts')).toBe('typescript');
    expect(languageForPath('src/a.tsx')).toBe('tsx');
    expect(languageForPath('x.cs')).toBe('c_sharp');
    expect(languageForPath('x.h')).toBe('c');
    expect(languageForPath('x.unknown')).toBeNull();
    expect(isTextPath('README.md')).toBe(true);
    expect(isTextPath('a.ts')).toBe(false);
  });
});

describe('extractSymbols', () => {
  it('TypeScript: classes, methods with their parent, functions, arrows, calls, imports, inheritance', async () => {
    const src = [
      "import { x } from './x.js';",
      "export * from './y.js';",
      'export interface Args { a: string }',
      'type Id = string;',
      'enum Color { Red }',
      'abstract class Base {}',
      'export class App extends Base implements Args {',
      '  render(): void { this.run(); helper(1); }',
      '}',
      'export function run(a: Args): void { new App(); }',
      'const arrow = (n: number) => n + 1;',
    ].join('\n');
    const s = await extractSymbols('typescript', src);
    const names = s.defs.map((d) => `${d.kind}:${d.name}${d.parent ? `<${d.parent}` : ''}`);
    expect(names).toEqual([
      'interface:Args',
      'type:Id',
      'enum:Color',
      'class:Base',
      'class:App',
      'method:render<App',
      'function:run',
      'function:arrow',
    ]);
    const app = s.defs.find((d) => d.name === 'App')!;
    expect(app.startLine).toBe(7);
    expect(app.endLine).toBe(9);
    // The `export` keyword belongs to the wrapping export_statement node.
    expect(app.signature).toBe('class App extends Base implements Args {');
    expect(s.refs.map((r) => `${r.kind}:${r.name}`)).toEqual([
      'inherit:Base',
      'inherit:Args',
      'call:run',
      'call:helper',
      'class:App',
    ]);
    expect(s.imports).toEqual(['./x.js', './y.js']);
  });

  it('TSX and JavaScript', async () => {
    const tsx = await extractSymbols('tsx', 'export function View() { return <div onClick={() => go()}>hi</div>; }');
    expect(tsx.defs[0]).toMatchObject({ kind: 'function', name: 'View' });
    expect(tsx.refs.map((r) => r.name)).toContain('go');
    const js = await extractSymbols('javascript', "import a from './a.js';\nclass Foo extends Bar { bar() { baz(); } }\nconst f = () => 1;");
    expect(js.defs.map((d) => `${d.kind}:${d.name}`)).toEqual(['class:Foo', 'method:bar', 'function:f']);
    expect(js.refs.map((r) => `${r.kind}:${r.name}`)).toEqual(['inherit:Bar', 'call:baz']);
    expect(js.imports).toEqual(['./a.js']);
  });

  it('Python', async () => {
    const s = await extractSymbols('python', 'import os\nfrom a.b import c\nclass Foo(Base):\n    def bar(self):\n        baz()\n        self.qux()\n\ndef top():\n    return Foo()\n');
    expect(s.defs.map((d) => `${d.kind}:${d.name}${d.parent ? `<${d.parent}` : ''}`)).toEqual(['class:Foo', 'function:bar<Foo', 'function:top']);
    expect(s.refs.map((r) => `${r.kind}:${r.name}`)).toEqual(['inherit:Base', 'call:baz', 'call:qux', 'call:Foo']);
    expect(s.imports).toEqual(['os', 'a.b']);
  });

  it('Go, Rust, Java', async () => {
    const go = await extractSymbols('go', 'package main\nimport "fmt"\ntype S struct{}\nfunc (s *S) M() { fmt.Println("x") }\nfunc top() { helper() }\n');
    expect(go.defs.map((d) => `${d.kind}:${d.name}`)).toEqual(['type:S', 'method:M', 'function:top']);
    expect(go.imports).toEqual(['fmt']);
    const rust = await extractSymbols('rust', 'use std::io;\nstruct S;\ntrait T { fn f(&self); }\nimpl S { fn new() -> S { helper(); S::make(); S } }\n');
    expect(rust.defs.map((d) => `${d.kind}:${d.name}${d.parent ? `<${d.parent}` : ''}`)).toEqual([
      'class:S',
      'interface:T',
      'function:f<T',
      'implementation:S',
      'function:new<S',
    ]);
    expect(rust.refs.map((r) => r.name)).toEqual(['helper', 'make']);
    const java = await extractSymbols('java', 'import java.util.List;\nclass Foo extends Bar implements Baz { Foo() {} void m() { helper(); new Foo(); } }\n');
    expect(java.defs.map((d) => `${d.kind}:${d.name}`)).toEqual(['class:Foo', 'method:Foo', 'method:m']);
    expect(java.refs.map((r) => `${r.kind}:${r.name}`)).toEqual(['inherit:Bar', 'inherit:Baz', 'call:helper', 'class:Foo']);
    expect(java.imports).toEqual(['java.util.List']);
  });

  it('C#, C, C++', async () => {
    const cs = await extractSymbols(
      'c_sharp',
      'using System;\nnamespace N { class Foo : Bar { public int P { get; set; } void M() { Helper(); this.Other(); new Foo(); } } interface I {} }\n',
    );
    expect(cs.defs.map((d) => `${d.kind}:${d.name}${d.parent ? `<${d.parent}` : ''}`)).toEqual([
      'module:N',
      'class:Foo<N',
      'property:P<Foo',
      'method:M<Foo',
      'interface:I<N',
    ]);
    expect(cs.refs.map((r) => `${r.kind}:${r.name}`)).toEqual(['inherit:Bar', 'call:Helper', 'call:Other', 'class:Foo']);
    expect(cs.imports).toEqual(['System']);
    const c = await extractSymbols('c', '#include <stdio.h>\nstruct S { int a; };\nint helper(int x) { return x; }\nint main(void) { helper(1); return 0; }\n');
    expect(c.defs.map((d) => `${d.kind}:${d.name}`)).toEqual(['class:S', 'function:helper', 'function:main']);
    expect(c.imports).toEqual(['stdio.h']);
    const cpp = await extractSymbols('cpp', 'namespace ns { class C { public: void m(); }; void C::m() { helper(); } }\n');
    expect(cpp.defs.map((d) => `${d.kind}:${d.name}${d.parent ? `<${d.parent}` : ''}`)).toEqual(['module:ns', 'class:C<ns', 'method:m<ns']);
  });

  it('Ruby and PHP', async () => {
    const rb = await extractSymbols('ruby', 'module M\n  class Foo < Bar\n    def bar\n      baz\n    end\n    def self.make; end\n  end\nend\n');
    expect(rb.defs.map((d) => `${d.kind}:${d.name}${d.parent ? `<${d.parent}` : ''}`)).toEqual(['module:M', 'class:Foo<M', 'method:bar<Foo', 'method:make<Foo']);
    expect(rb.refs.map((r) => `${r.kind}:${r.name}`)).toContain('inherit:Bar');
    const php = await extractSymbols('php', '<?php\nclass Foo extends Bar { function m() { helper(); $this->other(); } }\nfunction top() { new Foo(); }\n');
    expect(php.defs.map((d) => `${d.kind}:${d.name}${d.parent ? `<${d.parent}` : ''}`)).toEqual(['class:Foo', 'method:m<Foo', 'function:top']);
    expect(php.refs.map((r) => `${r.kind}:${r.name}`)).toEqual(['inherit:Bar', 'call:helper', 'call:other', 'class:Foo']);
  });
});
