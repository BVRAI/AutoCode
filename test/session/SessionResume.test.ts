import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLatestSession, loadSessionMeta } from '../../src/session/SessionResume.js';

describe('SessionResume', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-sessions-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function makeSession(id: string, mtime: Date, withConversation = true): void {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ sessionId: id }), 'utf8');
    if (withConversation) {
      const convo = join(dir, 'conversation.json');
      writeFileSync(convo, JSON.stringify({ version: 1, messages: [] }), 'utf8');
      utimesSync(convo, mtime, mtime);
    }
  }

  it('returns null when the sessions directory does not exist', () => {
    expect(findLatestSession(join(root, 'nope'))).toBeNull();
  });

  it('returns null when there are no resumable sessions', () => {
    expect(findLatestSession(root)).toBeNull();
  });

  it('picks the session with the newest conversation.json mtime', () => {
    makeSession('older', new Date('2026-05-18T00:00:00Z'));
    makeSession('newer', new Date('2026-05-20T00:00:00Z'));
    makeSession('middle', new Date('2026-05-19T00:00:00Z'));
    expect(findLatestSession(root)).toBe('newer');
  });

  it('ignores session dirs without a conversation.json', () => {
    makeSession('has-convo', new Date('2026-05-18T00:00:00Z'));
    makeSession('no-convo', new Date('2026-05-25T00:00:00Z'), false);
    expect(findLatestSession(root)).toBe('has-convo');
  });

  it('loadSessionMeta reads state.json', () => {
    makeSession('s1', new Date());
    const meta = loadSessionMeta(join(root, 's1'));
    expect(meta?.sessionId).toBe('s1');
  });

  it('loadSessionMeta returns null when state.json is absent', () => {
    expect(loadSessionMeta(join(root, 'missing'))).toBeNull();
  });
});
