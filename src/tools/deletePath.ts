import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PathSafetyError, resolveInsideRoot, toRelative } from '../util/pathSafety.js';
import {
  optionalString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFINITION: ToolDefinition = {
  name: 'delete_path',
  description:
    'Delete files or directories inside the project. Deletions are NOT permanent — they move to ' +
    'a recoverable trash can (restorable for 7 days via /trash). Prefer this over `rm` via run_shell ' +
    'so deletions stay recoverable. Paths are project-root scoped; system zones cannot be touched.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Paths (relative to project root) to delete.' },
      path: { type: 'string', description: 'A single path to delete (alternative to paths).' },
    },
  },
};

interface Target {
  abs: string;
  rel: string;
  kind: 'file' | 'dir';
  files: number;
  dirs: number;
}

export class DeletePathTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const raw: string[] = [];
    if (Array.isArray(args.paths)) {
      for (const p of args.paths) if (typeof p === 'string') raw.push(p);
    }
    const single = optionalString(args, 'path');
    if (single) raw.push(single);
    if (raw.length === 0) {
      return { summary: 'no paths', content: 'Provide a `paths` array or a `path` string.', isError: true };
    }

    if (!ctx.checkpoint) {
      return {
        summary: 'delete unavailable',
        content: 'No checkpoint store attached — refusing to delete without a recoverable trash.',
        isError: true,
      };
    }

    const targets: Target[] = [];
    for (const p of raw) {
      let abs: string;
      try {
        abs = resolveInsideRoot(ctx.session.projectRoot, p);
      } catch (e) {
        if (e instanceof PathSafetyError) {
          return { summary: 'refused', content: `Refused: ${e.message}`, isError: true };
        }
        throw e;
      }
      const info = inspect(abs);
      targets.push({ abs, rel: toRelative(ctx.session.projectRoot, abs), ...info });
    }

    // Autocode mode: scale a confirmation by blast radius. A single file or a
    // small flat directory is trashed silently (recoverable); a directory with
    // subdirectories or many files gets one confirmation. (default mode is
    // already gated by the agent loop; planning mode never reaches here.)
    if (ctx.session.mode === 'autocode' && ctx.confirm) {
      const large = targets.some((t) => t.kind === 'dir' && (t.dirs > 0 || t.files > 5));
      if (large) {
        const summary = targets
          .map((t) => `${t.rel} (${t.kind === 'dir' ? `${t.files} files, ${t.dirs} subdirs` : 'file'})`)
          .join(', ');
        const ok = await ctx.confirm(`[autocode] Delete ${summary}? Recoverable from trash. Proceed?`);
        if (!ok) {
          return { summary: 'user declined', content: 'User declined the deletion.', isError: true, metadata: { declined: true } };
        }
      }
    }

    const trashed: string[] = [];
    for (const t of targets) {
      ctx.checkpoint.trash(t.abs);
      trashed.push(t.rel);
    }
    return {
      summary: `moved ${trashed.length} path${trashed.length === 1 ? '' : 's'} to trash`,
      content: `Moved to the recoverable trash (restore with /trash):\n${trashed.join('\n')}`,
      metadata: { trashed },
    };
  }
}

function inspect(absPath: string): { kind: 'file' | 'dir'; files: number; dirs: number } {
  if (!statSync(absPath).isDirectory()) return { kind: 'file', files: 1, dirs: 0 };
  let files = 0;
  let dirs = 0;
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        dirs += 1;
        walk(full);
      } else {
        files += 1;
      }
    }
  };
  walk(absPath);
  return { kind: 'dir', files, dirs };
}
