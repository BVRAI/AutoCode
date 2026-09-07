// traverse_graph — walk the code graph from one or more entities: who calls
// or imports this, what it calls or imports, what extends it, what it
// contains. The blast-radius / where-does-behavior-come-from tool, over
// symbols as well as files.

import { renderTraversal } from '../index/format.js';
import type { EdgeKind, EntityNode } from '../index/CodeIndex.js';
import { capOutput, indexFor, resolveRef, stringList } from './indexCommon.js';
import {
  optionalNumber,
  optionalString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const EDGE_KINDS: EdgeKind[] = ['imports', 'invokes', 'inherits', 'contains'];
const MAX_ROOTS = 8;
const MAX_MATCHES_PER_REF = 3;

const DEFINITION: ToolDefinition = {
  name: 'traverse_graph',
  description:
    'Walk the project\'s code graph from one or more entities. Edges: imports (file → file), ' +
    'invokes (function/method → what it calls), inherits (class → base), contains (file/class → members). ' +
    'direction "in" answers "who uses this?" (callers, importers, subclasses — the blast radius of a change); ' +
    '"out" answers "what does this depend on?"; "both" shows both. Entities are referenced by id from ' +
    'search_entity, a path ("src/app.ts"), "path#symbol", "path:line", or a bare symbol name. ' +
    'Output is a bounded indented tree of path:line entries; use retrieve_entity to read any of them.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: `1–${MAX_ROOTS} entity references (ids, paths, "path#symbol", "path:line", or names).`,
      },
      direction: { type: 'string', enum: ['in', 'out', 'both'], description: 'Default both.' },
      hops: { type: 'number', description: 'How many edges to follow (1–3). Default 1; 2 shows callers of callers.' },
      kinds: {
        type: 'array',
        items: { type: 'string' },
        description: `Edge kinds to follow: any of ${EDGE_KINDS.join(', ')}. Default imports, invokes, inherits.`,
      },
      max_nodes: { type: 'number', description: 'Cap on visited entities. Default 60, max 200.' },
    },
    required: ['ids'],
  },
};

export class TraverseGraphTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const refs = stringList(args, 'ids') ?? [];
    if (refs.length === 0) return { summary: 'no ids', content: 'Pass at least one entity reference in `ids`.', isError: true };
    const dirRaw = optionalString(args, 'direction');
    const direction: 'in' | 'out' | 'both' = dirRaw === 'in' || dirRaw === 'out' ? dirRaw : 'both';
    const hops = Math.max(1, Math.min(3, Math.floor(optionalNumber(args, 'hops') ?? 1)));
    const kinds = stringList(args, 'kinds') as EdgeKind[] | undefined;
    if (kinds) {
      const bad = kinds.filter((k) => !EDGE_KINDS.includes(k));
      if (bad.length > 0) return { summary: 'bad kinds', content: `Unknown edge kinds: ${bad.join(', ')}. Use: ${EDGE_KINDS.join(', ')}`, isError: true };
    }
    const maxNodes = Math.max(5, Math.min(200, Math.floor(optionalNumber(args, 'max_nodes') ?? 60)));

    const got = await indexFor(ctx.session.projectRoot);
    if ('error' in got) return got.error;
    const { index } = got;

    const roots: EntityNode[] = [];
    const notes: string[] = [];
    for (const ref of refs.slice(0, MAX_ROOTS)) {
      const matches = resolveRef(index, ctx.session.projectRoot, ref);
      if (matches.length === 0) {
        notes.push(`"${ref}": not in the index (check the path, or search_entity for the name)`);
        continue;
      }
      if (matches.length > MAX_MATCHES_PER_REF) {
        notes.push(`"${ref}" is ambiguous (${matches.length} entities); showing the first ${MAX_MATCHES_PER_REF} — pass an id or path#symbol to pick one`);
      }
      roots.push(...matches.slice(0, MAX_MATCHES_PER_REF));
    }
    if (roots.length === 0) {
      return { summary: 'nothing resolved', content: notes.join('\n'), isError: true };
    }

    const result = index.traverse(
      roots.map((r) => r.id),
      { direction, hops, kinds, maxNodes },
    );
    const body = renderTraversal(roots, result, index, direction);
    const content = [notes.join('\n'), body].filter(Boolean).join('\n');
    return {
      summary: `${roots.length} root(s), ${result.nodes.length} entities, ${result.edges.length} edges`,
      content: capOutput(content),
      metadata: {
        roots: roots.map((r) => r.id),
        nodes: result.nodes.map((n) => n.id),
        truncated: result.truncated,
      },
    };
  }
}
