import { existsSync, mkdirSync, statSync } from 'node:fs';
import { PathSafetyError, resolveInsideRoot, toRelative } from '../util/pathSafety.js';
import {
  optionalBoolean,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFINITION: ToolDefinition = {
  name: 'create_directory',
  description:
    'Create a new directory under the project root. Cross-platform safe — prefer this over `mkdir` via run_shell. ' +
    'Path is resolved relative to the project root; intermediate parent directories are created automatically. ' +
    'With exist_ok=false (default), errors if the target already exists. With exist_ok=true, succeeds silently if it does.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to the project root. Do not use leading "/" or "\\".' },
      exist_ok: { type: 'boolean', description: 'If true, return success when the directory already exists. Default false.' },
    },
    required: ['path'],
  },
};

export class CreateDirectoryTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const path = requireString(args, 'path');
    const existOk = optionalBoolean(args, 'exist_ok') ?? false;

    let target: string;
    try {
      target = resolveInsideRoot(ctx.session.projectRoot, path);
    } catch (e) {
      if (e instanceof PathSafetyError) {
        return {
          summary: 'path escapes project root',
          content:
            `Refused: ${e.message}. Use a path relative to the project root — do not start with "/" or "\\" ` +
            `(on Windows a leading slash means the root of the current drive, not the project).`,
          isError: true,
        };
      }
      throw e;
    }

    const rel = toRelative(ctx.session.projectRoot, target);
    const preExisted = existsSync(target);
    if (preExisted) {
      const isDir = statSync(target).isDirectory();
      if (!isDir) {
        return {
          summary: 'path exists but is not a directory',
          content: `${rel} already exists as a file. Refusing to mkdir over it.`,
          isError: true,
        };
      }
      if (!existOk) {
        return {
          summary: `already exists: ${rel}`,
          content: `${rel} already exists. Pass exist_ok=true to ignore.`,
          isError: true,
        };
      }
      return {
        summary: `already existed: ${rel}`,
        content: 'OK',
        metadata: { path: rel, preExisted: true },
      };
    }

    mkdirSync(target, { recursive: true });
    return {
      summary: `created ${rel}`,
      content: 'OK',
      metadata: { path: rel, preExisted: false },
    };
  }
}
