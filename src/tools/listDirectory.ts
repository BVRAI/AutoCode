import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInsideRoot, toRelative, ensureDirectory } from '../util/pathSafety.js';
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const NOISE_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'bin',
  'obj',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.vite',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  '.cache',
  'coverage',
]);

const DEFAULT_MAX_ENTRIES = 200;

const DEFINITION: ToolDefinition = {
  name: 'list_directory',
  description:
    'List files and subdirectories under a path relative to the project root. ' +
    'Filters common noise directories (node_modules, .git, dist, etc.). ' +
    'Use this to get an overview of a directory; for finding files by name pattern use glob instead.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to project root. Use "." for the root.' },
      recursive: { type: 'boolean', description: 'Recurse into subdirectories. Default: false.' },
      max_entries: { type: 'number', description: `Max entries returned. Default ${DEFAULT_MAX_ENTRIES}.` },
    },
    required: ['path'],
  },
};

export class ListDirectoryTool implements Tool {
  readonly definition = DEFINITION;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const path = optionalString(args, 'path') ?? '.';
    const recursive = optionalBoolean(args, 'recursive') ?? false;
    const maxEntries = optionalNumber(args, 'max_entries') ?? DEFAULT_MAX_ENTRIES;

    const target = resolveInsideRoot(ctx.session.projectRoot, path);
    ensureDirectory(target);

    const entries: string[] = [];
    let truncated = false;
    const walk = (dir: string, depth: number): void => {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      let names: string[];
      try {
        names = readdirSync(dir).sort();
      } catch {
        return;
      }
      for (const name of names) {
        if (NOISE_DIRS.has(name)) continue;
        const full = join(dir, name);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        const rel = toRelative(ctx.session.projectRoot, full);
        entries.push(isDir ? `${rel}/` : rel);
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        if (recursive && isDir && depth < 32) {
          walk(full, depth + 1);
        }
      }
    };
    walk(target, 0);

    const content =
      entries.length === 0 ? '(empty)' : entries.join('\n') + (truncated ? '\n… truncated' : '');
    return {
      summary: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${truncated ? ' (truncated)' : ''} in ${toRelative(ctx.session.projectRoot, target) || '.'}`,
      content,
      metadata: { count: entries.length, truncated },
    };
  }
}
