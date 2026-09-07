// Text renderers for index results: compact, bounded, and the same shape in
// every tool so the model learns one vocabulary (LocAgent's fold / preview /
// full views).

import type { CodeIndex, EntityNode, Edge, SearchHit } from './CodeIndex.js';

export type View = 'fold' | 'preview' | 'full';

/** `path:12-40  method App.render  — signature` */
export function foldLine(node: EntityNode): string {
  const where = node.startLine !== undefined ? `${node.path}:${node.startLine}${node.endLine && node.endLine !== node.startLine ? `-${node.endLine}` : ''}` : node.path;
  const kind = node.kind === 'file' || node.kind === 'textfile' ? node.kind : `${node.kind} ${node.fqn}`;
  return `${where}  ${kind}`;
}

export function previewLine(node: EntityNode): string {
  const base = foldLine(node);
  return node.signature ? `${base}\n    ${node.signature}` : base;
}

export function renderHits(hits: SearchHit[], view: View, index: CodeIndex, opts: { maxSourceLines?: number } = {}): string {
  if (hits.length === 0) return '(no matches)';
  const out: string[] = [];
  for (const h of hits) {
    if (view === 'fold') out.push(foldLine(h.node));
    else if (view === 'preview') out.push(previewLine(h.node));
    else out.push(renderFull(h.node, index, opts.maxSourceLines ?? 60));
  }
  return out.join(view === 'full' ? '\n\n' : '\n');
}

export function renderFull(node: EntityNode, index: CodeIndex, maxLines: number): string {
  const src = index.source(node, { maxLines });
  const head = foldLine(node);
  if (!src) return `${head}\n    (source unavailable)`;
  const tail = src.truncated ? `\n    … (truncated at ${src.endLine}; ask for the file range with read_file)` : '';
  return `${head}\n${src.text}${tail}`;
}

/** The edges around a set of nodes as an indented tree, grouped by edge kind. */
export function renderTraversal(
  roots: EntityNode[],
  result: { nodes: EntityNode[]; edges: Edge[]; truncated: boolean },
  index: CodeIndex,
  direction: 'in' | 'out' | 'both',
): string {
  const out: string[] = [];
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  const seenEdge = new Set<string>();
  for (const root of roots) {
    out.push(foldLine(root));
    const groups = new Map<string, string[]>();
    for (const e of result.edges) {
      const key = `${e.from}|${e.to}|${e.kind}`;
      if (seenEdge.has(key)) continue;
      let label: string | null = null;
      let other: string | null = null;
      if (e.from === root.id && direction !== 'in') {
        label = e.kind === 'imports' ? 'imports' : e.kind === 'invokes' ? 'calls' : e.kind === 'inherits' ? 'extends' : 'contains';
        other = e.to;
      } else if (e.to === root.id && direction !== 'out') {
        label = e.kind === 'imports' ? 'imported by' : e.kind === 'invokes' ? 'called by' : e.kind === 'inherits' ? 'extended by' : 'inside';
        other = e.from;
      }
      if (!label || !other) continue;
      seenEdge.add(key);
      const n = byId.get(other) ?? index.entity(other);
      if (!n) continue;
      const list = groups.get(label) ?? [];
      list.push(e.weak ? `${foldLine(n)}  (by name — unverified)` : foldLine(n));
      groups.set(label, list);
    }
    if (groups.size === 0) out.push('    (no edges)');
    for (const [label, lines] of groups) {
      out.push(`  ${label} (${lines.length}):`);
      for (const l of lines.slice(0, 40)) out.push(`    ${l}`);
      if (lines.length > 40) out.push(`    … +${lines.length - 40} more`);
    }
  }
  if (result.truncated) out.push('… (graph truncated; narrow with kinds or fewer hops)');
  return out.join('\n');
}

/** Definitions in a file as an indented outline (Agentless skeletons). */
export function renderOutline(index: CodeIndex, path: string): string {
  const nodes = index.outline(path);
  if (nodes.length === 0) return `${path}: no symbols indexed`;
  const depth = new Map<string, number>();
  const lines: string[] = [path];
  for (const n of nodes) {
    const d = n.parent ? (depth.get(n.parent) ?? 0) + 1 : 0;
    depth.set(n.id, d);
    const pad = '  '.repeat(d + 1);
    lines.push(`${pad}${n.startLine}  ${n.kind} ${n.name}${n.signature ? `  ${n.signature}` : ''}`);
  }
  return lines.join('\n');
}
