import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CodeIndex } from '../../src/index/CodeIndex.js';
import { mentionEntries, rankSymbols, resolveSymbolMention } from '../../src/util/symbolMentions.js';
import { buildAgentInput } from '../../src/util/attachments.js';

let root: string;
let dataDir: string;
let index: CodeIndex;

function write(rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'autocode-symbols-'));
  dataDir = mkdtempSync(join(tmpdir(), 'autocode-symbols-data-'));
  process.env.AUTOCODE_DATA_DIR = dataDir;
  write(
    'src/greet.ts',
    ['export function greet(name: string): string {', "  return `hello ${name}`;", '}', '', 'export function farewell(name: string): string {', "  return `bye ${name}`;", '}', ''].join('\n'),
  );
  write('src/app.ts', ['export class App {', '  render(): string {', "    return 'app';", '  }', '}', ''].join('\n'));
  // The same name in two files: a bare mention is ambiguous.
  write('src/a/helper.ts', 'export function helper(): number { return 1; }\n');
  write('src/b/helper.ts', 'export function helper(): number { return 2; }\n');
  index = await CodeIndex.open(root);
}, 60_000);

afterAll(() => {
  delete process.env.AUTOCODE_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('symbol @-mentions', () => {
  it('inlines a unique definition with its source', () => {
    const r = resolveSymbolMention(index, 'greet');
    expect(r).not.toBeNull();
    expect(r!.block).toContain('<symbol ref="greet">');
    expect(r!.block).toContain('src/greet.ts:1');
    expect(r!.block).toContain('hello ${name}');
    expect(r!.block).not.toContain('bye ${name}');
    expect(r!.note).toMatch(/@greet: function greet at src\/greet\.ts:1/);
  });

  it('resolves path#name and dotted names', () => {
    expect(resolveSymbolMention(index, 'src/a/helper.ts#helper')!.block).toContain('return 1');
    expect(resolveSymbolMention(index, 'App.render')!.block).toContain("return 'app'");
  });

  it('lists candidates when a bare name is ambiguous', () => {
    const r = resolveSymbolMention(index, 'helper');
    expect(r).not.toBeNull();
    expect(r!.block).toContain('candidates="2"');
    expect(r!.block).toContain('src/a/helper.ts:1');
    expect(r!.block).toContain('src/b/helper.ts:1');
    expect(r!.note).toMatch(/2 definitions match/);
  });

  it('returns null for names the index does not know and for files', () => {
    expect(resolveSymbolMention(index, 'nope')).toBeNull();
    expect(resolveSymbolMention(index, 'src/greet.ts')).toBeNull();
  });

  it('ranks symbols for the picker and pins ambiguous names to their file', () => {
    const hits = rankSymbols(index, 'gre');
    expect(hits[0]?.insert).toBe('greet');
    expect(hits[0]?.label).toMatch(/^greet {2}function greet — src\/greet\.ts:1/);
    const helpers = rankSymbols(index, 'helper');
    expect(helpers.length).toBeGreaterThanOrEqual(2);
    expect(helpers.every((h) => /^src\/[ab]\/helper\.ts#helper$/.test(h.insert))).toBe(true);
    expect(rankSymbols(index, 'g')).toEqual([]);
  });

  it('merges files and symbols for the picker without duplicates', () => {
    const entries = mentionEntries(['src/greet.ts'], rankSymbols(index, 'greet'));
    expect(entries[0]).toEqual({ insert: 'src/greet.ts', label: 'src/greet.ts', kind: 'file' });
    expect(entries.some((e) => e.kind === 'symbol' && e.insert === 'greet')).toBe(true);
  });

  it('buildAgentInput inlines symbol mentions and still reports unknown ones', () => {
    const r = buildAgentInput('explain @greet and @nothing', root, { index });
    expect(typeof r.input).toBe('string');
    expect(r.input as string).toContain('<symbol ref="greet">');
    expect(r.missing).toEqual(['nothing']);
    expect(r.notes.some((n) => n.startsWith('@greet:'))).toBe(true);
  });
});
