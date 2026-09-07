// Git-history tools (Phase 3.5 leftover): `search_commits` finds the commits
// whose message or diff mention a term — "where was this last changed" is a
// localization signal the graph cannot give (Repository Memory, ICLR 2026:
// +4.9 Acc@5 on top of code search) — and `show_commit` reads one of them.
// Read-only; git is invoked without a shell and every path stays inside the
// project root.

import { execFile } from 'node:child_process';
import { resolveInsideRoot, toRelative } from '../util/pathSafety.js';
import { optionalBoolean, optionalNumber, optionalString, requireString, type Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from './types.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_SHOW_LINES = 300;
const MAX_SHOW_LINES = 2_000;
const GIT_TIMEOUT_MS = 30_000;

function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout ?? ''), err: String(stderr ?? (error ? error.message : '')) });
    });
  });
}

function notARepo(err: string): boolean {
  return /not a git repository|spawn git ENOENT/i.test(err);
}

const SEARCH_DEF: ToolDefinition = {
  name: 'search_commits',
  description:
    'Find commits whose message (default) or whose added/removed lines (in_diff: true, git -S) mention a term. ' +
    'Answers "when and where was X last changed" — a strong signal for which file a vague request means. ' +
    'Returns one line per commit: sha, date, author, subject, and with a path filter only the commits touching that path. ' +
    'Follow up with show_commit to read the change.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Term to search for (a word, identifier, or phrase).' },
      in_diff: { type: 'boolean', description: 'Search the diff content (git -S) instead of commit messages. Default false.' },
      path: { type: 'string', description: 'Only commits touching this file or directory (relative to the project root).' },
      limit: { type: 'number', description: `Commits to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.` },
    },
    required: ['query'],
  },
};

export class SearchCommitsTool implements Tool {
  readonly definition = SEARCH_DEF;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const query = requireString(args, 'query').trim();
    if (query.length === 0) return { summary: 'empty query', content: 'query must not be empty', isError: true };
    const inDiff = optionalBoolean(args, 'in_diff') ?? false;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(optionalNumber(args, 'limit') ?? DEFAULT_LIMIT)));
    const rel = optionalString(args, 'path');
    const root = ctx.session.projectRoot;
    const gitArgs = ['log', '--date=short', '--format=%h\t%ad\t%an\t%s', `-n${limit}`];
    if (inDiff) gitArgs.push(`-S${query}`);
    else gitArgs.push('-i', `--grep=${query}`);
    let shownPath = '';
    if (rel) {
      const abs = resolveInsideRoot(root, rel);
      shownPath = toRelative(root, abs) || '.';
      gitArgs.push('--', shownPath);
    }
    const r = await git(gitArgs, root);
    if (!r.ok) {
      const why = notARepo(r.err) ? 'not a git repository (or git is not installed)' : r.err.trim().slice(0, 300);
      return { summary: `search_commits failed: ${why}`, content: why, isError: true };
    }
    const lines = r.out.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const where = `${inDiff ? 'diffs' : 'messages'} for "${query}"${shownPath ? ` under ${shownPath}` : ''}`;
    if (lines.length === 0) return { summary: `no commits match ${where}`, content: `(no commits match ${where})`, metadata: { count: 0 } };
    const rows = lines.map((l) => {
      const [sha, date, author, ...subject] = l.split('\t');
      return `${sha}  ${date}  ${author}  ${subject.join('\t')}`;
    });
    return {
      summary: `${rows.length} commit${rows.length === 1 ? '' : 's'} match ${where}`,
      content: `${rows.join('\n')}${rows.length === limit ? `\n… (limit ${limit}; raise limit or narrow with path)` : ''}`,
      metadata: { count: rows.length },
    };
  }
}

const SHOW_DEF: ToolDefinition = {
  name: 'show_commit',
  description:
    'Show one commit: its message, the files it touched, and the diff (optionally only for one path). ' +
    'Use after search_commits to see what a change looked like and where it landed.',
  inputSchema: {
    type: 'object',
    properties: {
      sha: { type: 'string', description: 'Commit hash (short or full), or a ref like HEAD~2.' },
      path: { type: 'string', description: 'Limit the diff to this file or directory (relative to the project root).' },
      max_lines: { type: 'number', description: `Cap on diff lines returned. Default ${DEFAULT_SHOW_LINES}, max ${MAX_SHOW_LINES}.` },
    },
    required: ['sha'],
  },
};

export class ShowCommitTool implements Tool {
  readonly definition = SHOW_DEF;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const sha = requireString(args, 'sha').trim();
    if (!/^[A-Za-z0-9_./~^@{}-]{1,64}$/.test(sha) || sha.startsWith('-')) {
      return { summary: 'invalid sha', content: `not a commit reference: ${sha}`, isError: true };
    }
    const maxLines = Math.max(20, Math.min(MAX_SHOW_LINES, Math.floor(optionalNumber(args, 'max_lines') ?? DEFAULT_SHOW_LINES)));
    const rel = optionalString(args, 'path');
    const root = ctx.session.projectRoot;
    // `--stat` alone turns the patch off for `git show`; `-p` keeps both.
    const gitArgs = ['show', '--date=short', '--stat=100', '-p', '--format=commit %h  %ad  %an%n%n%s%n%n%b', sha];
    let shownPath = '';
    if (rel) {
      const abs = resolveInsideRoot(root, rel);
      shownPath = toRelative(root, abs) || '.';
      gitArgs.push('--', shownPath);
    }
    const r = await git(gitArgs, root);
    if (!r.ok) {
      const why = notARepo(r.err) ? 'not a git repository (or git is not installed)' : r.err.trim().slice(0, 300);
      return { summary: `show_commit failed: ${why}`, content: why, isError: true };
    }
    const lines = r.out.replace(/\r\n/g, '\n').split('\n');
    const truncated = lines.length > maxLines;
    const body = (truncated ? lines.slice(0, maxLines) : lines).join('\n').replace(/\s+$/, '');
    const tail = truncated ? `\n… (${lines.length - maxLines} more lines; narrow with path or raise max_lines)` : '';
    return {
      summary: `${sha}${shownPath ? ` (${shownPath})` : ''}: ${lines.length} lines${truncated ? `, showing ${maxLines}` : ''}`,
      content: body + tail,
      metadata: { lines: lines.length, truncated },
    };
  }
}
