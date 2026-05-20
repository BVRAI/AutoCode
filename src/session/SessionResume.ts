import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionState } from './TranscriptStore.js';

// Find the most recently active resumable session under `sessionsRoot`.
// A session is resumable only if it has a conversation.json; recency is by
// that file's mtime (a resumed session keeps its old id, so id-sort would
// be wrong). Returns the session id, or null if there is nothing to resume.
export function findLatestSession(sessionsRoot: string): string | null {
  if (!existsSync(sessionsRoot)) return null;
  let best: { id: string; mtimeMs: number } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(sessionsRoot);
  } catch {
    return null;
  }
  for (const id of entries) {
    const convo = join(sessionsRoot, id, 'conversation.json');
    let mtimeMs: number;
    try {
      const s = statSync(convo);
      if (!s.isFile()) continue;
      mtimeMs = s.mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtimeMs > best.mtimeMs) best = { id, mtimeMs };
  }
  return best ? best.id : null;
}

// Read a session's state.json. Returns null if absent or unparseable.
export function loadSessionMeta(sessionDir: string): SessionState | null {
  const statePath = join(sessionDir, 'state.json');
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as SessionState;
  } catch {
    return null;
  }
}
