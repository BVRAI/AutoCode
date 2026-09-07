// Claude Code's transcript grammar as pure functions: how a tool call is
// labelled, how its result row reads, the verbs on the status and
// end-of-turn lines, and the small formatters they share. Verified against
// Claude Code's docs, changelog and transcripts (2026-09). No rendering here,
// so every rule is testable without Ink.

import { basename } from 'node:path';
import { unifiedDiff } from '../../util/diff.js';

export type ToolGroup = 'read' | 'search' | 'list' | null;

export interface CallDescription {
  /** Display label: "Read", "Bash", "Update", "Explore", "server - tool (MCP)". */
  label: string;
  /** Primary argument shown in parentheses after the label. */
  arg: string;
  /** Consecutive same-group calls may collapse into one row ("Read 3 files"). */
  group: ToolGroup;
  /** Present-participle verb for the status line while the call runs. */
  activity: string;
}

export interface DiffRow {
  kind: 'add' | 'del' | 'ctx' | 'gap';
  oldNo?: number;
  newNo?: number;
  text: string;
}

export interface TodoRow {
  text: string;
  status: string;
}

export interface ResultDescription {
  /** The ⎿ line. Empty when the body speaks for itself (Bash output). */
  summary: string;
  /** Logical line count of the result content. */
  lines: number;
  /** Lines shown under the summary (Bash output, error text, expanded reads). */
  bodyLines?: string[];
  /** Lines not shown: rendered as "… +N lines (ctrl+o to expand)". */
  hiddenLines?: number;
  todos?: TodoRow[];
}

export interface RawResult {
  summary: string;
  content: string;
  isError: boolean;
  metadata?: Record<string, unknown> | undefined;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function firstStringArg(args: Record<string, unknown>): string {
  for (const k of ['path', 'file', 'target', 'command', 'pattern', 'query', 'url', 'name', 'id']) {
    const v = args[k];
    if (typeof v === 'string') return v;
  }
  const first = Object.values(args).find((v) => typeof v === 'string');
  return typeof first === 'string' ? first : '';
}

function idList(v: unknown): string {
  if (Array.isArray(v)) return v.map(str).filter(Boolean).slice(0, 4).join(', ') + (v.length > 4 ? ', …' : '');
  return str(v);
}

export function describeCall(name: string, args: Record<string, unknown>): CallDescription {
  const path = str(args['path']) || str(args['file']) || str(args['file_path']);
  switch (name) {
    case 'read_file':
      return { label: 'Read', arg: path, group: 'read', activity: 'Reading' };
    case 'write_file':
      return { label: 'Write', arg: path, group: null, activity: 'Writing' };
    case 'edit_file':
      return { label: 'Update', arg: path, group: null, activity: 'Editing' };
    case 'run_shell':
      return { label: 'Bash', arg: str(args['command']), group: null, activity: 'Running' };
    case 'glob':
      return { label: 'Search', arg: `pattern: "${str(args['pattern'])}"`, group: 'search', activity: 'Searching' };
    case 'grep': {
      const g = str(args['glob']) || str(args['include']);
      return {
        label: 'Search',
        arg: `pattern: "${str(args['pattern'])}"${g ? `, glob: "${g}"` : ''}`,
        group: 'search',
        activity: 'Searching',
      };
    }
    case 'find_symbol':
      return { label: 'Search', arg: `symbol: "${str(args['name']) || str(args['symbol'])}"`, group: 'search', activity: 'Searching' };
    case 'file_deps':
      return { label: 'Deps', arg: path, group: null, activity: 'Tracing' };
    case 'search_entity':
      return { label: 'Search', arg: `entity: "${str(args['query'])}"`, group: 'search', activity: 'Searching' };
    case 'traverse_graph':
      return { label: 'Graph', arg: idList(args['ids']), group: null, activity: 'Tracing' };
    case 'retrieve_entity':
      return { label: 'Retrieve', arg: idList(args['ids']), group: null, activity: 'Reading' };
    case 'list_directory':
      return { label: 'List', arg: path || '.', group: 'list', activity: 'Listing' };
    case 'review': {
      const files = Array.isArray(args['files']) ? (args['files'] as unknown[]).length : 0;
      return { label: 'Review', arg: `${files} file${files === 1 ? '' : 's'}`, group: null, activity: 'Reviewing' };
    }
    case 'task': {
      const localize = str(args['subagent_type']) === 'Localize';
      return {
        label: localize ? 'Localize' : 'Explore',
        arg: str(args['description']),
        group: null,
        activity: localize ? 'Localizing' : 'Exploring',
      };
    }
    case 'todo_write':
      return { label: 'Update Todos', arg: '', group: null, activity: 'Planning' };
    case 'web_fetch':
      return { label: 'Fetch', arg: str(args['url']), group: null, activity: 'Fetching' };
    case 'web_search':
      return { label: 'Web Search', arg: str(args['query']), group: null, activity: 'Searching' };
    case 'ask_user':
      return { label: 'Ask', arg: str(args['question']), group: null, activity: 'Asking' };
    case 'use_skill':
      return { label: 'Skill', arg: str(args['name']), group: null, activity: 'Loading' };
    case 'create_directory':
      return { label: 'Create', arg: path, group: null, activity: 'Creating' };
    case 'delete_path': {
      const list = Array.isArray(args['paths'])
        ? (args['paths'] as unknown[]).map(str).filter(Boolean)
        : path
          ? [path]
          : [];
      return { label: 'Delete', arg: list.join(', '), group: null, activity: 'Deleting' };
    }
    case 'capture_screenshot':
      return { label: 'Screenshot', arg: str(args['url']), group: null, activity: 'Capturing' };
    case 'open_in_browser': {
      const urls = Array.isArray(args['urls']) ? (args['urls'] as unknown[]).map(str).filter(Boolean).join(', ') : '';
      return { label: 'Open', arg: str(args['url']) || urls, group: null, activity: 'Opening' };
    }
    case 'computer_use_task':
    case 'computer_use_host':
      return { label: 'Computer', arg: str(args['task']) || str(args['action']), group: null, activity: 'Operating' };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      if (mcp) return { label: `${mcp[1]} - ${mcp[2]} (MCP)`, arg: firstStringArg(args), group: null, activity: 'Calling' };
      return { label: name, arg: firstStringArg(args), group: null, activity: 'Working' };
    }
  }
}

