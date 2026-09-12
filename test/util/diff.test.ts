import { describe, it, expect, vi } from 'vitest';
import { unifiedDiff, renderUnifiedDiff, type DiffHunk } from '../../src/util/diff.js';

// Apply the public hunks to the original bytes, checking both line counters and
// headers. This catches missing/duplicated rows without relying on LCS choices.
function expectReconstruction(before: string, after: string, hunks = unifiedDiff(before, after)): void {
  const oldLines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const result: string[] = [];
  let oldCursor = 0;
  for (const hunk of hunks) {
    const match = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(hunk.header);
    expect(match).not.toBeNull();
    const [, oldStart, oldCount, newStart, newCount] = match!.map(Number);
    const offset = oldCount === 0 ? oldStart! : oldStart! - 1;
    expect(offset).toBeGreaterThanOrEqual(oldCursor);
    result.push(...oldLines.slice(oldCursor, offset));
    oldCursor = offset;
    expect(newCount === 0 ? newStart : newStart! - 1).toBe(result.length);
    let consumed = 0;
    let produced = 0;
    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        expect(line.oldLine).toBeUndefined();
        expect(line.oldLineEnding).toBeUndefined();
      } else {
        expect(line.oldLine).toBe(oldCursor + 1);
        expect(line.oldLineEnding).toBeDefined();
        expect(line.text + line.oldLineEnding).toBe(oldLines[oldCursor]);
        oldCursor++;
        consumed++;
      }
      if (line.kind === 'remove') {
        expect(line.newLine).toBeUndefined();
        expect(line.newLineEnding).toBeUndefined();
      } else {
        expect(line.newLine).toBe(result.length + 1);
        expect(line.newLineEnding).toBeDefined();
        result.push(line.text + line.newLineEnding);
        produced++;
      }
    }
    expect(consumed).toBe(oldCount);
    expect(produced).toBe(newCount);
  }
  result.push(...oldLines.slice(oldCursor));
  expect(result.join('')).toBe(after);
}

