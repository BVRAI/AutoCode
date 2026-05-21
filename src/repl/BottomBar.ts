import pc from 'picocolors';
import type { AgentMode } from '../session/SessionContext.js';
import type { Screen } from './Screen.js';

const PROMPT = '=> ';
export const MAX_INPUT_ROWS = 6;

export interface BarUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costText: string; // pre-formatted, e.g. "$0.06" or ''
}

export interface ChoiceView {
  options: string[];
  highlight: number;
  checked: Set<number>;
  multiSelect: boolean;
}

export interface BarState {
  input: string;
  cursor: number; // index into input
  columns: number;
  mode: AgentMode;
  usage: BarUsage;
  queued: number;
  busy: boolean;
  choice?: ChoiceView; // when set, the bar shows a multiple-choice picker
}

export interface BarLayout {
  rows: string[]; // colored footer rows, top to bottom
  footerHeight: number;
  cursorRow: number; // 0-indexed within the footer
  cursorCol: number; // 0-indexed
}

// Pure render of the footer block: upper rule, input row(s), lower rule,
// status (mode left / usage right). Also returns where the terminal cursor
// should sit within the footer.
export function renderBar(state: BarState): BarLayout {
  const cols = Math.max(20, state.columns);
  const rule = pc.dim('─'.repeat(cols));

  if (state.choice) return renderChoice(state, cols, rule);

  // Wrap "=> " + input into display rows.
  const full = PROMPT + state.input;
  const allRows: string[] = [];
  for (let i = 0; i < full.length; i += cols) allRows.push(full.slice(i, i + cols));
  if (allRows.length === 0) allRows.push('');

  const cursorIdx = PROMPT.length + state.cursor;
  const cursorRowAll = Math.floor(cursorIdx / cols);
  const cursorColAll = cursorIdx % cols;

  // If the input is taller than the cap, show the window containing the cursor.
  let start = 0;
  if (allRows.length > MAX_INPUT_ROWS) {
    start = Math.min(cursorRowAll, allRows.length - MAX_INPUT_ROWS);
    start = Math.max(0, start);
  }
  const inputRows = allRows.slice(start, start + MAX_INPUT_ROWS);

  const status = renderStatus(state, cols);

  const rows: string[] = [rule, ...inputRows.map((r) => pc.cyan(r)), rule, status];
  return {
    rows,
    footerHeight: rows.length,
    cursorRow: 1 + (cursorRowAll - start), // +1 for the upper rule
    cursorCol: cursorColAll,
  };
}

// The footer as a multiple-choice picker: rule, one row per option, rule,
// a mode + hint status line.
function renderChoice(state: BarState, cols: number, rule: string): BarLayout {
  const c = state.choice!;
  const optionRows = c.options.map((opt, i) => {
    const marker = i === c.highlight ? '>' : ' ';
    const box = c.multiSelect ? `[${c.checked.has(i) ? 'x' : ' '}] ` : '';
    const letter = String.fromCharCode(65 + i);
    const raw = `${marker} ${box}${letter}) ${opt}`.slice(0, cols);
    return i === c.highlight ? pc.cyan(raw) : raw;
  });
  const paint = state.mode === 'planning' ? pc.yellow : state.mode === 'autocode' ? pc.green : pc.cyan;
  const hint = c.multiSelect ? '↑↓ move · space check · enter submit' : '↑↓ move · enter select';
  const left = `▸ ${state.mode} mode`;
  const gap = Math.max(1, cols - left.length - hint.length);
  const status = paint(left) + ' '.repeat(gap) + pc.dim(hint);
  const rows = [rule, ...optionRows, rule, status];
  return {
    rows,
    footerHeight: rows.length,
    cursorRow: 1 + c.highlight, // +1 for the upper rule
    cursorCol: 0,
  };
}

function renderStatus(state: BarState, cols: number): string {
  const modePlain = `▸ ${state.mode} mode`;
  const paint = state.mode === 'planning' ? pc.yellow : state.mode === 'autocode' ? pc.green : pc.cyan;
  const left = paint(modePlain);

  const u = state.usage;
  const parts = [`in ${kfmt(u.inputTokens)}`, `out ${kfmt(u.outputTokens)}`];
  if (u.inputTokens > 0) {
    parts.push(`cache ${Math.round((u.cacheReadTokens / Math.max(1, u.inputTokens)) * 100)}%`);
  }
  if (u.costText) parts.push(u.costText);
  const usagePlain = `(${parts.join(' · ')})`;
  const queuedPlain = state.queued > 0 ? `${state.queued} queued  ` : '';
  const rightPlain = queuedPlain + usagePlain;

  const gap = cols - modePlain.length - rightPlain.length;
  if (gap < 1) {
    // Too narrow — just show the mode.
    return left;
  }
  const right = (state.queued > 0 ? pc.yellow(queuedPlain) : '') + pc.dim(usagePlain);
  return left + ' '.repeat(gap) + right;
}

function kfmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Draws the footer to the terminal via the Screen, and (when idle) leaves the
// terminal cursor inside the input box. When busy, the caller wraps this in
// save/restore so streaming output is not disturbed.
export class BottomBar {
  constructor(private readonly screen: Screen) {}

  draw(state: BarState): BarLayout {
    const layout = renderBar({ ...state, columns: this.screen.columns });
    this.screen.setFooterHeight(layout.footerHeight);
    for (let i = 0; i < layout.rows.length; i++) {
      this.screen.moveInFooter(i + 1);
      this.screen.clearLine();
      this.screen.write(layout.rows[i]!);
    }
    return layout;
  }

  // Place the terminal cursor inside the input box at the edit position.
  placeCursor(layout: BarLayout): void {
    this.screen.moveInFooter(layout.cursorRow + 1, layout.cursorCol + 1);
  }
}
