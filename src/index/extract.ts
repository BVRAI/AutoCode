// Symbol extraction for one file: run the language's tag query and turn the
// captures into definitions (with their enclosing definition), references
// (calls, constructions, inheritance) and import specifiers.

import type Parser from 'web-tree-sitter';
import { parse } from './parser.js';
import type { LanguageId } from './languages.js';

export type DefKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'method'
  | 'property'
  | 'module'
  | 'implementation';

export interface SymbolDef {
  kind: DefKind;
  name: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Character offsets of the declaration (nesting is decided on these, not on lines). */
  startIndex: number;
  endIndex: number;
  /** Name of the nearest enclosing definition (class for a method, …). */
  parent?: string;
  /** First line of the declaration, trimmed. */
  signature: string;
}

export interface SymbolRef {
  name: string;
  line: number;
  kind: 'call' | 'class' | 'inherit';
}

export interface FileSymbols {
  defs: SymbolDef[];
  refs: SymbolRef[];
  imports: string[];
}

const MAX_DEFS_PER_FILE = 2_000;
const MAX_REFS_PER_FILE = 5_000;
const SIGNATURE_MAX = 140;

export async function extractSymbols(lang: LanguageId, text: string): Promise<FileSymbols> {
  const { loaded, tree } = await parse(lang, text);
  try {
    return collect(loaded.query, tree.rootNode, text);
  } finally {
    tree.delete();
  }
}

function collect(query: Parser.Query, root: Parser.SyntaxNode, text: string): FileSymbols {
  const defs: SymbolDef[] = [];
  const refs: SymbolRef[] = [];
  const imports: string[] = [];
  const seenDef = new Set<string>();
  const seenImport = new Set<string>();

  for (const match of query.matches(root)) {
    let nameCap: Parser.QueryCapture | undefined;
    let bodyCap: Parser.QueryCapture | undefined;
    for (const c of match.captures) {
      if (c.name.startsWith('name.')) nameCap = c;
      else if (c.name.startsWith('definition.')) bodyCap = c;
    }
    if (!nameCap) continue;
    const parts = nameCap.name.split('.'); // name.definition.function | name.reference.call
    const role = parts[1];
    const kind = parts[2] ?? '';
    const name = nameCap.node.text.trim();
    if (name.length === 0) continue;

    if (role === 'definition') {
      if (defs.length >= MAX_DEFS_PER_FILE) continue;
      const body = bodyCap?.node ?? nameCap.node.parent ?? nameCap.node;
      const startLine = body.startPosition.row + 1;
      const endLine = body.endPosition.row + 1;
      const key = `${kind}:${name}:${startLine}`;
      if (seenDef.has(key)) continue;
      seenDef.add(key);
      defs.push({
        kind: kind as DefKind,
        name,
        startLine,
        endLine,
        startIndex: body.startIndex,
        endIndex: body.endIndex,
        signature: firstLine(text, body.startIndex, body.endIndex),
      });
    } else if (role === 'reference') {
      if (kind === 'import') {
        const spec = cleanImport(name);
        if (spec && !seenImport.has(spec)) {
          seenImport.add(spec);
          imports.push(spec);
        }
      } else if (refs.length < MAX_REFS_PER_FILE) {
        refs.push({ name, line: nameCap.node.startPosition.row + 1, kind: kind as SymbolRef['kind'] });
      }
    }
  }

  // Enclosing definition: sort by start offset (outer first), keep a stack of
  // open ranges. Offsets, not lines, so one-line files nest correctly too.
  defs.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
  const stack: SymbolDef[] = [];
  for (const d of defs) {
    while (stack.length > 0 && stack[stack.length - 1]!.endIndex <= d.startIndex) stack.pop();
    // Innermost container wins: walk the stack from the top.
    for (let i = stack.length - 1; i >= 0; i--) {
      const s = stack[i]!;
      if (s.startIndex <= d.startIndex && s.endIndex >= d.endIndex) {
        d.parent = s.name;
        break;
      }
    }
    stack.push(d);
  }
  return { defs, refs, imports };
}

function firstLine(text: string, start: number, end: number): string {
  const nl = text.indexOf('\n', start);
  const stop = nl >= 0 ? Math.min(nl, end) : end;
  const line = text.slice(start, stop).trim();
  return line.length > SIGNATURE_MAX ? `${line.slice(0, SIGNATURE_MAX - 1)}…` : line;
}

function cleanImport(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`<]|["'`>;]$/g, '')
    .replace(/;$/, '')
    .trim();
}
