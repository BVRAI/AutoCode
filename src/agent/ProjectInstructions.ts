import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Cross-tool industry convention as of 2026 — AGENTS.md is read natively by
// Claude Code, OpenAI Codex CLI, Gemini CLI, Cursor, Aider, GitHub Copilot,
// Devin, Windsurf, and Amazon Q. See https://agents.md/. We also accept
// AUTOCODE.md (autocode-specific override) and CLAUDE.md (Anthropic's name)
// for compatibility with mixed-tool repos.
const CANDIDATES = ['AUTOCODE.md', 'AGENTS.md', 'CLAUDE.md'] as const;
const MAX_BYTES = 20_000;

export interface ProjectInstructions {
  fileName: string;
  path: string;
  content: string;
  truncated: boolean;
  bytes: number;
}

export function loadProjectInstructions(root: string): ProjectInstructions | null {
  for (const name of CANDIDATES) {
    const path = join(root, name);
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
    const truncated = raw.length > MAX_BYTES;
    const content = truncated ? raw.slice(0, MAX_BYTES) + '\n[…truncated]' : raw;
    return {
      fileName: name,
      path,
      content,
      truncated,
      bytes: stat.size,
    };
  }
  return null;
}
