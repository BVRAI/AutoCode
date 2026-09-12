import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerSink } from '../../src/server/ServerSink.js';
import { PresentationRun } from '../../src/repl/PresentationRun.js';
import { TranscriptStore } from '../../src/session/TranscriptStore.js';
import { ConsoleRenderer } from '../../src/repl/ConsoleRenderer.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const items: Array<Record<string, any>> = [];
  const sink = new ServerSink((method, p) => { if (p.item) items.push({ method, ...p.item as object }); }, true);
  sink.beginTurn('turn_1');
  return { sink, items };
}

describe('server presentation records', () => {
  it('pairs duplicate tool names completing out of order by actual tool-use ID', async () => {
    const { sink, items } = fixture();
    await new PresentationRun('submission').run(async () => {
      sink.emit('tool_call', { name: 'edit_file', toolCallId: 'first', args: { path: 'same.txt' } });
      sink.emit('tool_call', { name: 'edit_file', toolCallId: 'second', args: { path: 'same.txt' } });
      for (const toolCallId of ['second', 'first']) {
        sink.emit('tool_result', { name: 'edit_file', toolCallId, metadata: { before: 'old', after: 'new', path: 'same.txt' } });
        sink.diff('same.txt', 'old\n', 'new\n', { toolCallId, changeKind: 'modified' });
      }
      sink.diff('unattributed.txt', 'old', 'new');
    });
    expect(items.map(i => i.presentation.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const change of items.filter(i => i.type === 'file_change')) {
      const start = items.find(i => i.method === 'item.started' && i.presentation.toolCallId === change.presentation.toolCallId)!;
      const result = items.find(i => i.type === 'tool_call' && i.method === 'item.completed' && i.presentation.toolCallId === change.presentation.toolCallId)!;
      expect(result.id).toBe(start.id);
      expect(change.toolId).toBe(start.id);
      expect(change.diff).toContain('-old\n+new');
      expect(result.metadata).toEqual({ path: 'same.txt' });
    }
  });

  it('publishes exactly the committed transcript messages after streaming, even with duplicate text', async () => {
    const { sink, items } = fixture();
    const renderer = new ConsoleRenderer();
    renderer.setSink(sink);
    const dir = mkdtempSync(join(tmpdir(), 'presentation-transcript-'));
    dirs.push(dir);
    const store = new TranscriptStore({ sessionId: 'session', projectRoot: dir, sessionDir: dir, dataDir: dir,
      startedAt: new Date().toISOString(), model: { provider: 'xai', model: 'fake' } });
    await new PresentationRun('same-submission').run(async () => {
      renderer.beginAssistantStream();
      renderer.streamChunk('partial text from a failed stream');
      renderer.endAssistantStream();
      renderer.beginAssistantStream();
      renderer.streamChunk('same textsame text');
      renderer.endAssistantStream();
      for (let i = 0; i < 2; i++) {
        const presentation = store.appendTranscript({ role: 'assistant', text: 'same text' });
        renderer.assistantCommitted('same text', presentation);
      }
      store.saveConversation([{ role: 'assistant', content: 'same text' }], { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    });
    const rows = readFileSync(store.paths().transcript, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const committed = items.filter(i => i.type === 'agent_message' && i.method === 'item.completed' && i.text);
    expect(committed).toHaveLength(2);
    expect(committed.map(i => i.presentation)).toEqual(rows.map(r => r.presentation));
    expect(new Set(committed.map(i => i.presentation.messageId)).size).toBe(2);
    expect(committed.map(i => i.presentation.sequence)).toEqual([1, 2]);
    expect(readFileSync(store.paths().conversation, 'utf8')).not.toContain('presentation');
    expect(readFileSync(store.paths().conversation, 'utf8')).not.toContain('submissionId');
  });

  it('marks oversized data honestly, and keeps final-newline and CRLF evidence', async () => {
    const { sink, items } = fixture();
    await new PresentationRun('submission').run(async () => {
      sink.diff('created.txt', '', 'hello', { toolCallId: 'create', changeKind: 'created' });
      sink.diff('endings.txt', 'same\r\n', 'same\n', { toolCallId: 'endings', changeKind: 'modified' });
      sink.diff('large.txt', '', 'é'.repeat(1024 * 1024 + 1), { toolCallId: 'large', changeKind: 'created' });
    });
    expect(items[0]?.diff).toContain('\\ No newline at end of file');
    expect(items[0]?.changeKind).toBe('created');
    expect(items[1]?.diff).toContain('-same\r\n+same');
    expect(items[2]?.availability).toBe('too_large');
    expect(items[2]?.diff).toBe('');
    expect(items[2]?.added).toBe(1);
  });

  it('keeps legacy non-scoped renderer calls working without inventing identities', () => {
    const { sink, items } = fixture();
    sink.assistant('legacy response');
    sink.emit('tool_call', { name: 'edit_file', args: {} });
    sink.emit('tool_result', { name: 'edit_file' });
    sink.diff('legacy.txt', 'old', 'new');
    expect(items[0]?.text).toBe('legacy response');
    expect(items.every(i => !i.presentation)).toBe(true);
    expect(items[1]?.id).toBe(items[2]?.id);
  });

  it('preserves ID-less review activity without assigning it to an identified file edit', async () => {
    const { sink, items } = fixture();
    await new PresentationRun('submission').run(async () => {
      sink.emit('tool_call', { name: 'review', args: {} });
      sink.emit('tool_call', { name: 'edit_file', args: {}, toolCallId: 'edit' });
      sink.emit('tool_result', { name: 'review' });
      sink.emit('tool_result', { name: 'edit_file', toolCallId: 'edit' });
    });
    expect(items[0]?.id).toBe(items[2]?.id);
    expect(items[1]?.id).toBe(items[3]?.id);
    expect(items[2]?.presentation.toolCallId).toBeUndefined();
    expect(items[3]?.presentation.toolCallId).toBe('edit');
  });
});
