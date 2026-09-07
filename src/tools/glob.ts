import { glob } from 'tinyglobby';
import { toRelative } from '../util/pathSafety.js';
import { normalizePatterns } from './globPatterns.js';
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

    // Commas inside `{ts,tsx}` are brace alternatives, and `[locale]` route
    // directories are literal names — see globPatterns.ts.
    const patterns = normalizePatterns(pattern, ctx.session.projectRoot);
    const searchRoot = cwd
      ? // Resolve via path utility for safety
        (await import('../util/pathSafety.js')).resolveInsideRoot(ctx.session.projectRoot, cwd)
      : ctx.session.projectRoot;
    const ignore = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**'];

    const matches = await glob(patterns, {
      cwd: searchRoot,
      onlyFiles: true,
      ignore,
      absolute: false,
      dot: false,
    });

    const sorted = matches.sort();
    const truncated = sorted.length > limit;
    const shown = truncated ? sorted.slice(0, limit) : sorted;
    const rel = (p: string): string => {
      if (cwd) {
        const abs = `${searchRoot}/${p}`.replace(/\\/g, '/');
        return toRelative(ctx.session.projectRoot, abs);
      }
      return p.split('\\').join('/');
    };
    const displayPaths = shown.map(rel);
    let content =
      displayPaths.length === 0
        ? '(no matches)'
        : displayPaths.join('\n') + (truncated ? `\n… ${sorted.length - limit} more` : '');
    if (sorted.length === 0) {
      // A pattern like `src/app/**/signup*` usually means the directory; say
      // so instead of a bare "no matches" so the next call can be right.
      const dirs = (await glob(patterns, { cwd: searchRoot, onlyDirectories: true, ignore, absolute: false, dot: false })).sort();
      if (dirs.length > 0) {
        content =
          `(no files match, but ${dirs.length} director${dirs.length === 1 ? 'y does' : 'ies do'}: ` +
          `${dirs.slice(0, 10).map((d) => `${rel(d).replace(/\/$/, '')}/`).join(', ')}${dirs.length > 10 ? ', …' : ''} — add /** to list their files)`;
      }
    }
    return {
      summary: `${sorted.length} match${sorted.length === 1 ? '' : 'es'} for ${pattern}${truncated ? ' (truncated)' : ''}`,
      content,
      metadata: { total: sorted.length, truncated },
    };
  }
}
