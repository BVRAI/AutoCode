import { readFileSync, statSync } from 'node:fs';
import { resolveInsideRoot, toRelative } from '../util/pathSafety.js';
import {
  optionalNumber,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFAULT_LENGTH = 50_000; // bytes

const DEFINITION: ToolDefinition = {
  name: 'read_file',
  description:
    'Read text contents of a file under the project root. Returns numbered lines. ' +
    'Refuses binary files (null-byte heuristic). Use offset/length to read a slice of a large file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to project root.' },
      offset: { type: 'number', description: 'Byte offset to start reading at. Default 0.' },
      length: { type: 'number', description: `Bytes to read. Default ${DEFAULT_LENGTH}.` },
    },
    required: ['path'],
  },
};

export class ReadFileTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const path = requireString(args, 'path');
    const offset = optionalNumber(args, 'offset') ?? 0;
    const length = optionalNumber(args, 'length') ?? DEFAULT_LENGTH;

    const target = resolveInsideRoot(ctx.session.projectRoot, path);
    const stat = statSync(target);
    if (stat.isDirectory()) {
      return { summary: `not a file`, content: `${path} is a directory`, isError: true };
    }
    const buf = readFileSync(target);
    if (buf.includes(0)) {
      return {
        summary: `binary file refused`,
        content: `${path} appears to be binary (contains null byte)`,
        isError: true,
      };
    }
    const slice = buf.subarray(offset, offset + length);
    const text = slice.toString('utf8');
    const lines = text.split(/\r?\n/);
    const startLine =
      offset === 0 ? 1 : buf.subarray(0, offset).toString('utf8').split(/\r?\n/).length;
    const numbered = lines
      .map((l, i) => `${(startLine + i).toString().padStart(6, ' ')}\t${l}`)
      .join('\n');
    const truncated = offset + length < buf.length;
    return {
      summary: `${toRelative(ctx.session.projectRoot, target)}: ${lines.length} lines, ${slice.length} bytes${truncated ? ' (truncated)' : ''}`,
      content: numbered,
      metadata: {
        bytes: slice.length,
        totalBytes: buf.length,
        truncated,
        startLine,
      },
    };
  }
}
