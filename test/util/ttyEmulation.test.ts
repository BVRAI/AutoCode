import { describe, it, expect } from 'vitest';
import { filterResizeMarks, resizeMark, RESIZE_MARK_RE } from '../../src/util/ttyEmulation.js';

describe('resize marker filter', () => {
  it('strips complete markers and applies them', () => {
    const seen: string[] = [];
    const r = filterResizeMarks(`abc${resizeMark(80, 24)}def${resizeMark(120, 40)}`, (c, w) => seen.push(`${c}x${w}`));
    expect(r.out).toBe('abcdef');
    expect(r.pending).toBe('');
    expect(seen).toEqual(['80x24', '120x40']);
  });

  it('holds a split marker until the rest arrives', () => {
    const seen: string[] = [];
    const first = filterResizeMarks('typed [[amx:resi', (c, w) => seen.push(`${c}x${w}`));
    expect(first.out).toBe('typed ');
    expect(first.pending).toBe('[[amx:resi');
    const second = filterResizeMarks(`${first.pending}ze:80x24]] more`, (c, w) => seen.push(`${c}x${w}`));
    expect(second.out).toBe(' more');
    expect(second.pending).toBe('');
    expect(seen).toEqual(['80x24']);
  });

  it('leaves ordinary brackets alone', () => {
    const r = filterResizeMarks('arr[[0]] and [[note]]', () => undefined);
    expect(r.out).toBe('arr[[0]] and [[note]]');
    expect(r.pending).toBe('');
    expect('[[amx:resize:80x24]]').toMatch(RESIZE_MARK_RE);
  });
});
