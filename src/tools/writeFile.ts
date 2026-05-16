import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
  name: 'write_file',
  description:
    'Create a new file (default) or overwrite an existing one. ' +
    'mode="create_only" refuses to clobber existing files; mode="overwrite" rewrites them. ' +
    'Prefer edit_file for small changes to existing files — overwrite is for full rewrites.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to project root.' },
      content: { type: 'string', description: 'Full file contents.' },
      mode: { type: 'string', enum: ['create_only', 'overwrite'], description: 'Default create_only.' },
    },
    required: ['path', 'content'],
  },
};

export class WriteFileTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const path = requireString(args, 'path');
    const content = requireString(args, 'content');
    const mode = (optionalString(args, 'mode') ?? 'create_only') as 'create_only' | 'overwrite';
    if (mode !== 'create_only' && mode !== 'overwrite') {
      return { summary: 'bad mode', content: `unknown mode: ${mode}`, isError: true };
    }

    const target = resolveInsideRoot(ctx.session.projectRoot, path);
    const exists = existsSync(target);
    if (exists && mode === 'create_only') {
      return {
        summary: 'file exists',
        content:
          `${toRelative(ctx.session.projectRoot, target)} already exists. ` +
          `Use edit_file for partial changes, or set mode="overwrite" to replace.`,
        isError: true,
      };
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    return {
      summary: `${exists ? 'overwrote' : 'created'} ${toRelative(ctx.session.projectRoot, target)} (${content.length} bytes)`,
      content: `OK`,
      metadata: { bytes: content.length, mode, existed: exists },
    };
  }
}
