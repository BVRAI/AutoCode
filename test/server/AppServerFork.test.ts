// Branching over the app server (2026-09-07): `session.new { forkFrom }` seeds a NEW
// session with another session's conversation and never touches the source. Its own
// file so the fake script — a looping one-liner — and the module registry belong to
// this test alone; the main AppServer test walks its own script to the end.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
}

let home: string;
let project: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string): void {
  savedEnv[k] = process.env[k];
  process.env[k] = v;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'autocode-server-fork-'));
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
  // One text turn, looping: every turn in every session answers the same way, so the
  // only thing that differs between the source and the branch is how many turns each took.
  writeFileSync(script, JSON.stringify({ delayMs: 0, loop: true, turns: [{ text: 'Noted.', usage: { inputTokens: 100, outputTokens: 5 } }] }));
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

describe('AppServer session.new with forkFrom', () => {
  it('branches: a fresh id seeded with the source history, then its own turns; the source untouched', async () => {
    const { AppServer } = await import('../../src/server/AppServer.js');
    const client = new Client();
    const server = new AppServer({ input: client.input, output: client.output });
    const exit = server.run();
    await client.waitFor((m) => m.method === 'server.ready');
    await client.call('initialize');

    // Every session numbers its turns from turn_1, so "the completion for THIS submit" is the
    // first turn.completed that arrives after the submit — not one matched by id.
    const completedAfter = (mark: number): Promise<Msg> =>
      client.waitFor((m) => m.method === 'turn.completed' && client.messages.indexOf(m) >= mark);

    const source = await client.call('session.new', { projectRoot: project, mode: 'autocode', provider: 'xai', model: 'grok-code-fast-1' });
    expect(source.error).toBeUndefined();
    const sourceId = String(source.result?.['sessionId']);
    let mark = client.messages.length;
    const first = await client.call('turn.submit', { text: 'summarize the readme' });
    expect(first.error).toBeUndefined();
    await completedAfter(mark);
    const sourceDir = join(home, 'data', 'sessions', sourceId);
    const messagesOf = (dir: string): unknown[] => (JSON.parse(readFileSync(join(dir, 'conversation.json'), 'utf8')) as { messages: unknown[] }).messages;
    expect(messagesOf(sourceDir).length).toBeGreaterThan(0);

    // A bad id is an invalid-params error — and costs the live session nothing.
    const missing = await client.call('session.new', { projectRoot: project, forkFrom: 'nope' });
    expect(missing.error?.code).toBe(-32602);
    expect((await client.call('session.info')).result?.['sessionId']).toBe(sourceId);

    const branch = await client.call('session.new', { forkFrom: sourceId, mode: 'autocode' });
    expect(branch.error).toBeUndefined();
    const branchId = String(branch.result?.['sessionId']);
    expect(branchId).not.toBe(sourceId);
    expect(branch.result?.['forkedFrom']).toBe(sourceId);
    expect(branch.result?.['projectRoot']).toBe(project);
    const branchDir = join(home, 'data', 'sessions', branchId);
    expect((JSON.parse(readFileSync(join(branchDir, 'state.json'), 'utf8')) as { sessionId: string }).sessionId).toBe(branchId);
    const sourceMessages = messagesOf(sourceDir);
    expect(messagesOf(branchDir)).toEqual(sourceMessages);
    expect(existsSync(join(branchDir, 'transcript.jsonl'))).toBe(true);

    // The branch continues on its own; the source keeps exactly the history it had.
    mark = client.messages.length;
    const second = await client.call('turn.submit', { text: 'and now the branch' });
    expect(second.error).toBeUndefined();
    await completedAfter(mark);
    expect(messagesOf(branchDir).length).toBeGreaterThan(sourceMessages.length);
    expect(messagesOf(sourceDir)).toEqual(sourceMessages);

    const down = await client.call('shutdown');
    expect(down.error).toBeUndefined();
    expect(await exit).toBe(0);
  }, 60_000);
});
