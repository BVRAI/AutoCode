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
      const base =
        `Could not find old_text in ${toRelative(ctx.session.projectRoot, target)}. ` +
        `Read the file first and retry with the exact existing text (including whitespace).`;
      const hint = noMatchHint(original, oldText);
      return {
        summary: 'old_text not found',
        content: hint ? `${base}\n\n${hint}` : base,
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

// On a failed exact match, explain WHY — usually a whitespace/indentation
// mismatch (the #1 "edit didn't apply" failure mode). Returns a hint the model
// can act on in a single retry, or null if nothing useful was found. Runs only
// on the error path, so a little extra scanning is fine.
const HINT_SNIPPET_CAP = 1500;

function noMatchHint(original: string, oldText: string): string | null {
  const fileLines = original.split(/\r?\n/);
  const oldLines = trimBlankEnds(oldText.split(/\r?\n/));
  if (oldLines.length === 0) return null;

  const norm = (s: string): string => s.trim().replace(/\s+/g, ' ');
  const normFile = fileLines.map(norm);
  const normOld = oldLines.map(norm);
  const w = normOld.length;

  // 1) Whitespace-insensitive window match — the high-value case. Locate where
  // the block matches ignoring indentation/spacing, then hand back the EXACT
  // current bytes so the model retries verbatim.
  for (let i = 0; i + w <= normFile.length; i++) {
    let ok = true;
    for (let j = 0; j < w; j++) {
      if (normFile[i + j] !== normOld[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const snippet = cap(fileLines.slice(i, i + w).join('\n'));
      return (
        `A whitespace-only difference was found at lines ${i + 1}-${i + w}. ` +
        `The file currently has this exact text — retry old_text with it verbatim:\n${snippet}`
      );
    }
  }

  // 2) Closest-line fallback — point the model at the most similar region.
  const firstOld = normOld[0]!;
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < normFile.length; i++) {
    const score = lineSimilarity(normFile[i]!, firstOld);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0 && bestScore >= 0.5) {
    const s = Math.max(0, bestIdx - 3);
    const e = Math.min(fileLines.length - 1, bestIdx + 3);
    const region = fileLines.slice(s, e + 1).map((l, k) => `${s + k + 1}: ${l}`).join('\n');
    return `No close match. The most similar line is ${bestIdx + 1}; here is that region:\n${cap(region)}`;
  }
  return null;
}

function trimBlankEnds(lines: string[]): string[] {
  let s = 0;
  let e = lines.length;
  while (s < e && lines[s]!.trim() === '') s++;
  while (e > s && lines[e - 1]!.trim() === '') e--;
  return lines.slice(s, e);
}

// Jaccard overlap of whitespace-split tokens — cheap, dependency-free, enough
// to point the model at the right line.
function lineSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

function cap(s: string): string {
  return s.length > HINT_SNIPPET_CAP ? s.slice(0, HINT_SNIPPET_CAP) + '\n… (truncated)' : s;
}