export function countLines(text: string): number {
  const t = text.replace(/\s+$/, '');
  if (t.length === 0) return 0;
  return t.split(/\r?\n/).length;
}

function splitLines(text: string): string[] {
  const t = text.replace(/\s+$/, '');
  if (t.length === 0) return [];
  return t.split(/\r?\n/);
}

function take(text: string, max: number): { bodyLines: string[]; hiddenLines: number } {
  const all = splitLines(text);
  return { bodyLines: all.slice(0, max), hiddenLines: Math.max(0, all.length - max) };
}

const plural = (n: number, word: string, pluralWord = `${word}s`): string => `${n} ${n === 1 ? word : pluralWord}`;

/** Leading number in a tool summary such as "12 matches for …" / "3 entries in …". */
function leadingCount(summary: string): number | null {
  const m = /^(\d+)\s/.exec(summary.trim());
  return m ? Number(m[1]) : null;
}

export function expandHint(verbose: boolean): string {
  return verbose ? '' : ' (ctrl+o to expand)';
}

export function describeResult(
  name: string,
  args: Record<string, unknown>,
  result: RawResult,
  opts: { verbose: boolean },
): ResultDescription {
  const content = result.content ?? '';
  const lines = countLines(content);
  const bodyCap = opts.verbose ? 30 : 3;

  if (result.isError) {
    const body = take(content, bodyCap);
    return { summary: errorSummary(result), lines, ...body };
  }

  switch (name) {
    case 'read_file': {
      // The tool reports the slice it returned; the content may carry a
      // "… N more lines" tail that is not a file line.
      const md = result.metadata ?? {};
      const start = md['startLine'];
      const end = md['endLine'];
      const n = typeof start === 'number' && typeof end === 'number' && end >= start ? end - start + 1 : lines;
      const summary = `Read ${plural(n, 'line')}${expandHint(opts.verbose)}`;
      return opts.verbose ? { summary, lines, ...take(content, 40) } : { summary, lines };
    }
    case 'write_file': {
      const n = countLines(str(args['content']));
      return { summary: `Wrote ${plural(n, 'line')} to ${str(args['path'])}`, lines: n };
    }
    case 'edit_file':
      // Stats are patched in when the diff arrives (see BridgeStore.attachDiff).
      return { summary: `Updated ${str(args['path'])}`, lines };
    case 'run_shell': {
      if (result.summary.startsWith('started in background')) return { summary: result.summary, lines };
      const output = shellOutput(content);
      if (output.length === 0) return { summary: '(No output)', lines: 0 };
      return { summary: '', lines: output.length, ...take(output.join('\n'), bodyCap) };
    }
    case 'glob': {
      const n = leadingCount(result.summary) ?? lines;
      return { summary: `Found ${plural(n, 'file')}${expandHint(opts.verbose)}`, lines };
    }
    case 'grep':
    case 'find_symbol':
    case 'search_entity': {
      const n = leadingCount(result.summary) ?? lines;
      return { summary: `Found ${plural(n, 'match', 'matches')}${expandHint(opts.verbose)}`, lines };
    }
    case 'retrieve_entity': {
      const n = leadingCount(result.summary) ?? lines;
      return { summary: `Retrieved ${plural(n, 'entity', 'entities')}${expandHint(opts.verbose)}`, lines };
    }
    case 'traverse_graph':
      return { summary: `${result.summary || 'Done'}${expandHint(opts.verbose)}`, lines };
    case 'list_directory': {
      const n = leadingCount(result.summary) ?? lines;
      return { summary: `Listed ${plural(n, 'entry', 'entries')}${expandHint(opts.verbose)}`, lines };
    }
    case 'task': {
      const md = result.metadata ?? {};
      const iterations = typeof md['iterations'] === 'number' ? (md['iterations'] as number) : null;
      const toolUses = typeof md['toolUses'] === 'number' ? (md['toolUses'] as number) : iterations;
      const usage = (md['usage'] as { inputTokens?: number; outputTokens?: number } | undefined) ?? {};
      const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      const ms = typeof md['durationMs'] === 'number' ? (md['durationMs'] as number) : null;
      const parts: string[] = [];
      if (toolUses !== null) parts.push(plural(toolUses, 'tool use'));
      if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
      if (ms !== null) parts.push(formatDuration(ms));
      return { summary: parts.length > 0 ? `Done (${parts.join(' · ')})` : 'Done', lines };
    }
    case 'review': {
      // Findings stay visible (up to eight lines) — they are for the user.
      const md = result.metadata ?? {};
      const findings = Array.isArray(md['findings']) ? (md['findings'] as unknown[]).length : 0;
      const verdict = md['verdict'];
      const summary = result.isError
        ? 'Review unavailable'
        : verdict === 'approve'
          ? `Approved${findings > 0 ? ` (${plural(findings, 'note')})` : ''}`
          : `Changes requested (${plural(findings, 'finding')})`;
      return { summary: `${summary}${expandHint(opts.verbose)}`, lines, ...take(content, 8) };
    }
    case 'todo_write': {
      // The tool renders the whole list back ("[x] t1. text"); prefer that so
      // `update` actions (no items in the args) still show the checklist.
      const fromResult = todosFromResult(content);
      return { summary: '', lines, todos: fromResult.length > 0 ? fromResult : todosFromArgs(args) };
    }
    case 'web_fetch':
      return { summary: `Received ${formatBytes(content.length)}${expandHint(opts.verbose)}`, lines };
    case 'web_search':
      return { summary: `Searched the web${expandHint(opts.verbose)}`, lines };
    default:
      return { summary: result.summary || 'Done', lines };
  }
}

