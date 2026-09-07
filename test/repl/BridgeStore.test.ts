import { describe, it, expect } from 'vitest';
import { BridgeStore } from '../../src/repl/ink/store.js';

const ok = (content: string, summary = '') => ({ summary, content, isError: false });

describe('BridgeStore — tool rows', () => {
  it('startTool commits a running row labelled like Claude Code', () => {
    const s = new BridgeStore();
    const id = s.startTool('read_file', { path: 'src/app.ts' });
    const item = s.get().items.find((i) => i.id === id)!;
    expect(item.kind).toBe('tool');
    expect(item.tool).toMatchObject({ name: 'read_file', label: 'Read', arg: 'src/app.ts', group: 'read', status: 'running' });
  });

  it('finishTool phrases the result row from the call args and the result', () => {
    const s = new BridgeStore();
    const id = s.startTool('read_file', { path: 'src/app.ts' });
    s.finishTool(id, ok('a\nb'), 12);
    const tool = s.get().items.find((i) => i.id === id)!.tool!;
    expect(tool.status).toBe('ok');
    expect(tool.durationMs).toBe(12);
    expect(tool.summary).toBe('Read 2 lines (ctrl+o to expand)');
    expect(tool.bodyLines).toBeUndefined();
  });

  it('verbose mode (ctrl+o) commits expanded results', () => {
    const s = new BridgeStore();
    s.toggleVerbose();
    const id = s.startTool('read_file', { path: 'a.ts' });
    s.finishTool(id, ok('a\nb'));
    expect(s.get().items[0]!.tool!.bodyLines).toEqual(['a', 'b']);
  });

  it('errors mark the row and keep the message', () => {
    const s = new BridgeStore();
    const id = s.startTool('run_shell', { command: 'npm test' });
    s.finishTool(id, { summary: 'exit 1', content: 'FAIL src/x.test.ts', isError: true });
    const tool = s.get().items[0]!.tool!;
    expect(tool.status).toBe('err');
    expect(tool.summary).toBe('Error: exit 1');
    expect(tool.bodyLines).toEqual(['FAIL src/x.test.ts']);
  });

  it('attachDiff hangs a numbered diff and the stats line under the last edit', () => {
    const s = new BridgeStore();
    const id = s.startTool('edit_file', { path: 'a.ts' });
    s.finishTool(id, ok('', 'edited'));
    s.attachDiff('a.ts', 'x\ny\n', 'x\nz\n');
    const tool = s.get().items[0]!.tool!;
    expect(tool.summary).toBe('Updated a.ts with 1 addition and 1 removal');
    expect(tool.stats).toEqual({ added: 1, removed: 1 });
    expect(tool.diffRows!.length).toBeGreaterThan(0);
    // The diff is consumed: a second one does not re-attach to the same row.
    s.attachDiff('b.ts', 'p\n', 'q\n');
    expect(s.get().items.at(-1)!.kind).toBe('diff');
  });

  it('attachDiff without a preceding edit falls back to a standalone diff item', () => {
    const s = new BridgeStore();
    s.attachDiff('a.ts', 'x', 'y');
    expect(s.get().items[0]).toMatchObject({ kind: 'diff', diff: { label: 'a.ts', before: 'x', after: 'y' } });
  });

  it('closeTool only touches rows still running', () => {
    const s = new BridgeStore();
    const id = s.startTool('read_file', { path: 'a.ts' });
    s.closeTool(id, 'err');
    expect(s.get().items[0]!.tool!.status).toBe('err');
    s.closeTool(id, 'ok');
    expect(s.get().items[0]!.tool!.status).toBe('err');
  });
});

describe('BridgeStore — streaming, thinking and the turn', () => {
  it('streams the answer live and commits it once', () => {
    const s = new BridgeStore();
    s.streamChunk('hel');
    s.streamChunk('lo');
    expect(s.get().streaming).toBe('hello');
    expect(s.get().liveOutputChars).toBe(5);
    s.commitAssistant('hello');
    expect(s.get().streaming).toBeNull();
    expect(s.get().items.at(-1)).toMatchObject({ kind: 'assistant', text: 'hello' });
    s.commitAssistant('   ');
    expect(s.get().items.length).toBe(1);
  });

  it('collapses thinking into a stub with a summary', () => {
    const s = new BridgeStore();
    s.thinkingChunk('first line\n');
    s.thinkingChunk('\nsecond');
    expect(s.get().thinkingLive?.text).toBe('first line\n\nsecond');
    s.thinkingEnd(4000);
    expect(s.get().thinkingLive).toBeNull();
    expect(s.get().items.at(-1)).toMatchObject({ kind: 'thinking', durationMs: 4000, thinkingLines: ['first line', 'second'] });
  });

  it('beginTurn / turnEnd bracket the turn state', () => {
    const s = new BridgeStore();
    s.beginTurn();
    s.setBusy(true);
    s.setActivity('Thinking');
    expect(s.get().turn).toBe(1);
    expect(s.get().turnStartedAt).not.toBeNull();
    const info = { durationMs: 23_000, endedAt: Date.now(), inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 };
    s.turnEnd(info);
    const st = s.get();
    expect(st.busy).toBe(false);
    expect(st.activity).toBeNull();
    expect(st.turnStartedAt).toBeNull();
    expect(st.items.at(-1)).toMatchObject({ kind: 'turn_end', durationMs: 23_000, turnEnd: info });
  });

  it('setActivity keeps the start time while the verb is unchanged', () => {
    const s = new BridgeStore();
    let emits = 0;
    s.subscribe(() => emits++);
    s.setActivity('Reading');
    const since = s.get().activity!.since;
    s.setActivity('Reading');
    expect(emits).toBe(1);
    expect(s.get().activity!.since).toBe(since);
    s.setActivity(null);
    s.setActivity(null);
    expect(emits).toBe(2);
    expect(s.get().activity).toBeNull();
  });

  it('reset keeps mode, model and verbose but drops the transcript', () => {
    const s = new BridgeStore();
    s.setMode('planning');
    s.setModel('xai', 'grok');
    s.toggleVerbose();
    s.appendText('info', 'hi');
    s.reset();
    const st = s.get();
    expect(st.items).toEqual([]);
    expect(st.mode).toBe('planning');
    expect(st.model).toEqual({ provider: 'xai', name: 'grok' });
    expect(st.verbose).toBe(true);
  });
});
