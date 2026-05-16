import { readFileSync } from 'node:fs';
import { glob } from 'tinyglobby';
import { resolveInsideRoot, toRelative } from '../util/pathSafety.js';
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFAULT_MAX_MATCHES = 200;
const MAX_FILE_BYTES = 1_000_000;

const DEFINITION: ToolDefinition = {
  name: 'grep',
  description:
    'Search file contents for a regex pattern. Returns matching lines with paths and line numbers. ' +
    'Use this when you need to find code or text inside files; use glob when you need to find files by name. ' +
    'Skips binaries, node_modules, .git, dist, build, coverage by default.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regex pattern.' },
      glob: { type: 'string', description: 'Optional glob filter, e.g. "**/*.ts" or "src/**/*.{ts,tsx}".' },
      case_insensitive: { type: 'boolean', description: 'Case-insensitive search. Default false.' },
      max_matches: { type: 'number', description: `Max matches returned. Default ${DEFAULT_MAX_MATCHES}.` },
      path: { type: 'string', description: 'Subdirectory to search under (relative). Default project root.' },
    },
    required: ['pattern'],
  },
};

export class GrepTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const pattern = requireString(args, 'pattern');
    const filterGlob = optionalString(args, 'glob');
    const caseInsensitive = optionalBoolean(args, 'case_insensitive') ?? false;
    const maxMatches = optionalNumber(args, 'max_matches') ?? DEFAULT_MAX_MATCHES;
    const subpath = optionalString(args, 'path');

    const searchRoot = subpath
      ? resolveInsideRoot(ctx.session.projectRoot, subpath)
      : ctx.session.projectRoot;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseInsensitive ? 'i' : '');
    } catch (e) {
      return {
        summary: 'invalid regex',
        content: `Could not compile regex /${pattern}/: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }

    const files = await glob(filterGlob ?? '**/*', {
      cwd: searchRoot,
      onlyFiles: true,
      ignore: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/coverage/**',
        '**/*.{png,jpg,jpeg,gif,bmp,ico,webp,svg,pdf,zip,gz,tar,exe,dll,so,dylib,bin,wasm,mp3,mp4,mov,avi}',
      ],
      absolute: true,
      dot: false,
    });

    const matches: string[] = [];
    let total = 0;
    for (const file of files) {
      let buf: Buffer;
      try {
        buf = readFileSync(file);
      } catch {
        continue;
      }
      if (buf.length > MAX_FILE_BYTES) continue;
      if (buf.includes(0)) continue;
      const text = buf.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          total += 1;
          if (matches.length < maxMatches) {
            const rel = toRelative(ctx.session.projectRoot, file);
            matches.push(`${rel}:${i + 1}: ${lines[i]!.slice(0, 400)}`);
          }
        }
      }
    }
    const truncated = total > matches.length;
    const content = matches.length === 0
      ? '(no matches)'
      : matches.join('\n') + (truncated ? `\n… ${total - matches.length} more matches` : '');
    return {
      summary: `${total} match${total === 1 ? '' : 'es'} for /${pattern}/${caseInsensitive ? 'i' : ''}${truncated ? ' (truncated)' : ''}`,
      content,
      metadata: { total, truncated, filesScanned: files.length },
    };
  }
}
