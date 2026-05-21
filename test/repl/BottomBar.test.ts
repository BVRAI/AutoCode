import { describe, it, expect } from 'vitest';
import { renderBar, type BarState } from '../../src/repl/BottomBar.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;
const plain = (s: string): string => s.replace(ANSI, '');

function base(overrides: Partial<BarState> = {}): BarState {
  return {
    input: '',
    cursor: 0,
    columns: 60,
    mode: 'default',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costText: '' },
    queued: 0,
    busy: false,
    ...overrides,
  };
}

describe('renderBar', () => {
  it('renders rule / input / rule / status with footerHeight 4 when input is empty', () => {
    const l = renderBar(base());
    expect(l.footerHeight).toBe(4);
    expect(l.rows).toHaveLength(4);
    expect(plain(l.rows[0]!)).toMatch(/^─+$/);
    expect(plain(l.rows[1]!)).toContain('=>');
    expect(plain(l.rows[2]!)).toMatch(/^─+$/);
    expect(plain(l.rows[3]!)).toContain('default mode');
  });

  it('places the cursor after the "=> " prefix for empty input', () => {
    const l = renderBar(base());
    expect(l.cursorRow).toBe(1); // first input row (after the upper rule)
    expect(l.cursorCol).toBe(3); // length of "=> "
  });

  it('tracks the cursor column as the user types', () => {
    const l = renderBar(base({ input: 'hello', cursor: 5 }));
    expect(l.cursorCol).toBe(8); // 3 prefix + 5
    expect(l.rows[1]).toContain('hello');
  });

  it('grows the footer when the input wraps past the terminal width', () => {
    const long = 'x'.repeat(120); // 3 + 120 = 123 over 60 cols → 3 rows
    const l = renderBar(base({ input: long, cursor: long.length, columns: 60 }));
    expect(l.footerHeight).toBeGreaterThan(4);
  });

  it('shows the workflow mode in the status row', () => {
    expect(renderBar(base({ mode: 'planning' })).rows.at(-1)).toContain('planning mode');
    expect(renderBar(base({ mode: 'autocode' })).rows.at(-1)).toContain('autocode mode');
  });

  it('right-aligns token usage in the status row', () => {
    const l = renderBar(
      base({ usage: { inputTokens: 12000, outputTokens: 3400, cacheReadTokens: 6000, costText: '$0.06' } }),
    );
    const status = l.rows.at(-1)!;
    expect(status).toContain('in 12.0k');
    expect(status).toContain('out 3.4k');
    expect(status).toContain('$0.06');
  });

  it('shows a queued hint when prompts are queued', () => {
    expect(renderBar(base({ queued: 2 })).rows.at(-1)).toContain('2 queued');
    expect(renderBar(base({ queued: 0 })).rows.at(-1)).not.toContain('queued');
  });
});
