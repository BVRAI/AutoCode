import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Project-instruction files in priority order (lowest → highest).
// All present files are loaded and concatenated in this order in the system
// prompt — the highest-priority file appears last so its rules win conflicts.
//
// - AGENTS.md   — cross-tool industry convention (Claude Code, Codex, Gemini,
//                 Cursor, Aider, Copilot, Devin, Windsurf all read it).
//                 See https://agents.md/.
// - CLAUDE.md   — older Anthropic-specific name; some repos still use it.
// - AUTOCODE.md — autocode-specific project instructions (the file users
//                 hand-edit or create via /init).
// - master.md   — AUTHORITATIVE OVERRIDES. Intended for Automax-bundled
//                 deployments where the host process needs to inject runtime
//                 constraints that beat the project's own rules.
const CANDIDATES = [
  { name: 'AGENTS.md', priorityLabel: 'cross-tool agent instructions' },
  { name: 'CLAUDE.md', priorityLabel: 'Claude project instructions' },
  { name: 'AUTOCODE.md', priorityLabel: 'autocode project instructions' },
  { name: 'master.md', priorityLabel: 'authoritative overrides' },
] as const;

const TOTAL_BYTE_CAP = 40_000;

export interface ProjectInstructions {
  fileName: string;
  path: string;
  content: string;
  truncated: boolean;
  bytes: number;
  priorityLabel: string;
  isAuthoritative: boolean;
}

// Returns ALL project-instruction files that exist at the project root, in
// priority order (lowest → highest). master.md is flagged isAuthoritative so
// the prompt builder can frame it explicitly.
export function loadProjectInstructions(root: string): ProjectInstructions[] {
  const out: ProjectInstructions[] = [];
  let totalBytes = 0;
  for (const cand of CANDIDATES) {
    const path = join(root, cand.name);
    if (!existsSync(path)) continue;
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const remaining = Math.max(0, TOTAL_BYTE_CAP - totalBytes);
    const truncated = raw.length > remaining;
    const content = truncated ? raw.slice(0, remaining) + '\n[…truncated]' : raw;
    totalBytes += content.length;
    out.push({
      fileName: cand.name,
      path,
      content,
      truncated,
      bytes: stat.size,
      priorityLabel: cand.priorityLabel,
      isAuthoritative: cand.name === 'master.md',
    });
    if (totalBytes >= TOTAL_BYTE_CAP) break;
  }
  return out;
}
