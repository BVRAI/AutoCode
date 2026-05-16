import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptStore } from '../../src/session/TranscriptStore.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

describe('TranscriptStore', () => {
  let tmp: string;
  let ctx: SessionContext;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'autocode-test-'));
    ctx = {
      sessionId: 'test-session',
      projectRoot: tmp,
      dataDir: tmp,
      sessionDir: join(tmp, 'session'),
      model: { provider: 'anthropic', model: 'claude-opus-4-7' },
      startedAt: '2026-05-16T00:00:00Z',
    };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes initial state.json on construction', () => {
    const store = new TranscriptStore(ctx);
    const state = JSON.parse(readFileSync(store.paths().state, 'utf8'));
    expect(state.sessionId).toBe('test-session');
    expect(state.provider).toBe('anthropic');
    expect(state.cancelRequested).toBe(false);
  });

  it('appends transcript entries as JSONL', () => {
    const store = new TranscriptStore(ctx);
    store.appendTranscript({ role: 'user', text: 'hello' });
    store.appendTranscript({ role: 'assistant', text: 'hi back' });
    const lines = readFileSync(store.paths().transcript, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).role).toBe('user');
    expect(JSON.parse(lines[1]!).text).toBe('hi back');
  });

  it('appends tool log entries with status', () => {
    const store = new TranscriptStore(ctx);
    store.appendToolLog({
      tool: 'read_file',
      arguments: { path: 'foo.ts' },
      status: 'success',
      durationMs: 42,
      summary: 'read 1024 bytes',
    });
    const line = JSON.parse(readFileSync(store.paths().toolLog, 'utf8').trim());
    expect(line.tool).toBe('read_file');
    expect(line.status).toBe('success');
    expect(line.durationMs).toBe(42);
  });

  it('updates lastActiveAt on touch', () => {
    const store = new TranscriptStore(ctx);
    store.touch('inspecting repo');
    const state = JSON.parse(readFileSync(store.paths().state, 'utf8'));
    expect(state.currentTask).toBe('inspecting repo');
    expect(state.lastActiveAt).not.toBe(state.createdAt);
  });
});
