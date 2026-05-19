// Minimal unified-diff renderer for line-level changes.
//
// Inspired by the diff format Aider uses to encourage robust edits
// (https://aider.chat/docs/unified-diffs.html) and the inline rendering style
// of OpenCode and Claude Code. No external dependency — implementation is a
// straightforward LCS via Myers-style dynamic programming over line arrays.

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
  oldLine?: number;
  newLine?: number;
}

const CONTEXT = 3;

export function unifiedDiff(before: string, after: string): DiffHunk[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const ops = lcsDiff(a, b);
  return groupHunks(ops, CONTEXT);
}

export function renderUnifiedDiff(
  before: string,
  after: string,
  maxHunks = 5,
): string {
  const hunks = unifiedDiff(before, after);
  if (hunks.length === 0) return '(no textual change)';
  const shown = hunks.slice(0, maxHunks);
  const out: string[] = [];
  for (const h of shown) {
    out.push(h.header);
    for (const line of h.lines) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
      out.push(`${prefix} ${line.text}`);
    }
  }
  if (hunks.length > maxHunks) {
    out.push(`… ${hunks.length - maxHunks} more hunk(s) omitted`);
  }
  return out.join('\n');
}

type Op = { kind: 'context' | 'add' | 'remove'; oldIdx: number; newIdx: number; text: string };

function lcsDiff(a: string[], b: string[]): Op[] {
  const m = a.length;
  const n = b.length;
  const dp: Uint32Array = new Uint32Array((m + 1) * (n + 1));
  const w = n + 1;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i * w + j] = dp[(i + 1) * w + j + 1] + 1;
      } else {
        const down = dp[(i + 1) * w + j];
        const right = dp[i * w + j + 1];
        dp[i * w + j] = down !== undefined && right !== undefined ? Math.max(down, right) : 0;
      }
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'context', oldIdx: i, newIdx: j, text: a[i]! });
      i++;
      j++;
    } else {
      const down = dp[(i + 1) * w + j] ?? 0;
      const right = dp[i * w + j + 1] ?? 0;
      if (down >= right) {
        ops.push({ kind: 'remove', oldIdx: i, newIdx: j, text: a[i]! });
        i++;
      } else {
        ops.push({ kind: 'add', oldIdx: i, newIdx: j, text: b[j]! });
        j++;
      }
    }
  }
  while (i < m) {
    ops.push({ kind: 'remove', oldIdx: i, newIdx: j, text: a[i]! });
    i++;
  }
  while (j < n) {
    ops.push({ kind: 'add', oldIdx: i, newIdx: j, text: b[j]! });
    j++;
  }
  return ops;
}

function groupHunks(ops: Op[], context: number): DiffHunk[] {
  const changedIdxs: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind !== 'context') changedIdxs.push(i);
  }
  if (changedIdxs.length === 0) return [];

  // Build [start, end] ranges by expanding ±context around each change and merging overlaps.
  const ranges: Array<[number, number]> = [];
  for (const idx of changedIdxs) {
    const s = Math.max(0, idx - context);
    const e = Math.min(ops.length - 1, idx + context);
    if (ranges.length > 0 && ranges[ranges.length - 1]![1] >= s - 1) {
      ranges[ranges.length - 1]![1] = Math.max(ranges[ranges.length - 1]![1], e);
    } else {
      ranges.push([s, e]);
    }
  }

  const hunks: DiffHunk[] = [];
  for (const [s, e] of ranges) {
    const first = ops[s]!;
    const last = ops[e]!;
    const oldStart = first.oldIdx + 1;
    const newStart = first.newIdx + 1;
    const oldCount = last.oldIdx - first.oldIdx + (last.kind === 'add' ? 0 : 1);
    const newCount = last.newIdx - first.newIdx + (last.kind === 'remove' ? 0 : 1);
    const header = `@@ -${oldStart},${Math.max(1, oldCount)} +${newStart},${Math.max(1, newCount)} @@`;
    const lines: DiffLine[] = [];
    for (let k = s; k <= e; k++) {
      const op = ops[k]!;
      lines.push({
        kind: op.kind,
        text: op.text,
        oldLine: op.kind === 'add' ? undefined : op.oldIdx + 1,
        newLine: op.kind === 'remove' ? undefined : op.newIdx + 1,
      });
    }
    hunks.push({ header, lines });
  }
  return hunks;
}
