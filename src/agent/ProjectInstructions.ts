import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { NOISE_DIRS } from '../tools/listDirectory.js';
import { parseFrontmatter } from '../util/frontmatter.js';

// Project-instruction files in priority order (lowest → highest) — applied
// *within* each directory the loader visits. All present files at every level
// of the tree are loaded; deeper (more specific) entries appear later in the
// system prompt and override shallower (more general) ones on conflict.
//
// - AGENTS.md   — cross-tool industry convention (Claude Code, Codex, Gemini,
//                 Cursor, Aider, Copilot, Devin, Windsurf all read it).
//                 See https://agents.md/.
// - AUTOCODE.md — autocode-specific project instructions (the file users
//                 hand-edit or create via /init). The canonical name.
// - master.md   — AUTHORITATIVE OVERRIDES. Intended for Automax-bundled
//                 deployments where the host process needs to inject runtime
//                 constraints that beat the project's own rules.
const CANDIDATES = [
  { name: 'AGENTS.md', priorityLabel: 'cross-tool agent instructions' },
  { name: 'AUTOCODE.md', priorityLabel: 'autocode project instructions' },
  { name: 'master.md', priorityLabel: 'authoritative overrides' },
] as const;

const TOTAL_BYTE_CAP = 40_000;
const DEPTH_CAP = 8;

export interface ProjectInstructions {
  fileName: string;
  path: string;
  // Project-relative directory the file came from. "" means project root;
  // otherwise forward-slash-joined (e.g. "src/api"). The agent reads this to
  // know which subtree the conventions apply to.
  relativeDir: string;
  depth: number;
  content: string;
  truncated: boolean;
  bytes: number;
  priorityLabel: string;
  isAuthoritative: boolean;
  // Optional `verify:` directive from the file's frontmatter (Phase 28).
  // When set, the post-edit verification loop uses this command for any
  // file changed under this directory (deepest-ancestor wins).
  verify?: string;
}

// Returns ALL instruction files that exist anywhere in the project tree
// (bounded by depth + the noise-dir exclusion list), in load order — by depth
// ASC, then within a directory by the CANDIDATES priority above. The agent
// reads top-to-bottom in the system prompt, so the deeper entries (more
// specific) come later and override.
export function loadProjectInstructions(root: string): ProjectInstructions[] {
  const found = findInstructionFiles(root);
  found.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.relativeDir !== b.relativeDir) return a.relativeDir.localeCompare(b.relativeDir);
    return a.candidateIndex - b.candidateIndex;
  });

  const out: ProjectInstructions[] = [];
  let totalBytes = 0;
  let truncatedTail = 0;
  for (const f of found) {
    if (totalBytes >= TOTAL_BYTE_CAP) {
      truncatedTail += 1;
      continue;
    }
    let stat;
    try {
      stat = statSync(f.path);
    } catch {
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(f.path, 'utf8');
    } catch {
      continue;
    }
    // Strip optional `---`-delimited frontmatter (carrying directives like
    // `verify:`) before the content reaches the system prompt — the agent
    // should not see the directive as an instruction.
    const fm = parseFrontmatter(raw);
    const stripped = resolveImports(fm.hasFrontmatter ? fm.body : raw, f.path);
    const remaining = Math.max(0, TOTAL_BYTE_CAP - totalBytes);
    const truncated = stripped.length > remaining;
    const content = truncated ? stripped.slice(0, remaining) + '\n[…truncated]' : stripped;
    totalBytes += content.length;
    const cand = CANDIDATES[f.candidateIndex]!;
    out.push({
      fileName: cand.name,
      path: f.path,
      relativeDir: f.relativeDir,
      depth: f.depth,
      content,
      truncated,
      bytes: stat.size,
      priorityLabel: cand.priorityLabel,
      isAuthoritative: cand.name === 'master.md',
      ...(fm.meta.verify ? { verify: fm.meta.verify } : {}),
    });
  }
  if (truncatedTail > 0 && out.length > 0) {
    const last = out[out.length - 1]!;
    last.content += `\n\n[…${truncatedTail} more instruction file${truncatedTail === 1 ? '' : 's'} not loaded — total cap reached]`;
  }
  return out;
}

interface Candidate {
  path: string;
  relativeDir: string;
  depth: number;
  candidateIndex: number;
}

const IMPORT_CAP_BYTES = 50_000;
const IMPORT_FILE_CAP_BYTES = 20_000;

/**
 * `@path/to/file.md` on a line of its own pulls that file in (Claude Code's
 * CLAUDE.md imports), relative to the instruction file; one level deep,
 * bounded. Unreadable imports stay as the literal line so the agent sees
 * what was intended.
 */
export function resolveImports(content: string, instructionPath: string): string {
  const dir = dirname(instructionPath);
  let budget = IMPORT_CAP_BYTES;
  return content
    .split(/\r?\n/)
    .map((line) => {
      const m = /^@([\w./~\\-]+(?:\/[\w.\\-]+)*)\s*$/.exec(line.trim());
      if (!m) return line;
      const target = resolve(dir, m[1]!.replace(/^~[\\/]/, `${homedir()}/`));
      try {
        if (!statSync(target).isFile()) return line;
        let text = readFileSync(target, 'utf8');
        if (text.length > IMPORT_FILE_CAP_BYTES) text = `${text.slice(0, IMPORT_FILE_CAP_BYTES)}\n[…import truncated]`;
        if (text.length > budget) return line;
        budget -= text.length;
        const rel = relative(dir, target).replace(/\\/g, '/');
        return `<imported from="${rel}">\n${text.trim()}\n</imported>`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

function findInstructionFiles(root: string): Candidate[] {
  const out: Candidate[] = [];
  walk(root, root, 0, out);
  return out;
}

function walk(root: string, dir: string, depth: number, out: Candidate[]): void {
  if (depth > DEPTH_CAP) return;
  for (let i = 0; i < CANDIDATES.length; i++) {
    const path = join(dir, CANDIDATES[i]!.name);
    if (!existsSync(path)) continue;
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const relDir = relative(root, dir).split(sep).join('/');
    out.push({ path, relativeDir: relDir, depth, candidateIndex: i });
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (NOISE_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(root, full, depth + 1, out);
  }
}
