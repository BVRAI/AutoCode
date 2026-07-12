// file_deps — expose the repo's import graph to the agent (LocAgent-style
// structural navigation: +10.5% localization accuracy in the ACL 2025 study).
// Answers the two questions grep is worst at: "who uses this file?" (blast
// radius before an edit) and "what does it depend on?" (where behavior comes
// from). Reads the graph the RepoMap scan already built — zero extra I/O.

import { existsSync } from 'node:fs';
import { forceRefreshRepoMap, getImportGraph } from '../agent/RepoMap.js';
import { resolveInsideRoot, toRelative } from '../util/pathSafety.js';
import {
  optionalString,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFINITION: ToolDefinition = {
  name: 'file_deps',
  description:
    "Show a file's position in the project import graph: which files import it (its dependents — " +
    'the blast radius of a change) and which files it imports (its dependencies). Use it before ' +
    'changing a shared file to find its consumers, or to trace where behavior a file relies on ' +
    'comes from. Static and relative-import-based: it can miss dynamic or path-aliased imports, ' +
    'and it reflects the repo as scanned at session start.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to project root.' },
      direction: {
        type: 'string',
        enum: ['importers', 'imports', 'both'],
        description: 'importers = who imports this file; imports = what it imports. Default both.',
      },
    },
    required: ['path'],
  },
};

export class FileDepsTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const rawPath = requireString(args, 'path');
    const direction = optionalString(args, 'direction') ?? 'both';
    if (direction !== 'importers' && direction !== 'imports' && direction !== 'both') {
      return {
        summary: 'bad direction',
        content: `direction must be importers | imports | both. Got: ${direction}`,
        isError: true,
      };
    }

    // Normalize whatever the model passed (backslashes, ./ prefixes) into the
    // graph's project-relative forward-slash form.
    const abs = resolveInsideRoot(ctx.session.projectRoot, rawPath);
    const rel = toRelative(ctx.session.projectRoot, abs).replace(/\\/g, '/');

    let graph = getImportGraph(ctx.session.projectRoot);
    if (!graph.imports.has(rel) && existsSync(abs)) {
      // The file exists on disk but isn't in the graph — most likely created
      // after the last scan (the map refreshes at turn boundaries). Rebuild
      // once and retry so freshly-written files answer correctly.
      forceRefreshRepoMap(ctx.session.projectRoot);
      graph = getImportGraph(ctx.session.projectRoot);
    }
    if (!graph.imports.has(rel)) {
      return {
        summary: `not in import graph: ${rel}`,
        content:
          `${rel} is not in the scanned import graph. Possible reasons: unsupported file type, ` +
          `inside an ignored directory (node_modules etc.), or beyond the scan cap on a very ` +
          `large repo. Use grep/find_symbol for files outside the graph.`,
        isError: true,
      };
    }

    // Importers sorted by THEIR importance — the consumers that matter most
    // (per the ranked repo map) come first.
    const importers = [...(graph.importers.get(rel) ?? [])].sort(
      (a, b) => (graph.rank.get(b) ?? 0) - (graph.rank.get(a) ?? 0),
    );
    const imports = graph.imports.get(rel) ?? [];

    const sections: string[] = [`deps for ${rel}`];
    if (direction !== 'imports') {
      sections.push(`imported by (${importers.length}):`);
      for (const f of importers) sections.push(`  ${f}`);
    }
    if (direction !== 'importers') {
      sections.push(`imports (${imports.length}):`);
      for (const f of imports) sections.push(`  ${f}`);
    }

    return {
      summary: `${rel}: ${importers.length} importer(s), ${imports.length} import(s)`,
      content: sections.join('\n'),
      metadata: { path: rel, importers, imports },
    };
  }
}
