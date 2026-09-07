// retrieve_entity — read the source of entities by reference: a symbol's
// exact span (numbered lines, optional context), or a file's outline
// (skeleton) so the next hop is a symbol, not a whole file.

import { renderOutline, foldLine } from '../index/format.js';
import type { CodeIndex, EntityNode } from '../index/CodeIndex.js';
import { capOutput, indexFor, resolveRef, stringList } from './indexCommon.js';
import {
  optionalBoolean,
  optionalNumber,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const MAX_IDS = 12;
const DEFAULT_MAX_LINES = 120;
const MAX_MAX_LINES = 400;
const MAX_MATCHES_PER_REF = 3;

const DEFINITION: ToolDefinition = {
  name: 'retrieve_entity',
  description:
    'Read code entities from the index: for a symbol (class, function, method, …) the exact source span with ' +
    'line numbers; for a file its outline — every definition with its line, kind and signature — so you can ' +
    'pick the symbol to read next instead of reading the whole file. References: an id from search_entity, ' +
    '"path#symbol", "path:line" (the innermost definition at that line), a path, or a bare symbol name. ' +
    'Prefer this over read_file once you know which symbol you need; use read_file for arbitrary ranges.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: `1–${MAX_IDS} entity references.` },
      context: { type: 'number', description: 'Extra lines before and after each symbol span. Default 0.' },
      max_lines: { type: 'number', description: `Max lines per symbol. Default ${DEFAULT_MAX_LINES}, max ${MAX_MAX_LINES}.` },
      source: { type: 'boolean', description: 'For file references: return the first max_lines of source instead of the outline. Default false.' },
    },
    required: ['ids'],
  },
};

export class RetrieveEntityTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const refs = stringList(args, 'ids') ?? [];
    if (refs.length === 0) return { summary: 'no ids', content: 'Pass at least one entity reference in `ids`.', isError: true };
    const context = Math.max(0, Math.min(50, Math.floor(optionalNumber(args, 'context') ?? 0)));
    const maxLines = Math.max(1, Math.min(MAX_MAX_LINES, Math.floor(optionalNumber(args, 'max_lines') ?? DEFAULT_MAX_LINES)));
    const wantSource = optionalBoolean(args, 'source') ?? false;

    const got = await indexFor(ctx.session.projectRoot);
    if ('error' in got) return got.error;
    const { index } = got;

    const sections: string[] = [];
    const shown: string[] = [];
    let errors = 0;
    for (const ref of refs.slice(0, MAX_IDS)) {
      const matches = resolveRef(index, ctx.session.projectRoot, ref);
      if (matches.length === 0) {
        sections.push(`"${ref}": not in the index (check the path, or search_entity for the name)`);
        errors += 1;
        continue;
      }
      if (matches.length > MAX_MATCHES_PER_REF) {
        sections.push(`"${ref}" is ambiguous (${matches.length} entities); showing the first ${MAX_MATCHES_PER_REF}:\n${matches.slice(0, 12).map((m) => `  ${foldLine(m)}`).join('\n')}`);
      }
      for (const node of matches.slice(0, MAX_MATCHES_PER_REF)) {
        sections.push(this.render(node, index, { context, maxLines, wantSource }));
        shown.push(node.id);
      }
    }
    if (refs.length > MAX_IDS) sections.push(`… ${refs.length - MAX_IDS} more references ignored (max ${MAX_IDS} per call)`);

    return {
      summary: `${shown.length} entit${shown.length === 1 ? 'y' : 'ies'}${errors ? `, ${errors} unresolved` : ''}`,
      content: capOutput(sections.join('\n\n')),
      isError: shown.length === 0,
      metadata: { shown },
    };
  }

  private render(node: EntityNode, index: CodeIndex, opts: { context: number; maxLines: number; wantSource: boolean }): string {
    const isFile = node.kind === 'file' || node.kind === 'textfile';
    if (isFile && !opts.wantSource && node.kind === 'file') {
      const outline = renderOutline(index, node.path);
      return `${outline}\n    (pass source:true for the file head, or read_file for a range)`;
    }
    const src = index.source(node, { maxLines: opts.maxLines, context: isFile ? 0 : opts.context });
    if (!src) return `${foldLine(node)}\n    (source unavailable)`;
    const tail = src.truncated ? `\n    … (truncated at line ${src.endLine}; read_file ${node.path} offset=${src.endLine + 1} for the rest)` : '';
    return `${foldLine(node)}\n${src.text}${tail}`;
  }
}
