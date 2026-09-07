// `lsp` — precise navigation through a language server when one is
// available: go to definition, find references, hover types, diagnostics
// and a file's symbol outline. The tree-sitter index is the default; this
// is the precision layer for the cases name-based resolution gets wrong
// (re-exports, overloads, generics, path aliases).

import { readFileSync } from 'node:fs';
import { resolveInsideRoot, toRelative } from '../util/pathSafety.js';
import { LspClient, type LspDiagnostic, type LspDocumentSymbol, type LspLocation, type LspLocationLink } from '../lsp/LspClient.js';
import { clientForFile, lspDisabled } from '../lsp/LspManager.js';
import { optionalNumber, optionalString, requireString, type Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from './types.js';

const MAX_LOCATIONS = 50;
const MAX_DIAGNOSTICS = 100;
const MAX_SYMBOLS = 200;
const DIAGNOSTICS_WAIT_MS = 2_500;
const FIRST_OPEN_WAIT_MS = 15_000;

const DEFINITION: ToolDefinition = {
  name: 'lsp',
  description:
    'Ask the project\'s language server (TypeScript/JavaScript, Python, C#, Go, Rust when installed) for precise answers: ' +
    'operation "definition" (where a symbol is defined), "references" (every use), "hover" (its type and doc), ' +
    '"diagnostics" (errors and warnings in a file, without running the compiler), or "symbols" (a file\'s outline). ' +
    'Give path plus line and column (1-based), or path plus symbol (the first occurrence on line, or in the file). ' +
    'Use it when the code index\'s name-based answer could be wrong: re-exports, overloads, path aliases, generics. ' +
    'Fails with an install hint when no server is available.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['definition', 'references', 'hover', 'diagnostics', 'symbols'], description: 'What to ask.' },
      path: { type: 'string', description: 'File path relative to the project root.' },
      line: { type: 'number', description: '1-based line of the symbol (definition/references/hover).' },
      column: { type: 'number', description: '1-based column of the symbol; optional when symbol is given.' },
      symbol: { type: 'string', description: 'Identifier to locate on the line (or anywhere in the file when line is omitted).' },
    },
    required: ['operation', 'path'],
  },
};

type Operation = 'definition' | 'references' | 'hover' | 'diagnostics' | 'symbols';

