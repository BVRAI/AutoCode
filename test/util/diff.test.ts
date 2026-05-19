import { describe, it, expect } from 'vitest';
import { unifiedDiff, renderUnifiedDiff } from '../../src/util/diff.js';

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
});
