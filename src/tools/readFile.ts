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

// Line-based slicing, the convention every current harness uses (Claude
// Code's Read: offset + limit in lines). The previous byte-based offset/length
// made models that think in lines read "15 bytes" forty times in a row.
const DEFAULT_LIMIT = 2_000; // lines
const MAX_BYTES = 50_000; // hard cap on one result, whatever the line count

const DEFINITION: ToolDefinition = {
  name: 'read_file',
  description:
    'Read a text file under the project root as numbered lines. Reads the whole file when it fits ' +
    `(up to ${DEFAULT_LIMIT} lines / ${Math.round(MAX_BYTES / 1000)} KB); for larger files, or to look at one region, ` +
    'pass offset (the first line to read, 1-based) and limit (how many lines). The result says which ' +
    'lines of how many were returned. Refuses binary files.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to project root.' },
      offset: { type: 'number', description: 'First line to read, 1-based. Default 1.' },
      limit: { type: 'number', description: `Number of lines to read. Default ${DEFAULT_LIMIT}.` },
    },
    required: ['path'],
  },
};

export class ReadFileTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const path = requireString(args, 'path');
    const offsetArg = optionalNumber(args, 'offset') ?? 1;
    // `length` is the pre-line-semantics name; treat it as lines too.
    const limitArg = optionalNumber(args, 'limit') ?? optionalNumber(args, 'length') ?? DEFAULT_LIMIT;
    const startLine = Math.max(1, Math.floor(offsetArg));
    const limit = Math.max(1, Math.floor(limitArg));

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
    const rel = toRelative(ctx.session.projectRoot, target);
    const all = buf.toString('utf8').split(/\r?\n/);
    // A trailing newline yields one empty pseudo-line; don't count it.
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    const totalLines = all.length;
    if (startLine > totalLines) {
      return {
        summary: `${rel}: offset ${startLine} is past the end (${totalLines} lines)`,
        content: `${rel} has ${totalLines} lines; offset ${startLine} is past the end.`,
        isError: true,
        metadata: { totalLines, startLine, endLine: startLine - 1, truncated: false },
      };
    }

    const wantedEnd = Math.min(totalLines, startLine + limit - 1);
    const out: string[] = [];
    let bytes = 0;
    let endLine = startLine - 1;
    let byteCapped = false;
    for (let i = startLine; i <= wantedEnd; i++) {
      const line = all[i - 1]!;
      const size = Buffer.byteLength(line, 'utf8') + 1;
      if (bytes + size > MAX_BYTES && out.length > 0) {
        byteCapped = true;
        break;
      }
      out.push(`${i.toString().padStart(6, ' ')}\t${line}`);
      bytes += size;
      endLine = i;
    }
    const truncated = endLine < totalLines;
    const tail = truncated
      ? `\n… ${totalLines - endLine} more line${totalLines - endLine === 1 ? '' : 's'} (read_file with offset=${endLine + 1}${byteCapped ? '; this slice hit the size cap' : ''})`
      : '';
    return {
      summary: `${rel}: lines ${startLine}–${endLine} of ${totalLines}${truncated ? ' (truncated)' : ''}`,
      content: out.join('\n') + tail,
      metadata: {
        bytes,
        totalBytes: buf.length,
        totalLines,
        startLine,
        endLine,
        truncated,
      },
    };
  }
}
