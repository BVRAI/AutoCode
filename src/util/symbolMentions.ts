// Symbol `@`-mentions (Phase 3.6): `@renderDiff` or `@src/app.ts#App` in a
// prompt inlines that definition's source from the code index, the way
// `@path` inlines a file. The picker under the composer offers symbols next
// to files. Both read the in-memory index only (`peekIndex`) — nothing here
// waits for a build, so a prompt is never delayed by the index.

import type { CodeIndex, EntityNode } from '../index/CodeIndex.js';
import { foldLine, renderFull } from '../index/format.js';

export const MAX_SYMBOL_LINES = 200;
const MAX_LISTED_CANDIDATES = 8;

/** Definition nodes only — files and directories are handled as paths. */
function isDefinition(node: EntityNode): boolean {
  return node.kind !== 'dir' && node.kind !== 'file' && node.kind !== 'textfile' && node.startLine !== undefined;
}

export interface SymbolMention {
  /** The `<symbol>` block to inline after the prompt. */
  block: string;
  /** One-line note for the user ("@render: function App.render at src/app.tsx:12-40"). */
  note: string;
}

/**
 * Turn a non-path mention into an inlined definition. One definition (or a
 * unique best match) inlines its source; several inline a short candidate
 * list so the model can pick; none returns null (the mention stays as text).
 */
export function resolveSymbolMention(index: CodeIndex, ref: string): SymbolMention | null {
  const hits = index.resolve(ref).filter(isDefinition);
  if (hits.length === 0) return null;
  const exact = hits.filter((n) => n.name === ref || n.fqn === ref);
  const chosen = exact.length === 1 ? exact : hits;
  if (chosen.length === 1) {
    const node = chosen[0]!;
    return {
      block: `<symbol ref="${escapeAttr(ref)}">\n${renderFull(node, index, MAX_SYMBOL_LINES)}\n</symbol>`,
      note: `@${ref}: ${node.kind} ${node.fqn} at ${where(node)}`,
    };
  }
  const listed = chosen.slice(0, MAX_LISTED_CANDIDATES).map((n) => foldLine(n));
  const more = chosen.length > MAX_LISTED_CANDIDATES ? `\n… +${chosen.length - MAX_LISTED_CANDIDATES} more` : '';
  return {
    block: `<symbol ref="${escapeAttr(ref)}" candidates="${chosen.length}">\n${listed.join('\n')}${more}\n</symbol>`,
    note: `@${ref}: ${chosen.length} definitions match — listed for the model (use path#name to pin one)`,
  };
}

export interface SymbolCandidate {
  /** Text inserted after `@` when picked ("App.render" or "src/app.tsx#render"). */
  insert: string;
  /** What the picker shows: `render  function App.render — src/app.tsx:12`. */
  label: string;
  node: EntityNode;
}

/** Symbols for the picker: exact-name and prefix matches first, then the index's ranking. */
export function rankSymbols(index: CodeIndex, query: string, limit = 5): SymbolCandidate[] {
  const q = query.trim();
  if (q.length < 2) return [];
  const hits = index.search(q, { limit: limit * 4 }).map((h) => h.node).filter(isDefinition);
  const lower = q.toLowerCase();
  const scored = hits.map((node) => {
    const name = node.name.toLowerCase();
    const rank = name === lower ? 0 : name.startsWith(lower) ? 1 : node.fqn.toLowerCase().includes(lower) ? 2 : 3;
    return { node, rank };
  });
  scored.sort((a, b) => a.rank - b.rank || a.node.path.length - b.node.path.length);
  const out: SymbolCandidate[] = [];
  const seenNames = new Map<string, number>();
  for (const { node } of scored) {
    if (out.length >= limit) break;
    const dup = (seenNames.get(node.name) ?? 0) + 1;
    seenNames.set(node.name, dup);
    // A name that occurs in several files is inserted pinned to its file.
    const ambiguous = (index.resolve(node.name).filter(isDefinition).length ?? 0) > 1;
    const insert = ambiguous ? `${node.path}#${node.name}` : node.name;
    out.push({ insert, label: `${node.name}  ${node.kind} ${node.fqn} — ${where(node)}`, node });
  }
  return out;
}

/** One row of the `@` picker: files first, then symbols. */
export interface MentionEntry {
  insert: string;
  label: string;
  kind: 'file' | 'symbol';
}

export function mentionEntries(files: readonly string[], symbols: readonly SymbolCandidate[]): MentionEntry[] {
  const out: MentionEntry[] = files.map((path) => ({ insert: path, label: path, kind: 'file' as const }));
  const seen = new Set(out.map((e) => e.insert));
  for (const s of symbols) {
    if (seen.has(s.insert)) continue;
    seen.add(s.insert);
    out.push({ insert: s.insert, label: s.label, kind: 'symbol' });
  }
  return out;
}

function where(node: EntityNode): string {
  return node.startLine !== undefined ? `${node.path}:${node.startLine}${node.endLine && node.endLine !== node.startLine ? `-${node.endLine}` : ''}` : node.path;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