/**
 * The shell tool wraps its output in `--- stdout ---` / `--- stderr ---`
 * sections for the model; the user sees the raw output, Claude Code style.
 */
export function shellOutput(content: string): string[] {
  const t = content.replace(/\s+$/, '');
  if (t.length === 0 || t === '(no output)') return [];
  const lines = t
    .split(/\r?\n/)
    .filter((l) => l !== '--- stdout ---' && l !== '--- stderr ---');
  while (lines.length > 0 && lines[0]!.trim().length === 0) lines.shift();
  return lines;
}

function errorSummary(result: RawResult): string {
  const s = result.summary.trim();
  if (s.length > 0 && s !== 'error') return `Error: ${s}`;
  const first = splitLines(result.content)[0] ?? 'failed';
  return `Error: ${first.slice(0, 120)}`;
}

/** Parse the todo tool's rendered list: `[x] t1. text`, `[~]` in progress, `[!]` interrupted. */
export function todosFromResult(content: string): TodoRow[] {
  const out: TodoRow[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const m = /^\s*\[([ x~!])\]\s+(?:\S+\.\s+)?(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const status = m[1] === 'x' ? 'completed' : m[1] === '~' ? 'in_progress' : m[1] === '!' ? 'interrupted' : 'pending';
    out.push({ text: m[2]!, status });
  }
  return out;
}

export function todosFromArgs(args: Record<string, unknown>): TodoRow[] {
  const items = Array.isArray(args['items'])
    ? (args['items'] as unknown[])
    : Array.isArray(args['todos'])
      ? (args['todos'] as unknown[])
      : [];
  const out: TodoRow[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const text = str(o['text']) || str(o['content']) || str(o['title']);
    if (!text) continue;
    out.push({ text, status: str(o['status']) || 'pending' });
  }
  return out;
}

/** Numbered diff rows for an edit, Claude-Code style (line numbers, +/-, ⋮ between hunks). */
export function diffRows(
  before: string,
  after: string,
  maxRows = 24,
): { rows: DiffRow[]; stats: { added: number; removed: number }; hidden: number } {
  // A trailing newline on both sides is the file terminator, not a line —
  // drop it so the diff never ends in a phantom empty row.
  const trimEnd = before.endsWith('\n') && after.endsWith('\n');
  const hunks = unifiedDiff(trimEnd ? before.slice(0, -1) : before, trimEnd ? after.slice(0, -1) : after);
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let total = 0;
  hunks.forEach((h, hi) => {
    if (hi > 0) {
      total += 1;
      if (rows.length < maxRows) rows.push({ kind: 'gap', text: '' });
    }
    for (const l of h.lines) {
      if (l.kind === 'add') added += 1;
      if (l.kind === 'remove') removed += 1;
      total += 1;
      if (rows.length < maxRows) {
        rows.push({
          kind: l.kind === 'add' ? 'add' : l.kind === 'remove' ? 'del' : 'ctx',
          oldNo: l.oldLine,
          newNo: l.newLine,
          text: l.text,
        });
      }
    }
  });
  return { rows, stats: { added, removed }, hidden: Math.max(0, total - rows.length) };
}

// ── verbs and formatters ────────────────────────────────────────────────────

/** Present-participle verbs for the transient status line (one per turn). */
export const ACTIVITY_VERBS = [
  'Thinking',
  'Cogitating',
  'Pondering',
  'Brewing',
  'Hatching',
  'Percolating',
  'Musing',
  'Simmering',
  'Crafting',
  'Architecting',
  'Computing',
  'Noodling',
  'Contemplating',
  'Deliberating',
] as const;

/** Past-tense verbs for the end-of-turn line ("Sautéed for 23s"). */
export const DONE_VERBS = [
  'Worked',
  'Cooked',
  'Sautéed',
  'Baked',
  'Brewed',
  'Crafted',
  'Hatched',
  'Pondered',
  'Cogitated',
  'Percolated',
  'Mused',
  'Simmered',
] as const;

export function verbFor(list: readonly string[], seed: number): string {
  return list[Math.abs(Math.trunc(seed)) % list.length]!;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${Math.max(0, Math.round(n))}`;
  const k = n / 1000;
  const text = k >= 100 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, '');
  return `${text}k`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(kb / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

export function formatClock(d: Date): string {
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${d.getMinutes().toString().padStart(2, '0')} ${ampm}`;
}

/** Up to `maxLines` non-empty lines of a thinking trace — the collapsed summary. */
export function summarizeThinking(text: string, maxLines = 10): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, maxLines);
}

