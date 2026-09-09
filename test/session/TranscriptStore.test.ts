import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { TranscriptStore } from '../../src/session/TranscriptStore.js';
import type { SessionContext } from '../../src/session/SessionContext.js';
import type { Message } from '../../src/llm/types.js';
import { SubmissionAccounting } from '../../src/llm/SubmissionAccounting.js';

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

  it('stores submission identity only in scoped presentation records, never model context', async () => {
    const store = new TranscriptStore(ctx);
    const messages: Message[] = [{ role: 'user', content: 'same text' }];
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    store.appendTranscript({ role: 'user', text: 'legacy' });
    for (const id of ['first-submission', 'second-submission']) {
      await new SubmissionAccounting(id, () => {}).run(async () => {
        store.appendTranscript({ role: 'user', text: 'same text' });
        await Promise.resolve();
        store.appendTranscript({ role: 'assistant', text: 'same answer' });
        store.saveConversation(messages, usage);
      });
    }
    const records = readFileSync(store.paths().transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(x => x.submissionId)).toEqual([undefined, 'first-submission', 'first-submission', 'second-submission', 'second-submission']);
    expect(records.every(x => Number.isFinite(Date.parse(x.timestamp)))).toBe(true);
    expect(readFileSync(store.paths().conversation, 'utf8')).not.toContain('submissionId');
    expect(store.loadConversation()).toEqual({ messages, usage });
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

  it('round-trips a conversation with tool_use/tool_result blocks', () => {
    const store = new TranscriptStore(ctx);
    const messages: Message[] = [
      { role: 'user', content: 'create a file' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Creating it now.' },
          { type: 'tool_use', id: 'tu_1', name: 'write_file', input: { path: 'a.txt', content: 'hi' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tu_1', content: 'OK', isError: false }],
      },
    ];
    const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 3 };
    store.saveConversation(messages, usage);

    const loaded = store.loadConversation();
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toEqual(messages);
    expect(loaded!.usage).toEqual(usage);
  });

  it('round-trips messages containing thinking blocks', () => {
    const store = new TranscriptStore(ctx);
    const messages: Message[] = [
      { role: 'user', content: 'fix the bug' },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            text: 'the bug is in parse()',
            signature: 'sig-xyz',
            opaque: [{ type: 'reasoning.text', text: 'the bug is in parse()', index: 0 }],
          },
          { type: 'text', text: 'Found it.' },
        ],
      },
    ];
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
    store.saveConversation(messages, usage);
    const loaded = store.loadConversation();
    expect(loaded!.messages).toEqual(messages);
  });

  it('loadConversation returns null when no conversation file exists', () => {
    const store = new TranscriptStore(ctx);
    expect(store.loadConversation()).toBeNull();
  });

  it('loadConversation returns null on a corrupt file', () => {
    const store = new TranscriptStore(ctx);
    writeFileSync(store.paths().conversation, '{ not valid json', 'utf8');
    expect(store.loadConversation()).toBeNull();
  });

  it('loadConversation returns null on a version mismatch', () => {
    const store = new TranscriptStore(ctx);
    writeFileSync(
      store.paths().conversation,
      JSON.stringify({ version: 999, messages: [], usage: {} }),
      'utf8',
    );
    expect(store.loadConversation()).toBeNull();
  });
});
