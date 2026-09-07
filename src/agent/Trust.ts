// Trust gate (Phase 5.4): repository content that can run code or change the
// agent's behaviour — hooks.json, .mcp.json, permission rules, `verify:`
// directives in instruction files — is only honoured once the user has
// trusted the folder, once per project (remembered in the project state).
// Instruction files themselves (AGENTS.md / AUTOCODE.md text) are always
// read: they are prose the model weighs, not commands the harness runs.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectState } from '../session/ProjectState.js';

export const TRUST_SENSITIVE_FILES = ['.autocode/hooks.json', '.claude/settings.json', '.mcp.json', '.autocode/permissions.json'];

/** Which repo-supplied automation exists here (empty = nothing to trust). */
export function trustSensitiveContent(root: string): string[] {
  const found: string[] = [];
  for (const rel of TRUST_SENSITIVE_FILES) {
    if (existsSync(join(root, rel))) found.push(rel);
  }
  for (const name of ['AUTOCODE.md', 'AGENTS.md']) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      const head = readFileSync(path, 'utf8').slice(0, 2_000);
      if (/^---[\s\S]*?\bverify:\s*\S/m.test(head)) found.push(`${name} (verify: directive)`);
    } catch {
      /* unreadable */
    }
  }
  return found;
}

export function isTrusted(root: string): boolean {
  return process.env.AUTOCODE_TRUST_ALL === '1' || new ProjectState(root).isTrusted();
}

export function markTrusted(root: string): void {
  new ProjectState(root).setTrusted(true);
}

/** The one-time question. */
export function trustPrompt(root: string, found: string[]): string {
  return (
    `This folder carries automation that autocode would run: ${found.join(', ')}. ` +
    `Trust ${root}? Hooks, MCP servers, permission rules and verify directives from the repo stay off until you do.`
  );
}
