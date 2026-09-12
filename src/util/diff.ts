// Line-level unified diffs with bounded LCS work. Large, unrelated middles are
// rendered as complete replacements so a preview never silently drops changes.

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
  simplified?: boolean;
}

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
  oldLine?: number;
  newLine?: number;
  // An empty ending means this is the file's final, unterminated line.
  oldLineEnding?: '\n' | '\r\n' | '';
  newLineEnding?: '\n' | '\r\n' | '';
}

const CONTEXT = 3;
const MAX_LCS_CELLS = 4_000_000;

export function unifiedDiff(before: string, after: string): DiffHunk[] {
  if (before === after) return [];
  const ops = lcsDiff(splitLines(before), splitLines(after));
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
    if (h.simplified) out.push('\\ Large change shown as a simplified replacement');
    for (const line of h.lines) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
      out.push(`${prefix} ${line.text}`);
      if (line.oldLineEnding === '' || line.newLineEnding === '') {
        out.push('\\ No newline at end of file');
      }
    }
  }
  if (hunks.length > maxHunks) {
    out.push(`… ${hunks.length - maxHunks} more hunk(s) omitted`);
  }
  return out.join('\n');
}

interface SourceLine {
  text: string;
  ending: '\n' | '\r\n' | '';
}

interface Op {
  kind: 'context' | 'add' | 'remove';
  oldIdx: number;
  newIdx: number;
  text: string;
  oldLineEnding?: SourceLine['ending'];
  newLineEnding?: SourceLine['ending'];
  simplified?: boolean;
}

function splitLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      lines.push({ text: text.slice(start), ending: '' });
      break;
    }
    const hasCarriageReturn = newline > start && text[newline - 1] === '\r';
    lines.push({
      text: text.slice(start, hasCarriageReturn ? newline - 1 : newline),
      ending: hasCarriageReturn ? '\r\n' : '\n',
    });
    start = newline + 1;
  }
  return lines;
}

function sameLine(a: SourceLine, b: SourceLine): boolean {
  return a.text === b.text && a.ending === b.ending;
}

function lcsDiff(a: SourceLine[], b: SourceLine[]): Op[] {
  // Most edits touch a small middle even in very large files. Strip identical
  // ends before deciding whether an exact LCS fits the fixed memory budget.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && sameLine(a[prefix]!, b[prefix]!)) prefix++;
  let oldEnd = a.length;
  let newEnd = b.length;
  while (oldEnd > prefix && newEnd > prefix && sameLine(a[oldEnd - 1]!, b[newEnd - 1]!)) {
    oldEnd--;
    newEnd--;
  }

  const m = oldEnd - prefix;
  const n = newEnd - prefix;
  const simplified = m > 0 && n > 0 && m + 1 > MAX_LCS_CELLS / (n + 1);
  const width = n + 1;
  // Pure creates/deletes need no matrix, regardless of their size.
  const dp = m > 0 && n > 0 && !simplified
    ? new Uint32Array((m + 1) * width)
    : undefined;
  if (dp) {
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i * width + j] = sameLine(a[prefix + i]!, b[prefix + j]!)
          ? dp[(i + 1) * width + j + 1]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
      }
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  const context = () => {
    ops.push({
      kind: 'context', oldIdx: i, newIdx: j, text: a[i]!.text,
      oldLineEnding: a[i]!.ending, newLineEnding: b[j]!.ending,
    });
    i++;
    j++;
  };
  const remove = () => {
    ops.push({
      kind: 'remove', oldIdx: i, newIdx: j, text: a[i]!.text,
      oldLineEnding: a[i]!.ending, ...(simplified ? { simplified: true } : {}),
    });
    i++;
  };
  const add = () => {
    ops.push({
      kind: 'add', oldIdx: i, newIdx: j, text: b[j]!.text,
      newLineEnding: b[j]!.ending, ...(simplified ? { simplified: true } : {}),
    });
    j++;
  };

  while (i < prefix) context();
  if (dp) {
    while (i < oldEnd && j < newEnd) {
      if (sameLine(a[i]!, b[j]!)) {
        context();
      } else {
        const down = dp[(i - prefix + 1) * width + j - prefix]!;
        const right = dp[(i - prefix) * width + j - prefix + 1]!;
        // Prefer removal when paths tie, making repeated text deterministic.
        if (down >= right) remove();
        else add();
      }
    }
  }
  // Above the budget, include the entire changed middle as delete/add rows.
  while (i < oldEnd) remove();
  while (j < newEnd) add();
  while (i < a.length) context();
  return ops;
}

function groupHunks(ops: Op[], context: number): DiffHunk[] {
  // Expand changes by the requested context and merge touching ranges.
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind === 'context') continue;
    const start = Math.max(0, i - context);
    const end = Math.min(ops.length - 1, i + context);
    const previous = ranges[ranges.length - 1];
    if (previous && previous[1] >= start - 1) previous[1] = end;
    else ranges.push([start, end]);
  }

  const hunks: DiffHunk[] = [];
  for (const [start, end] of ranges) {
    const first = ops[start]!;
    const lines: DiffLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    let simplified = false;
    for (let k = start; k <= end; k++) {
      const op = ops[k]!;
      if (op.kind !== 'add') oldCount++;
      if (op.kind !== 'remove') newCount++;
      if (op.simplified) simplified = true;
      lines.push({
        kind: op.kind,
        text: op.text,
        oldLine: op.kind === 'add' ? undefined : op.oldIdx + 1,
        newLine: op.kind === 'remove' ? undefined : op.newIdx + 1,
        oldLineEnding: op.oldLineEnding,
        newLineEnding: op.newLineEnding,
      });
    }
    // Empty sides use the preceding line position, including 0 for an empty file.
    const oldStart = first.oldIdx + (oldCount > 0 ? 1 : 0);
    const newStart = first.newIdx + (newCount > 0 ? 1 : 0);
    const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
    hunks.push({ header, lines, ...(simplified ? { simplified: true } : {}) });
  }
  return hunks;
}