function captureMatrixAllocations(work: () => DiffHunk[]): { hunks: DiffHunk[]; allocations: number[] } {
  const OriginalUint32Array = globalThis.Uint32Array;
  const allocations: number[] = [];
  vi.stubGlobal('Uint32Array', class extends OriginalUint32Array {
    constructor(length: number) {
      if (length > 4_000_000) throw new Error(`Unbounded diff matrix: ${length} cells`);
      super(length);
      allocations.push(length);
    }
  });
  try {
    return { hunks: work(), allocations };
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('unifiedDiff', () => {
  it('returns no hunks when before === after', () => {
    expect(unifiedDiff('hello\nworld\n', 'hello\nworld\n')).toEqual([]);
  });

  it('detects a single-line change', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'a\nb\nB\nd\ne\n';
    const hunks = unifiedDiff(before, after);
    expect(hunks).toHaveLength(1);
    const kinds = hunks[0]!.lines.map((l) => l.kind);
    expect(kinds).toContain('remove');
    expect(kinds).toContain('add');
    const removed = hunks[0]!.lines.find((l) => l.kind === 'remove');
    const added = hunks[0]!.lines.find((l) => l.kind === 'add');
    expect(removed?.text).toBe('c');
    expect(added?.text).toBe('B');
  });

  it('keeps changes in separate hunks when far apart', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n');
    const after = ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'K'].join('\n');
    const hunks = unifiedDiff(before, after);
    expect(hunks.length).toBeGreaterThanOrEqual(2);
  });

  it('handles pure insertion', () => {
    const hunks = unifiedDiff('a\nb\n', 'a\nNEW\nb\n');
    const adds = hunks[0]!.lines.filter((l) => l.kind === 'add');
    expect(adds.map((l) => l.text)).toContain('NEW');
  });

  it('handles pure deletion', () => {
    const hunks = unifiedDiff('a\nb\nc\n', 'a\nc\n');
    const removes = hunks[0]!.lines.filter((l) => l.kind === 'remove');
    expect(removes.map((l) => l.text)).toContain('b');
  });

  it.each(['', '\n', '\r\n', 'one', 'one\n', 'one\r\n', '\n\n', 'one\n\n'])(
    'creates and deletes %j with exact empty-side ranges', (content) => {
      const created = unifiedDiff('', content);
      const deleted = unifiedDiff(content, '');
      expectReconstruction('', content, created);
      expectReconstruction(content, '', deleted);
      if (!content) {
        expect(created).toEqual([]);
        expect(deleted).toEqual([]);
        return;
      }
      const count = (content.match(/[^\n]*\n|[^\n]+$/g) ?? []).length;
      expect(created).toHaveLength(1);
      expect(deleted).toHaveLength(1);
      expect(created[0]!.header).toBe(`@@ -0,0 +1,${count} @@`);
      expect(deleted[0]!.header).toBe(`@@ -1,${count} +0,0 @@`);
      expect(created[0]!.lines.every((line) => line.kind === 'add')).toBe(true);
      expect(deleted[0]!.lines.every((line) => line.kind === 'remove')).toBe(true);
    },
  );

  it.each([
    ['a\n', 'a'],
    ['a', 'a\n'],
    ['a\r\n', 'a\n'],
    ['a\n', 'a\r\n'],
    ['a\r', 'a\r\n'],
    ['a\n\n\nb\n', 'a\n\nb\n\n'],
    ['a\r\n\r\nb\r\n', 'a\r\n\r\nB\r\n'],
    ['a\r\nb\nc', 'A\nb\r\nc\n'],
  ])('preserves blank lines and terminators from %j to %j', (before, after) => {
    expectReconstruction(before, after);
    expectReconstruction(after, before);
  });

  it('records newline-only changes without inventing a final blank line', () => {
    const lines = unifiedDiff('a\n', 'a')[0]!.lines;
    expect(lines).toEqual([
      expect.objectContaining({ kind: 'remove', text: 'a', oldLine: 1, oldLineEnding: '\n' }),
      expect.objectContaining({ kind: 'add', text: 'a', newLine: 1, newLineEnding: '' }),
    ]);
    const crlf = unifiedDiff('a\r\n', 'a\n')[0]!.lines;
    expect(crlf[0]).toMatchObject({ text: 'a', oldLineEnding: '\r\n' });
    expect(crlf[1]).toMatchObject({ text: 'a', newLineEnding: '\n' });
  });

  it('maintains different old/new counters across separated inserts and deletes', () => {
    const lines = Array.from({ length: 45 }, (_, i) => `line ${i + 1}\n`);
    const after = [...lines];
    after.splice(30, 3);
    after.splice(3, 0, 'insert 1\n', 'insert 2\n');
    after.push('last');
    const hunks = unifiedDiff(lines.join(''), after.join(''));
    expect(hunks).toHaveLength(3);
    expectReconstruction(lines.join(''), after.join(''), hunks);
    expectReconstruction(after.join(''), lines.join(''));
  });

  it('chooses repeated-text matches deterministically', () => {
    const before = 'start\na\nb\na\nb\nend\n';
    const after = 'start\nb\na\nb\na\nend\n';
    const hunks = unifiedDiff(before, after);
    expect(unifiedDiff(before, after)).toEqual(hunks);
    expect(hunks[0]!.lines.filter((line) => line.kind !== 'context')).toEqual([
      expect.objectContaining({ kind: 'remove', text: 'a', oldLine: 2 }),
      expect.objectContaining({ kind: 'add', text: 'a', newLine: 5 }),
    ]);
    expectReconstruction(before, after, hunks);
  });

  it('reconstructs every pairing of small files, repeated text and line endings', () => {
    const candidates = [''];
    for (const first of ['a', 'b', '']) {
      for (const second of ['a', 'b', '']) {
        for (const ending of ['', '\n', '\r\n']) {
          candidates.push(first + '\n' + second + ending);
        }
      }
    }
    for (const before of candidates) {
      for (const after of candidates) expectReconstruction(before, after);
    }
  });

  it('strips large shared ends before allocating the LCS matrix', () => {
    const prefix = 'prefix\n'.repeat(15_000);
    const suffix = 'suffix\n'.repeat(15_000);
    const before = prefix + 'old\n' + suffix;
    const after = prefix + 'new\n' + suffix;
    const { hunks, allocations } = captureMatrixAllocations(() => unifiedDiff(before, after));
    expect(allocations).toEqual([4]);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.simplified).toBeUndefined();
    expect(hunks[0]!.lines).toHaveLength(8);
    expectReconstruction(before, after, hunks);
  });

  it('uses a complete, marked replacement above the matrix budget', () => {
    const prefix = 'prefix\n'.repeat(8);
    const suffix = 'suffix\n'.repeat(8);
    const before = prefix + 'old\n'.repeat(2_200) + 'shared middle\nold end\n' + suffix;
    const after = prefix + 'new\n'.repeat(2_200) + 'shared middle\nnew end\n' + suffix;
    const { hunks, allocations } = captureMatrixAllocations(() => unifiedDiff(before, after));
    expect(allocations).toEqual([]);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.simplified).toBe(true);
    expect(hunks[0]!.lines.filter((line) => line.kind === 'remove')).toHaveLength(2_202);
    expect(hunks[0]!.lines.filter((line) => line.kind === 'add')).toHaveLength(2_202);
    expect(hunks[0]!.lines.filter((line) => line.kind === 'context')).toHaveLength(6);
    expectReconstruction(before, after, hunks);
  });

  it('allows the exact matrix budget and falls back immediately beyond it', () => {
    const exact = captureMatrixAllocations(() => unifiedDiff('a\n'.repeat(1_999), 'b\n'.repeat(1_999)));
    expect(exact.allocations).toEqual([4_000_000]);
    expect(exact.hunks[0]!.simplified).toBeUndefined();
    const simplified = captureMatrixAllocations(() => unifiedDiff('a\n'.repeat(2_000), 'b\n'.repeat(2_000)));
    expect(simplified.allocations).toEqual([]);
    expect(simplified.hunks[0]!.simplified).toBe(true);
  });

  it('needs no LCS matrix for large pure creation or deletion', () => {
    const content = 'a\n'.repeat(10_000);
    for (const [before, after] of [['', content], [content, '']] as const) {
      const { hunks, allocations } = captureMatrixAllocations(() => unifiedDiff(before, after));
      expect(allocations).toEqual([]);
      expect(hunks[0]!.simplified).toBeUndefined();
      expect(hunks[0]!.lines).toHaveLength(10_000);
      expectReconstruction(before, after, hunks);
    }
  });
});

