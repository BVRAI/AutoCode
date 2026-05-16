import { glob } from 'tinyglobby';
import { toRelative } from '../util/pathSafety.js';
import {
  optionalNumber,
  optionalString,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFAULT_LIMIT = 200;

const DEFINITION: ToolDefinition = {
  name: 'glob',
  description:
    'Find files by name pattern under the project root. Supports standard glob syntax like ' +
    '"src/**/*.ts" or "**/{README,readme}.md". Returns matching paths relative to project root. ' +
    'Use this when you know roughly what the filename looks like; use grep when you need to ' +
    'search file contents.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern. Multiple patterns can be comma-separated.' },
      cwd: { type: 'string', description: 'Subdirectory to search under (relative). Default project root.' },
      limit: { type: 'number', description: `Max results. Default ${DEFAULT_LIMIT}.` },
    },
    required: ['pattern'],
  },
};

export class GlobTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const pattern = requireString(args, 'pattern');
    const cwd = optionalString(args, 'cwd');
    const limit = optionalNumber(args, 'limit') ?? DEFAULT_LIMIT;

    const patterns = pattern.includes(',') ? pattern.split(',').map((p) => p.trim()) : [pattern];
    const searchRoot = cwd
      ? // Resolve via path utility for safety
        (await import('../util/pathSafety.js')).resolveInsideRoot(ctx.session.projectRoot, cwd)
      : ctx.session.projectRoot;

    const matches = await glob(patterns, {
      cwd: searchRoot,
      onlyFiles: true,
      ignore: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/coverage/**',
      ],
      absolute: false,
      dot: false,
    });

    const sorted = matches.sort();
    const truncated = sorted.length > limit;
    const shown = truncated ? sorted.slice(0, limit) : sorted;
    const displayPaths = shown.map((p) => {
      if (cwd) {
        const abs = `${searchRoot}/${p}`.replace(/\\/g, '/');
        return toRelative(ctx.session.projectRoot, abs);
      }
      return p.split('\\').join('/');
    });
    const content =
      displayPaths.length === 0
        ? '(no matches)'
        : displayPaths.join('\n') + (truncated ? `\n… ${sorted.length - limit} more` : '');
    return {
      summary: `${sorted.length} match${sorted.length === 1 ? '' : 'es'} for ${pattern}${truncated ? ' (truncated)' : ''}`,
      content,
      metadata: { total: sorted.length, truncated },
    };
  }
}
