// search_entity — find code entities (files, classes, functions, methods, …)
// by name, path fragment or keywords, ranked by name match, keyword match and
// file importance. The entry point of the localization funnel: from a vague
// phrase to a short ranked list of places, without reading anything yet.

import { renderHits, type View } from '../index/format.js';
import type { NodeKind } from '../index/CodeIndex.js';
import { capOutput, indexFor, stringList } from './indexCommon.js';
import {
  optionalNumber,
  optionalString,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;
const KINDS: NodeKind[] = ['file', 'textfile', 'class', 'interface', 'type', 'enum', 'function', 'method', 'property', 'module', 'implementation'];

const DEFINITION: ToolDefinition = {
  name: 'search_entity',
  description:
    'Search the project\'s code index for entities — files, classes, interfaces, functions, methods, ' +
    'properties, modules — by name, path fragment or a few keywords. Returns a ranked list with ' +
    'path:line, kind and signature; nothing is read yet. Ranking: exact name > name prefix/contains > ' +
    'keyword match over identifier, path and signature tokens, boosted by file importance. ' +
    'Use it first when the request names something vaguely ("the export button", "where tasks get ' +
    'materialized"); then traverse_graph to see callers/imports and retrieve_entity to read the code. ' +
    'Prefer it over grep for names; keep grep for literal strings and error messages.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'A name, path fragment, or 1–5 keywords. Case-insensitive.' },
      kinds: {
        type: 'array',
        items: { type: 'string' },
        description: `Optional filter: any of ${KINDS.join(', ')}.`,
      },
      path: { type: 'string', description: 'Optional project-relative path prefix to search under (e.g. "src/Automax.App/Views").' },
      view: {
        type: 'string',
        enum: ['fold', 'preview', 'full'],
        description: 'fold = one line per hit; preview (default) = plus the signature; full = plus the source (first 60 lines each).',
      },
      limit: { type: 'number', description: `Max hits. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.` },
    },
    required: ['query'],
  },
};

export class SearchEntityTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const query = requireString(args, 'query');
    const kinds = stringList(args, 'kinds') as NodeKind[] | undefined;
    const pathPrefix = optionalString(args, 'path')?.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    const viewRaw = optionalString(args, 'view');
    const view: View = viewRaw === 'fold' || viewRaw === 'full' ? viewRaw : 'preview';
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(optionalNumber(args, 'limit') ?? DEFAULT_LIMIT)));
    if (kinds) {
      const bad = kinds.filter((k) => !KINDS.includes(k));
      if (bad.length > 0) {
        return { summary: 'bad kinds', content: `Unknown kinds: ${bad.join(', ')}. Use: ${KINDS.join(', ')}`, isError: true };
      }
    }

    const got = await indexFor(ctx.session.projectRoot);
    if ('error' in got) return got.error;
    const { index } = got;

    const hits = index.search(query, { limit, kinds, pathPrefix: pathPrefix || undefined });
    const body = renderHits(hits, view, index);
    const stats = index.stats();
    const header =
      hits.length === 0
        ? `No entities match "${query}" (index: ${stats.files} files, ${stats.symbols} symbols). Try fewer or different keywords, or grep for a literal string.`
        : `${hits.length} hit${hits.length === 1 ? '' : 's'} for "${query}"${pathPrefix ? ` under ${pathPrefix}` : ''} (best first):`;

    return {
      summary: `${hits.length} hit(s) for "${query}"`,
      content: capOutput(`${header}\n${body}`),
      metadata: {
        query,
        hits: hits.map((h) => ({ id: h.node.id, path: h.node.path, kind: h.node.kind, startLine: h.node.startLine, endLine: h.node.endLine, why: h.why })),
      },
    };
  }
}
