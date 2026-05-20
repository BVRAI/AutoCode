import { readFileSync, writeFileSync } from 'node:fs';
import { resolveInsideRoot, toRelative } from '../util/pathSafety.js';
import {
  optionalBoolean,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFINITION: ToolDefinition = {
  name: 'edit_file',
  description:
    'Modify an existing file by replacing an exact text span. ' +
    "The old_text must occur exactly once in the file. If it doesn't match, or matches multiple " +
    'times, the edit is rejected — provide a larger unique anchor instead. ' +
    'Use replace_all to replace every occurrence.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to project root. Must exist.' },
      old_text: { type: 'string', description: 'Exact existing text to replace.' },
      new_text: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
    },
    required: ['path', 'old_text', 'new_text'],
  },
};

export class EditFileTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const path = requireString(args, 'path');
    const oldText = requireString(args, 'old_text');
    const newText = requireString(args, 'new_text');
    const replaceAll = optionalBoolean(args, 'replace_all') ?? false;
    if (oldText === newText) {
      return { summary: 'no-op', content: 'old_text equals new_text', isError: true };
    }

    const target = resolveInsideRoot(ctx.session.projectRoot, path);
    const original = readFileSync(target, 'utf8');
    const count = countOccurrences(original, oldText);

    if (count === 0) {
      return {
        summary: 'old_text not found',
        content:
          `Could not find old_text in ${toRelative(ctx.session.projectRoot, target)}. ` +
          `Read the file first and retry with the exact existing text (including whitespace).`,
        isError: true,
      };
    }
    if (count > 1 && !replaceAll) {
      return {
        summary: `ambiguous (${count} matches)`,
        content:
          `old_text appears ${count} times in ${toRelative(ctx.session.projectRoot, target)}. ` +
          `Provide a larger unique anchor, or set replace_all=true.`,
        isError: true,
      };
    }

    const updated = replaceAll
      ? original.split(oldText).join(newText)
      : original.replace(oldText, newText);
    ctx.checkpoint?.snapshotBeforeWrite(target);
    writeFileSync(target, updated, 'utf8');
    const rel = toRelative(ctx.session.projectRoot, target);
    return {
      summary: `edited ${rel} (${replaceAll ? count + ' replacements' : '1 replacement'})`,
      content: `OK: ${oldText.length} → ${newText.length} chars, ${count} replacement(s)`,
      metadata: { replacements: count, replaceAll, before: original, after: updated, path: rel },
    };
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count += 1;
    i += needle.length;
  }
  return count;
}