export class LspTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    if (lspDisabled()) return { summary: 'lsp disabled', content: 'The lsp tool is disabled (AUTOCODE_NO_LSP=1).', isError: true };
    const operation = requireString(args, 'operation') as Operation;
    const rel = requireString(args, 'path');
    const root = ctx.session.projectRoot;
    const abs = resolveInsideRoot(root, rel);
    const shown = toRelative(root, abs) || rel;
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      return { summary: `cannot read ${shown}`, content: `cannot read ${shown}`, isError: true };
    }
    let client: LspClient;
    try {
      client = await clientForFile(root, abs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { summary: 'no language server', content: msg, isError: true };
    }
    const opened = client.openDocument(abs);
    const uri = opened.uri;
    // First open: let the server finish loading the project (reported as
    // work-done progress) so answers come from types, not syntax alone.
    if (opened.fresh && operation !== 'diagnostics') await client.waitForProjectLoad(FIRST_OPEN_WAIT_MS);

    try {
      switch (operation) {
        case 'diagnostics': {
          const list = await client.waitForDiagnostics(uri, DIAGNOSTICS_WAIT_MS);
          return renderDiagnostics(shown, list);
        }
        case 'symbols': {
          const result = (await client.request<LspDocumentSymbol[] | Array<{ name: string; kind: number; location: LspLocation }> | null>('textDocument/documentSymbol', { textDocument: { uri } })) ?? [];
          return renderSymbols(shown, result);
        }
        case 'definition':
        case 'references':
        case 'hover': {
          const pos = locate(text, args);
          if ('error' in pos) return { summary: pos.error, content: pos.error, isError: true };
          // LSP positions sit between characters; one step into the identifier
          // is unambiguous where its first column can read as "just before it".
          const inside = { line: pos.line, character: pos.character + (identifierLengthAt(text, pos) > 1 ? 1 : 0) };
          const params = { textDocument: { uri }, position: inside, context: { includeDeclaration: true } };
          if (operation === 'hover') {
            let hover = await client.request<{ contents: unknown } | null>('textDocument/hover', params);
            let body = hoverText(hover?.contents).trim();
            let via = '';
            // Hovering a symbol that came in through an import shows the alias
            // ("import foo"); follow the import once to hover the declaration.
            if (/^(?:```\w*\n)?(?:\(alias\)\s*)?import\b/.test(body)) {
              const target = (await definitionThroughImports(client, uri, inside))[0];
              if (target) {
                const targetPath = LspClient.pathFor(target.uri);
                const targetUri = client.open(targetPath);
                hover = await client.request<{ contents: unknown } | null>('textDocument/hover', { textDocument: { uri: targetUri }, position: target.range.start });
                const followed = hoverText(hover?.contents).trim();
                if (followed) {
                  body = followed;
                  via = ` (declared at ${toRelative(root, targetPath) || targetPath}:${target.range.start.line + 1})`;
                }
              }
            }
            return body ? { summary: `hover at ${shown}:${pos.line + 1}:${pos.character + 1}${via}`, content: body.slice(0, 4_000) } : { summary: 'no hover information', content: `(no hover information at ${shown}:${pos.line + 1}:${pos.character + 1})` };
          }
          const locations = operation === 'definition' ? await definitionThroughImports(client, uri, inside) : normalizeLocations(await client.request<LspLocation | LspLocation[] | LspLocationLink[] | null>('textDocument/references', params));
          return renderLocations(operation, shown, pos, locations, root);
        }
        default:
          return { summary: 'unknown operation', content: `unknown operation ${String(operation)} (definition | references | hover | diagnostics | symbols)`, isError: true };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { summary: `lsp ${operation} failed`, content: msg, isError: true };
    }
  }
}

/** Resolve the request's line/column/symbol into a 0-based position. */
export function locate(text: string, args: Record<string, unknown>): { line: number; character: number } | { error: string } {
  const lines = text.split(/\r?\n/);
  const lineArg = optionalNumber(args, 'line');
  const columnArg = optionalNumber(args, 'column');
  const symbol = optionalString(args, 'symbol')?.trim();
  if (lineArg !== undefined) {
    const line = Math.floor(lineArg) - 1;
    if (line < 0 || line >= lines.length) return { error: `line ${lineArg} is outside the file (${lines.length} lines)` };
    if (columnArg !== undefined) return { line, character: Math.max(0, Math.floor(columnArg) - 1) };
    if (symbol) {
      const col = indexOfWord(lines[line]!, symbol);
      if (col < 0) return { error: `"${symbol}" does not occur on line ${lineArg}` };
      return { line, character: col };
    }
    // No column and no symbol: the first identifier character on the line.
    const m = /[A-Za-z_$]/.exec(lines[line]!);
    return { line, character: m ? m.index : 0 };
  }
  if (symbol) {
    // Prefer a use or declaration over an import line: definition/hover on
    // the import specifier answers with the import itself.
    let fallback: { line: number; character: number } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const col = indexOfWord(lines[i]!, symbol);
      if (col < 0) continue;
      if (/^\s*(?:import\b|export\s+.*\bfrom\b|from\s+\S+\s+import\b|using\b)/.test(lines[i]!)) {
        fallback ??= { line: i, character: col };
        continue;
      }
      return { line: i, character: col };
    }
    if (fallback) return fallback;
    return { error: `"${symbol}" does not occur in the file` };
  }
  return { error: 'give line (and column) or symbol' };
}

function identifierLengthAt(text: string, pos: { line: number; character: number }): number {
  const line = text.split(/\r?\n/)[pos.line] ?? '';
  const m = /^[A-Za-z_$][\w$]*/.exec(line.slice(pos.character));
  return m ? m[0].length : 0;
}

function indexOfWord(line: string, word: string): number {
  const re = new RegExp(`(?<![A-Za-z0-9_$])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$])`);
  const m = re.exec(line);
  return m ? m.index : line.indexOf(word);
}

const IMPORT_LINE = /^\s*(?:import\b|export\s+.*\bfrom\b|from\s+\S+\s+import\b|using\b)/;

/**
 * Definition, following an import once: TypeScript's server answers a use of
 * an imported name with the import specifier in the same file; asking again
 * from there lands on the exported declaration.
 */
async function definitionThroughImports(client: LspClient, uri: string, pos: { line: number; character: number }): Promise<LspLocation[]> {
  const first = normalizeLocations(await client.request<LspLocation | LspLocation[] | LspLocationLink[] | null>('textDocument/definition', { textDocument: { uri }, position: { line: pos.line, character: pos.character } }));
  if (first.length !== 1) return first;
  const hit = first[0]!;
  if (hit.uri !== uri || hit.range.start.line === pos.line) return first;
  const line = snippetRaw(LspClient.pathFor(hit.uri), hit.range.start.line);
  if (!IMPORT_LINE.test(line)) return first;
  const notTheImport = (l: LspLocation): boolean => !(l.uri === uri && l.range.start.line === hit.range.start.line);
  // TypeScript's server answers `definition` on an import alias with the
  // alias again; `implementation` at the use site reaches the declaration.
  for (const attempt of [
    { method: 'textDocument/implementation', position: { line: pos.line, character: pos.character } },
    { method: 'textDocument/definition', position: hit.range.start },
  ]) {
    try {
      const next = normalizeLocations(await client.request<LspLocation | LspLocation[] | LspLocationLink[] | null>(attempt.method, { textDocument: { uri }, position: attempt.position }, 5_000));
      const beyond = next.filter(notTheImport);
      if (beyond.length > 0) return beyond;
    } catch {
      /* method unsupported by this server */
    }
  }
  return first;
}

function snippetRaw(absPath: string, line: number): string {
  try {
    return readFileSync(absPath, 'utf8').split(/\r?\n/)[line] ?? '';
  } catch {
    return '';
  }
}

function normalizeLocations(raw: LspLocation | LspLocation[] | LspLocationLink[] | null): LspLocation[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((l) => {
    if ('targetUri' in l) return { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange };
    return l;
  });
}

function snippet(absPath: string, line: number): string {
  try {
    const l = readFileSync(absPath, 'utf8').split(/\r?\n/)[line] ?? '';
    return l.trim().slice(0, 160);
  } catch {
    return '';
  }
}

function renderLocations(operation: Operation, shown: string, pos: { line: number; character: number }, locations: LspLocation[], root: string): ToolResult {
  const at = `${shown}:${pos.line + 1}:${pos.character + 1}`;
  if (locations.length === 0) return { summary: `no ${operation} for ${at}`, content: `(no ${operation} found for ${at})`, metadata: { count: 0 } };
  const rows = locations.slice(0, MAX_LOCATIONS).map((l) => {
    const abs = LspClient.pathFor(l.uri);
    const rel = toRelative(root, abs) || abs.replace(/\\/g, '/');
    return `${rel}:${l.range.start.line + 1}:${l.range.start.character + 1}  ${snippet(abs, l.range.start.line)}`;
  });
  const more = locations.length > MAX_LOCATIONS ? `\n… +${locations.length - MAX_LOCATIONS} more` : '';
  return {
    summary: `${locations.length} ${operation === 'definition' ? 'definition' : 'reference'}${locations.length === 1 ? '' : 's'} for ${at}`,
    content: rows.join('\n') + more,
    metadata: { count: locations.length },
  };
}

function hoverText(contents: unknown): string {
  if (!contents) return '';
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map((c) => hoverText(c)).join('\n\n');
  const obj = contents as { value?: string; language?: string };
  return typeof obj.value === 'string' ? obj.value : '';
}

function renderDiagnostics(shown: string, list: LspDiagnostic[]): ToolResult {
  if (list.length === 0) return { summary: `no diagnostics in ${shown}`, content: `(no diagnostics reported for ${shown})`, metadata: { count: 0 } };
  const sev = (n?: number): string => (n === 1 ? 'error' : n === 2 ? 'warning' : n === 3 ? 'info' : n === 4 ? 'hint' : 'note');
  const rows = list.slice(0, MAX_DIAGNOSTICS).map((d) => `${shown}:${d.range.start.line + 1}:${d.range.start.character + 1}  [${sev(d.severity)}] ${d.message.replace(/\s+/g, ' ').trim()}${d.source ? ` (${d.source})` : ''}`);
  const errors = list.filter((d) => d.severity === 1).length;
  const more = list.length > MAX_DIAGNOSTICS ? `\n… +${list.length - MAX_DIAGNOSTICS} more` : '';
  return { summary: `${list.length} diagnostic${list.length === 1 ? '' : 's'} in ${shown} (${errors} error${errors === 1 ? '' : 's'})`, content: rows.join('\n') + more, metadata: { count: list.length, errors } };
}

const SYMBOL_KINDS: Record<number, string> = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class', 6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 10: 'enum',
  11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 15: 'string', 16: 'number', 17: 'boolean', 18: 'array', 19: 'object', 20: 'key',
  21: 'null', 22: 'enum member', 23: 'struct', 24: 'event', 25: 'operator', 26: 'type parameter',
};

function renderSymbols(shown: string, result: LspDocumentSymbol[] | Array<{ name: string; kind: number; location: LspLocation }>): ToolResult {
  const rows: string[] = [];
  // Descend into containers (classes, interfaces, modules, enums, structs)
  // only: object-literal property trees under a constant are noise here.
  const CONTAINER_KINDS = new Set([2, 3, 4, 5, 10, 11, 23]);
  const walk = (items: LspDocumentSymbol[], depth: number): void => {
    for (const s of items) {
      if (rows.length >= MAX_SYMBOLS) return;
      rows.push(`${'  '.repeat(depth)}${SYMBOL_KINDS[s.kind] ?? 'symbol'} ${s.name}  :${(s.selectionRange ?? s.range).start.line + 1}${s.detail ? `  ${s.detail.slice(0, 80)}` : ''}`);
      if (s.children?.length && CONTAINER_KINDS.has(s.kind)) walk(s.children, depth + 1);
    }
  };
  if (result.length > 0 && 'location' in (result[0] as object)) {
    for (const s of result as Array<{ name: string; kind: number; location: LspLocation }>) {
      if (rows.length >= MAX_SYMBOLS) break;
      rows.push(`${SYMBOL_KINDS[s.kind] ?? 'symbol'} ${s.name}  :${s.location.range.start.line + 1}`);
    }
  } else {
    walk(result as LspDocumentSymbol[], 0);
  }
  if (rows.length === 0) return { summary: `no symbols in ${shown}`, content: `(the language server reported no symbols for ${shown})`, metadata: { count: 0 } };
  return { summary: `${rows.length} symbol${rows.length === 1 ? '' : 's'} in ${shown}`, content: rows.join('\n'), metadata: { count: rows.length } };
}
