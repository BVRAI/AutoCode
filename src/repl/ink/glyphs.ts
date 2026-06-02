// Glyph set selection. Many of the design's glyphs (✓ ◆ ⎇ ▰ › ℹ) don't render
// in terminals with a limited font (Git Bash / mintty), where they show as
// tofu boxes. We use the rich set only for terminals known to render it, and
// an ASCII-safe set everywhere else. Cached once per process.

export interface GlyphSet {
  rich: boolean;
  toolDone: string;
  toolFail: string;
  user: string;
  branch: string; // prefix before branch name
  mode: string; // prefix before mode name
  dirty: string; // prefix before dirty count
  mcp: string;
  edits: string;
  barFull: string;
  barEmpty: string;
  diffGuide: string;
  info: string;
  warn: string;
  error: string;
  times: string; // consolidation multiplier ("read_file ×5")
  planPending: string;
  planActive: string;
  planDone: string;
  planInterrupted: string;
  spinner: string[]; // busy-indicator frames
}

const RICH: GlyphSet = {
  rich: true,
  toolDone: '✓',
  toolFail: '✗',
  user: '›',
  branch: '⎇ ',
  mode: '◆ ',
  dirty: '●',
  mcp: '◍',
  edits: '✎ ',
  barFull: '▰',
  barEmpty: '▱',
  diffGuide: '│',
  info: 'ℹ',
  warn: '⚠',
  error: '✗',
  times: '×',
  planPending: '○',
  planActive: '▸',
  planDone: '✓',
  planInterrupted: '⚠',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

const ASCII: GlyphSet = {
  rich: false,
  toolDone: '+',
  toolFail: 'x',
  user: '>',
  branch: 'git:',
  mode: '',
  dirty: '*',
  mcp: 'mcp',
  edits: 'edit:',
  barFull: '#',
  barEmpty: '-',
  diffGuide: '|',
  info: 'i',
  warn: '!',
  error: 'x',
  times: 'x',
  planPending: '[ ]',
  planActive: '[~]',
  planDone: '[x]',
  planInterrupted: '[!]',
  spinner: ['-', '\\', '|', '/'],
};

function isRichTerminal(): boolean {
  if (process.env.AUTOCODE_ASCII === '1') return false; // explicit override
  if (process.env.AUTOCODE_RICH === '1') return true;
  if (process.env.WT_SESSION) return true; // Windows Terminal
  if (process.env.KITTY_WINDOW_ID || process.env.GHOSTTY_RESOURCES_DIR) return true;
  const tp = process.env.TERM_PROGRAM ?? '';
  if (['vscode', 'iTerm.app', 'WezTerm', 'ghostty', 'Apple_Terminal'].includes(tp)) return true;
  return false;
}

let cached: GlyphSet | null = null;

export function glyphs(): GlyphSet {
  if (cached === null) cached = isRichTerminal() ? RICH : ASCII;
  return cached;
}