describe('renderUnifiedDiff', () => {
  it('formats with @@ header and +/- prefixes', () => {
    const out = renderUnifiedDiff('a\nb\nc\n', 'a\nB\nc\n');
    expect(out).toMatch(/@@/);
    expect(out).toMatch(/^- b$/m);
    expect(out).toMatch(/^\+ B$/m);
  });

  it('says no change when inputs are identical', () => {
    expect(renderUnifiedDiff('x\n', 'x\n')).toBe('(no textual change)');
  });

  it('renders the standard marker directly after an unterminated line', () => {
    expect(renderUnifiedDiff('a\n', 'a')).toBe('@@ -1,1 +1,1 @@\n- a\n+ a\n\\ No newline at end of file');
    expect(renderUnifiedDiff('a', 'a\n')).toBe('@@ -1,1 +1,1 @@\n- a\n\\ No newline at end of file\n+ a');
    expect(renderUnifiedDiff('a\nlast', 'b\nlast')).toContain('  last\n\\ No newline at end of file');
  });

  it('makes simplified replacements explicit', () => {
    const output = renderUnifiedDiff('a\n'.repeat(2_000), 'b\n'.repeat(2_000));
    expect(output).toContain('\\ Large change shown as a simplified replacement');
    expect(output.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2_000);
    expect(output.split('\n').filter((line) => line.startsWith('+ '))).toHaveLength(2_000);
  });

  it('retains the terminal hunk limit and reports omissions', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join('');
    const after = before.replace('line 1\n', 'changed 1\n').replace('line 30\n', 'changed 30\n');
    const output = renderUnifiedDiff(before, after, 1);
    expect(output.match(/^@@ /gm)).toHaveLength(1);
    expect(output).toContain('… 1 more hunk(s) omitted');
  });
});
