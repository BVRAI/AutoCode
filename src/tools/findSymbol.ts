// Pragmatic symbol navigation — Anthropic playbook step 6 (LSP-lite).
//
// Full LSP integration is a multi-day project per language. This tool
// delivers the ~80% of the value (find declaration + find references)
// using the same language-aware regex patterns RepoMap.ts already
// maintains. The tool's interface is what the agent sees; the regex
// backend is an implementation detail we can swap for a real LSP
// later without changing how it's called.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { NOISE_DIRS } from './listDirectory.js';
import { declarationPatternForExt, SCANNED_SOURCE_EXT } from '../agent/RepoMap.js';
import {
  optionalString,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const MAX_FILES = 800;
const MAX_HITS = 200;
const MAX_READ_BYTES = 64_000;
const SNIPPET_MAX = 200;

// Extension groups so a `language` filter can be a short keyword instead
// of a list of extensions.
const LANGUAGE_EXTENSIONS: Record<string, Set<string>> = {
  typescript: new Set(['.ts', '.tsx']),
  javascript: new Set(['.js', '.jsx', '.mjs', '.cjs']),
  python: new Set(['.py']),
  go: new Set(['.go']),
  rust: new Set(['.rs']),
  java: new Set(['.java']),
  ruby: new Set(['.rb']),
  php: new Set(['.php']),
  csharp: new Set(['.cs']),
};

type Kind = 'definition' | 'reference' | 'any';

interface Hit {
  file: string;     // project-relative, forward-slash separators
  line: number;     // 1-indexed
  column: number;   // 1-indexed
  kind: 'definition' | 'reference';
  snippet: string;  // the matching line, trimmed
}

const DEFINITION: ToolDefinition = {
  name: 'find_symbol',
  description:
    'Locate where a named identifier is declared and/or used across the project. ' +
    'Faster and more precise than `grep` for symbol lookups — it knows the per-language patterns ' +
    'for declarations (function, class, def, fn, type, etc.) and falls back to a word-boundary ' +
    'reference search for non-declaration sites. Use this when you want "where is X defined" or ' +
    '"where is X used" rather than a generic text search.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The identifier to look up.' },
      kind: {
        type: 'string',
        enum: ['definition', 'reference', 'any'],
        description: 'definition = declaration sites only; reference = uses (including the declaration); any = both. Default any.',
      },
      language: {
        type: 'string',
        enum: Object.keys(LANGUAGE_EXTENSIONS),
        description: 'Optional — restrict to one language family (typescript, python, go, …).',
      },
    },
    required: ['name'],
  },
};

export class FindSymbolTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const name = requireString(args, 'name');
    const kindRaw = optionalString(args, 'kind');
    const kind: Kind =
      kindRaw === 'definition' || kindRaw === 'reference' || kindRaw === 'any' ? kindRaw : 'any';
    const language = optionalString(args, 'language');
    const extFilter = language ? LANGUAGE_EXTENSIONS[language] : undefined;
    if (language && !extFilter) {
      return {
        summary: 'unsupported language',
        content: `language must be one of: ${Object.keys(LANGUAGE_EXTENSIONS).join(', ')}`,
        isError: true,
      };
    }

    const root = ctx.session.projectRoot;
    const files: string[] = [];
    collectFiles(root, files, 0, extFilter);

    const hits: Hit[] = [];
    let truncated = false;
    const refRe = new RegExp(`\\b${escapeRe(name)}\\b`);
    outer: for (const abs of files) {
      let text: string;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (text.length > MAX_READ_BYTES) text = text.slice(0, MAX_READ_BYTES);
      const declSet = (kind === 'definition' || kind === 'any')
        ? findDeclarationLines(text, name, extname(abs))
        : new Set<number>();

      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const isDecl = declSet.has(i);
        const matches = refRe.exec(line);
        const isRef = matches !== null;
        if (!isDecl && !isRef) continue;
        if (kind === 'definition' && !isDecl) continue;
        // For kind=reference we KEEP declarations too — the declaration is
        // usually the most useful reference site.
        const col = isDecl ? Math.max(1, line.indexOf(name) + 1) : (matches!.index + 1);
        hits.push({
          file: relative(root, abs).split(sep).join('/'),
          line: i + 1,
          column: col,
          kind: isDecl ? 'definition' : 'reference',
          snippet: trimSnippet(line),
        });
        if (hits.length >= MAX_HITS) {
          truncated = true;
          break outer;
        }
      }
    }

    hits.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
    const summary = hits.length === 0
      ? `no matches for ${name}`
      : `${hits.length}${truncated ? '+' : ''} match${hits.length === 1 ? '' : 'es'} for ${name}`;
    const content = hits.length === 0
      ? `(no matches for \`${name}\`${language ? ` in ${language} files` : ''})`
      : hits.map((h) => `${h.file}:${h.line}:${h.column}  ${h.snippet}`).join('\n') +
        (truncated ? `\n… truncated at ${MAX_HITS} hits` : '');

    return {
      summary,
      content,
      metadata: { hits, truncated, name, kind, language },
    };
  }
}

function collectFiles(dir: string, out: string[], depth: number, extFilter?: Set<string>): void {
  if (out.length >= MAX_FILES || depth > 12) return;
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (out.length >= MAX_FILES) return;
    if (NOISE_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectFiles(full, out, depth + 1, extFilter);
    } else {
      const ext = extname(name);
      if (extFilter ? extFilter.has(ext) : SCANNED_SOURCE_EXT.has(ext)) {
        out.push(full);
      }
    }
  }
}

// Returns the 0-indexed line numbers in `text` that declare `name` per
// the per-language declaration pattern. The pattern always captures the
// bound identifier in group 1 (or group 2 for the TS `export const X` branch).
function findDeclarationLines(text: string, name: string, ext: string): Set<number> {
  const out = new Set<number>();
  const re = declarationPatternForExt(ext);
  if (!re) return out;
  // We must clone the regex's flags into a fresh instance because the
  // exported one uses /g state. Easiest: split into lines and try each.
  const perLine = new RegExp(re.source);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = perLine.exec(lines[i]!);
    if (m && (m[1] === name || m[2] === name)) out.add(i);
  }
  return out;
}

function trimSnippet(line: string): string {
  const t = line.trim();
  return t.length <= SNIPPET_MAX ? t : t.slice(0, SNIPPET_MAX) + '…';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
