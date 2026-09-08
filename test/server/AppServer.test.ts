// The app-server protocol (Phase 5.1) driven end to end over in-memory
// streams with the fake model: initialize → session.new → turn.submit →
// items → turn.completed → shutdown, plus the error codes a host relies on.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Msg = Record<string, unknown> & { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } };

class Client {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly messages: Msg[] = [];
  private seq = 0;
  private readonly waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];

  constructor() {
    const rl = createInterface({ input: this.output });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      const m = JSON.parse(line) as Msg;
      this.messages.push(m);
      for (const w of [...this.waiters]) {
        if (w.pred(m)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
  }

  waitFor(pred: (m: Msg) => boolean, timeoutMs = 20_000): Promise<Msg> {
    const seen = this.messages.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; saw ${this.messages.map((m) => m.method ?? `resp:${m.id}`).join(', ')}`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolvePromise(m);
        },
      });
    });
  }

  async call(method: string, params?: Record<string, unknown>): Promise<Msg> {
    this.seq += 1;
    const id = this.seq;
    this.input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return this.waitFor((m) => m.id === id && !m.method);
  }

  notifications(method: string): Msg[] {
    return this.messages.filter((m) => m.method === method);
  }
}

let home: string;
let project: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string): void {
  savedEnv[k] = process.env[k];
  process.env[k] = v;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'autocode-server-'));
  project = join(home, 'project');
  cpSync(resolve('test/e2e/fixtures/project'), project, { recursive: true });
  const configDir = join(home, '.autocode');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      firstRunCompletedAt: '2026-01-01T00:00:00.000Z',
      autoVerify: false,
      review: 'off',
      autoMode: { reviewer: false },
      autoUpdate: false,
      reflectAfterSession: false,
      webTools: { enabled: false },
      defaultProvider: 'xai',
      defaultModel: 'grok-code-fast-1',
    }),
  );
  const script = join(home, 'fake.json');
  writeFileSync(
    script,
    JSON.stringify({
      delayMs: 0,
      turns: [
        {
          thinking: 'Reading the readme first.',
          tools: [
            { name: 'read_file', input: { path: 'README.md' } },
            { name: 'todo_write', input: { action: 'set', items: [{ id: 't1', text: 'read the readme', status: 'completed' }, { id: 't2', text: 'answer', status: 'in_progress' }] } },
            { name: 'write_file', input: { path: 'NOTES.md', content: 'notes from the server test\n' } },
          ],
        },
        { text: 'Hello from the server test.', usage: { inputTokens: 500, outputTokens: 20 } },
        { tools: [{ name: 'run_shell', input: { command: 'git push --force origin main' } }] },
        { text: 'Second turn done.' },
      ],
    }),
  );
  setEnv('AUTOCODE_CONFIG_DIR', configDir);
  setEnv('AUTOCODE_DATA_DIR', join(home, 'data'));
  setEnv('AUTOCODE_FAKE_LLM', script);
  setEnv('AUTOCODE_TRUST_ALL', '1');
  setEnv('AUTOCODE_NO_INDEX', '1');
  setEnv('AUTOCODE_NO_CHECK_STAGES', '1');
  setEnv('AUTOCODE_REVIEW', 'off');
  setEnv('AUTOCODE_AUTO_JUDGE', 'off');
  setEnv('AUTOCODE_E2E', '1');
  setEnv('NO_UPDATE_NOTIFIER', '1');
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* windows file locks */
  }
});

describe('AppServer over stdio (Phase 5.1)', () => {
  it('runs a session: initialize, session.new, a streamed turn, a request/respond, shutdown', async () => {
    const { AppServer } = await import('../../src/server/AppServer.js');
    const client = new Client();
    const server = new AppServer({ input: client.input, output: client.output });
    const exit = server.run();

    await client.waitFor((m) => m.method === 'server.ready');

    // Errors a host relies on: no session yet, unknown method.
    const early = await client.call('session.info');
    expect(early.error?.code).toBe(-32001);
    const unknown = await client.call('nope');
    expect(unknown.error?.code).toBe(-32601);

    const init = await client.call('initialize');
    expect(init.result?.['protocolVersion']).toBe(1);
    const caps = init.result?.['capabilities'] as Record<string, unknown>;
    expect(caps['streaming']).toBe(true);
    expect(caps['items']).toContain('tool_call');

    const created = await client.call('session.new', {
      projectRoot: project,
      mode: 'autocode',
      provider: 'xai',
      model: 'grok-code-fast-1',
      // Host-supplied policy: a verify command that always passes, a cost
      // ceiling and a briefing for the system prompt.
      autoVerify: true,
      verifyCommand: 'node -e "process.exit(0)"',
      maxCostUsd: 1,
      systemAppendix: 'This session is driven by the AppServer test.',
    });
    expect(created.error).toBeUndefined();
    expect(typeof created.result?.['sessionId']).toBe('string');
    expect(created.result?.['mode']).toBe('autocode');
    expect(client.notifications('session.ready')).toHaveLength(1);

    // Turn 1: a read_file tool call, then a streamed answer.
    const submitted = await client.call('turn.submit', { text: 'summarize the readme' });
    const turnId = submitted.result?.['turnId'];
    expect(turnId).toBe('turn_1');
    await client.waitFor((m) => m.method === 'turn.completed' && m.params?.['turnId'] === turnId);

    const started = client.notifications('turn.started');
    expect(started[0]?.params?.['turnId']).toBe('turn_1');
    const items = client.notifications('item.completed').map((m) => m.params?.['item'] as Record<string, unknown>);
    const tool = items.find((i) => i['type'] === 'tool_call' && i['name'] === 'read_file');
    expect(tool?.['status']).toBe('ok');
    expect(String(tool?.['summary'])).toMatch(/README/);
    const reasoning = items.find((i) => i['type'] === 'reasoning');
    expect(String(reasoning?.['text'])).toContain('Reading the readme first.');
    const message = items.find((i) => i['type'] === 'agent_message');
    expect(String(message?.['text'])).toContain('Hello from the server test.');
    // The checklist and the verify run reach the host as their own items.
    const todo = items.find((i) => i['type'] === 'todo');
    expect(todo?.['items']).toEqual([
      { id: 't1', text: 'read the readme', status: 'completed' },
      { id: 't2', text: 'answer', status: 'in_progress' },
    ]);
    const verification = items.find((i) => i['type'] === 'verification');
    expect(verification?.['passed']).toBe(true);
    expect(String(verification?.['command'])).toContain('process.exit(0)');
    const change = items.find((i) => i['type'] === 'file_change');
    expect(String(change?.['path'])).toContain('NOTES.md');
    expect(client.notifications('item.updated').some((m) => (m.params?.['item'] as Record<string, unknown>)['type'] === 'agent_message')).toBe(true);
    expect(client.notifications('usage').length).toBeGreaterThan(0);

    const info = await client.call('session.info');
    expect(info.result?.['busy']).toBe(false);
    expect(info.result?.['mode']).toBe('autocode');

    // Commands: status works, an unknown one is an invalid-params error.
    const status = await client.call('session.command', { name: 'status' });
    expect(status.result?.['output']).toBe('ok');
    const bad = await client.call('session.command', { name: 'frobnicate' });
    expect(bad.error?.code).toBe(-32602);

    // Turn 2: a risky command → request.confirm → the host declines → the
    // tool reports the decline and the turn still completes.
    const second = await client.call('turn.submit', { text: 'push it' });
    expect(second.result?.['turnId']).toBe('turn_2');
    const req = await client.waitFor((m) => m.method === 'request.confirm');
    expect(String(req.params?.['message'])).toContain('git push --force origin main');
    const stale = await client.call('respond', { requestId: 'req_999', answer: true });
    expect(stale.error?.code).toBe(-32602);
    const answered = await client.call('respond', { requestId: req.params?.['requestId'], answer: false });
    expect(answered.error).toBeUndefined();
    await client.waitFor((m) => m.method === 'turn.completed' && m.params?.['turnId'] === 'turn_2');
    const shell = client
      .notifications('item.completed')
      .map((m) => m.params?.['item'] as Record<string, unknown>)
      .find((i) => i['type'] === 'tool_call' && i['name'] === 'run_shell');
    expect(shell?.['status']).toBe('error');
    expect(String(shell?.['summary'])).toMatch(/declined/);

    const down = await client.call('shutdown');
    expect(down.error).toBeUndefined();
    expect(await exit).toBe(0);
  }, 60_000);

});