export interface ModeBadge {
  kind: 'pause' | 'play';
  text: string;
}

export function modeBadge(mode: string): ModeBadge {
  switch (mode) {
    case 'planning':
      return { kind: 'pause', text: 'plan mode on' };
    case 'autocode':
      return { kind: 'play', text: 'auto mode on' };
    case 'admin':
      return { kind: 'play', text: 'admin mode on' };
    case 'sights':
      return { kind: 'play', text: 'sights mode on' };
    default:
      return { kind: 'pause', text: 'manual mode on' };
  }
}

/** Middle-truncate so a long path keeps both ends: "src/…/Foo.ts". */
export function truncateMiddle(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${s.slice(0, head)}…${tail > 0 ? s.slice(-tail) : ''}`;
}

/** Hard-wrap and pad each line to `width` — for the tinted user-turn band. */
export function wrapPad(text: string, width: number): string[] {
  const w = Math.max(4, width);
  const out: string[] = [];
  for (const para of text.replace(/\r/g, '').split('\n')) {
    if (para.length === 0) {
      out.push(' '.repeat(w));
      continue;
    }
    let line = '';
    for (const word of para.split(' ')) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (candidate.length <= w) {
        line = candidate;
        continue;
      }
      if (line.length > 0) out.push(line.padEnd(w));
      let rest = word;
      while (rest.length > w) {
        out.push(rest.slice(0, w));
        rest = rest.slice(w);
      }
      line = rest;
    }
    out.push(line.padEnd(w));
  }
  return out;
}

export const shortName = (p: string): string => basename(p) || p;
