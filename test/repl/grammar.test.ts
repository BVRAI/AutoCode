import { describe, it, expect } from 'vitest';
import {
  ACTIVITY_VERBS,
  DONE_VERBS,
  countLines,
  describeCall,
  describeResult,
  diffRows,
  formatBytes,
  formatClock,
  formatDuration,
  formatTokens,
  modeBadge,
  summarizeThinking,
  truncateMiddle,
  verbFor,
  wrapPad,
} from '../../src/repl/ink/grammar.js';

const ok = (content: string, summary = '') => ({ summary, content, isError: false });

describe('describeCall — "⏺ Label(arg)"', () => {
  it('labels the core tools the way Claude Code does', () => {
    expect(describeCall('read_file', { path: 'src/app.ts' })).toEqual({
      label: 'Read',
      arg: 'src/app.ts',
      group: 'read',
      activity: 'Reading',
    });
    expect(describeCall('edit_file', { path: 'src/app.ts' }).label).toBe('Update');
    expect(describeCall('write_file', { path: 'a.ts' }).label).toBe('Write');
    expect(describeCall('run_shell', { command: 'npm test' })).toMatchObject({ label: 'Bash', arg: 'npm test' });
    expect(describeCall('list_directory', {})).toMatchObject({ label: 'List', arg: '.', group: 'list' });
    expect(describeCall('task', { description: 'Find the chips' })).toMatchObject({ label: 'Explore', arg: 'Find the chips' });
    expect(describeCall('todo_write', { items: [] })).toMatchObject({ label: 'Update Todos', arg: '' });
  });

  it('phrases search arguments as pattern/glob pairs', () => {
    expect(describeCall('grep', { pattern: 'foo', glob: '*.ts' }).arg).toBe('pattern: "foo", glob: "*.ts"');
    expect(describeCall('glob', { pattern: '**/*.cs' }).arg).toBe('pattern: "**/*.cs"');
    expect(describeCall('grep', { pattern: 'x' }).group).toBe('search');
  });

  it('names MCP tools "server - tool (MCP)" and falls back to the raw name', () => {
    expect(describeCall('mcp__github__list_prs', { repo: 'x' })).toMatchObject({ label: 'github - list_prs (MCP)', arg: 'x' });
    expect(describeCall('something_new', { id: '42' })).toMatchObject({ label: 'something_new', arg: '42', activity: 'Working' });
  });
});

describe('describeResult — the "⎿" line', () => {
  it('collapses reads to a line count with the expand hint', () => {
    const r = describeResult('read_file', { path: 'a.ts' }, ok('a\nb\nc'), { verbose: false });
    expect(r.summary).toBe('Read 3 lines (ctrl+o to expand)');
    expect(r.lines).toBe(3);
    expect(r.bodyLines).toBeUndefined();
  });

  it('expands reads when verbose (ctrl+o)', () => {
    const r = describeResult('read_file', { path: 'a.ts' }, ok('a\nb\nc'), { verbose: true });
    expect(r.summary).toBe('Read 3 lines');
    expect(r.bodyLines).toEqual(['a', 'b', 'c']);
  });

  it('shows the first three lines of Bash output and counts the rest', () => {
    const r = describeResult('run_shell', { command: 'ls' }, ok('1\n2\n3\n4\n5'), { verbose: false });
    expect(r.summary).toBe('');
    expect(r.bodyLines).toEqual(['1', '2', '3']);
    expect(r.hiddenLines).toBe(2);
    expect(describeResult('run_shell', {}, ok('   \n'), { verbose: false }).summary).toBe('(No output)');
  });

  it('phrases writes, searches and listings', () => {
    expect(describeResult('write_file', { path: 'a.ts', content: 'x\ny' }, ok(''), { verbose: false }).summary).toBe('Wrote 2 lines to a.ts');
    expect(describeResult('grep', {}, ok('m1\nm2', '12 matches for foo'), { verbose: false }).summary).toBe('Found 12 matches (ctrl+o to expand)');
    expect(describeResult('glob', {}, ok('a.ts', '1 file matched'), { verbose: false }).summary).toBe('Found 1 file (ctrl+o to expand)');
    expect(describeResult('list_directory', {}, ok('a\nb\nc'), { verbose: true }).summary).toBe('Listed 3 entries');
  });

  it('summarizes a subagent as "Done (N tool uses · Xk tokens · Ys)"', () => {
    const r = describeResult(
      'task',
      {},
      { summary: 'done', content: 'report', isError: false, metadata: { iterations: 12, usage: { inputTokens: 30000, outputTokens: 4200 }, durationMs: 65000 } },
      { verbose: false },
    );
    expect(r.summary).toBe('Done (12 tool uses · 34.2k tokens · 1m 5s)');
    expect(describeResult('task', {}, ok('x'), { verbose: false }).summary).toBe('Done');
  });

  it('prefixes errors with "Error:" and keeps the first lines', () => {
    expect(describeResult('read_file', {}, { summary: 'error', content: 'ENOENT: no such file\nmore', isError: true }, { verbose: false })).toMatchObject({
      summary: 'Error: ENOENT: no such file',
      bodyLines: ['ENOENT: no such file', 'more'],
    });
    expect(describeResult('run_shell', {}, { summary: 'blocked (planning mode)', content: '', isError: true }, { verbose: false }).summary).toBe(
      'Error: blocked (planning mode)',
    );
  });

  it('turns todo_write args into checklist rows', () => {
    const r = describeResult('todo_write', { items: [{ text: 'a', status: 'completed' }, { text: 'b' }] }, ok(''), { verbose: false });
    expect(r.todos).toEqual([
      { text: 'a', status: 'completed' },
      { text: 'b', status: 'pending' },
    ]);
  });
});

