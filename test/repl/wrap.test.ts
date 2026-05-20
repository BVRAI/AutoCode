import { describe, it, expect } from 'vitest';
import { countWrappedRows } from '../../src/repl/wrap.js';

describe('countWrappedRows', () => {
  it('counts one row per short line', () => {
    expect(countWrappedRows('a\nb\nc\n', 80)).toBe(3);
  });

  it('counts a line exactly columns-wide as one row', () => {
    expect(countWrappedRows('x'.repeat(80) + '\n', 80)).toBe(1);
  });

  it('counts a line one char over columns as two rows', () => {
    expect(countWrappedRows('x'.repeat(81) + '\n', 80)).toBe(2);
  });

  it('counts a line 2.5x columns-wide as three rows', () => {
    expect(countWrappedRows('x'.repeat(200) + '\n', 80)).toBe(3);
  });

  it('adds the first-line prefix width to the first segment only', () => {
    // 78 chars + 4-char prefix = 82 → wraps to 2 rows.
    expect(countWrappedRows('x'.repeat(78) + '\n', 80, 4)).toBe(2);
    // Same content on the second line (no prefix) stays at 1 row.
    expect(countWrappedRows('short\n' + 'x'.repeat(78) + '\n', 80, 4)).toBe(2);
  });

  it('ignores the trailing empty segment from a final newline', () => {
    expect(countWrappedRows('one line\n', 80)).toBe(1);
  });

  it('counts an empty line as one row', () => {
    expect(countWrappedRows('a\n\nb\n', 80)).toBe(3);
  });

  it('falls back to 80 columns when columns is non-positive', () => {
    expect(countWrappedRows('x'.repeat(160) + '\n', 0)).toBe(2);
  });
});