describe('diffRows', () => {
  it('numbers rows, counts additions and removals', () => {
    const { rows, stats, hidden } = diffRows('a\nb\nc\n', 'a\nB\nc\n');
    expect(stats).toEqual({ added: 1, removed: 1 });
    expect(hidden).toBe(0);
    expect(rows.some((r) => r.kind === 'del' && r.text === 'b')).toBe(true);
    expect(rows.some((r) => r.kind === 'add' && r.text === 'B')).toBe(true);
  });

  it('caps the rows and reports how many are hidden', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 40 }, (_, i) => `LINE ${i}`).join('\n');
    const { rows, hidden, stats } = diffRows(before, after, 24);
    expect(rows.length).toBe(24);
    expect(hidden).toBeGreaterThan(0);
    expect(stats).toEqual({ added: 40, removed: 40 });
  });
});

describe('formatters', () => {
  it('formatDuration', () => {
    expect(formatDuration(23_000)).toBe('23s');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(120_000)).toBe('2m');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_660_000)).toBe('1h 1m');
    expect(formatDuration(-5)).toBe('0s');
  });

  it('formatTokens / formatBytes', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(1200)).toBe('1.2k');
    expect(formatTokens(34_200)).toBe('34.2k');
    expect(formatTokens(150_000)).toBe('150k');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  it('formatClock uses 12-hour time like "6:05 PM"', () => {
    expect(formatClock(new Date(2026, 8, 6, 18, 5))).toBe('6:05 PM');
    expect(formatClock(new Date(2026, 8, 6, 0, 7))).toBe('12:07 AM');
    expect(formatClock(new Date(2026, 8, 6, 12, 0))).toBe('12:00 PM');
  });

  it('countLines ignores trailing whitespace', () => {
    expect(countLines('a\nb\n\n')).toBe(2);
    expect(countLines('')).toBe(0);
    expect(countLines('one')).toBe(1);
  });
});

describe('verbs and badges', () => {
  it('cycles verbs deterministically by turn', () => {
    expect(verbFor(DONE_VERBS, 0)).toBe('Worked');
    expect(verbFor(DONE_VERBS, DONE_VERBS.length)).toBe('Worked');
    expect(verbFor(ACTIVITY_VERBS, 1)).toBe('Cogitating');
    expect(verbFor(ACTIVITY_VERBS, -3)).toBe(ACTIVITY_VERBS[3]);
  });

  it('modeBadge follows Claude Code footer wording', () => {
    expect(modeBadge('planning')).toEqual({ kind: 'pause', text: 'plan mode on' });
    expect(modeBadge('autocode')).toEqual({ kind: 'play', text: 'auto mode on' });
    expect(modeBadge('default')).toEqual({ kind: 'pause', text: 'manual mode on' });
    expect(modeBadge('anything')).toEqual({ kind: 'pause', text: 'manual mode on' });
  });
});

describe('text helpers', () => {
  it('truncateMiddle keeps both ends of a path', () => {
    const s = truncateMiddle('src/components/very/long/path/File.ts', 20);
    expect(s.length).toBe(20);
    expect(s).toContain('…');
    expect(s.startsWith('src/')).toBe(true);
    expect(s.endsWith('.ts')).toBe(true);
    expect(truncateMiddle('short', 20)).toBe('short');
  });

  it('wrapPad hard-wraps and pads to the width', () => {
    expect(wrapPad('hello world foo', 8)).toEqual(['hello   ', 'world   ', 'foo     ']);
    const long = wrapPad('abcdefghijkl', 5);
    expect(long).toEqual(['abcde', 'fghij', 'kl   ']);
    expect(wrapPad('a\n\nb', 4)).toEqual(['a   ', '    ', 'b   ']);
  });

  it('summarizeThinking keeps the first non-empty lines', () => {
    expect(summarizeThinking('a\n\n b \nc', 2)).toEqual(['a', 'b']);
    expect(summarizeThinking('')).toEqual([]);
  });
});
