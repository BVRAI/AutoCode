// Pictures over the app server (2026-09-07): `turn.submit { text, images }` puts an image
// block after the text in the user message the loop keeps, and refuses malformed entries
// before the turn starts. Own file for the same reason as the fork test — its own looping
// fake script and module registry.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// A 1×1 transparent PNG.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let home: string;
let project: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string): void {
  savedEnv[k] = process.env[k];
  process.env[k] = v;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'autocode-server-images-'));
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
  writeFileSync(script, JSON.stringify({ delayMs: 0, loop: true, turns: [{ text: 'A small square.', usage: { inputTokens: 100, outputTokens: 5 } }] }));
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

describe('AppServer turn.submit with images', () => {
  it('keeps the picture as an image block after the text, and refuses malformed entries up front', async () => {
    const { AppServer } = await import('../../src/server/AppServer.js');
    const client = new Client();
    const server = new AppServer({ input: client.input, output: client.output });
    const exit = server.run();
    await client.waitFor((m) => m.method === 'server.ready');
    await client.call('initialize');
    const created = await client.call('session.new', { projectRoot: project, mode: 'autocode', provider: 'xai', model: 'grok-code-fast-1' });
    expect(created.error).toBeUndefined();
    const sessionId = String(created.result?.['sessionId']);

    // Refused before anything runs: wrong media type, a data: URL, too many, no text.
    const badType = await client.call('turn.submit', { text: 'x', images: [{ mediaType: 'image/svg+xml', data: PNG_1X1 }] });
    expect(badType.error?.code).toBe(-32602);
    const dataUrl = await client.call('turn.submit', { text: 'x', images: [{ mediaType: 'image/png', data: `data:image/png;base64,${PNG_1X1}` }] });
    expect(dataUrl.error?.code).toBe(-32602);
    const tooMany = await client.call('turn.submit', { text: 'x', images: Array.from({ length: 9 }, () => ({ mediaType: 'image/png', data: PNG_1X1 })) });
    expect(tooMany.error?.code).toBe(-32602);
    const noText = await client.call('turn.submit', { text: '   ', images: [{ mediaType: 'image/png', data: PNG_1X1 }] });
    expect(noText.error?.code).toBe(-32602);
    expect((await client.call('session.info')).result?.['busy']).toBe(false);

    const mark = client.messages.length;
    const submitted = await client.call('turn.submit', { text: 'what colour is this?', images: [{ mediaType: 'image/png', data: PNG_1X1 }] });
    expect(submitted.error).toBeUndefined();
    await client.waitFor((m) => m.method === 'turn.completed' && client.messages.indexOf(m) >= mark);

    const conversation = JSON.parse(readFileSync(join(home, 'data', 'sessions', sessionId, 'conversation.json'), 'utf8')) as {
      messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
    };
    const user = conversation.messages.find((m) => m.role === 'user');
    expect(Array.isArray(user?.content)).toBe(true);
    const parts = user!.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'text', text: 'what colour is this?' });
    expect(parts[1]).toEqual({ type: 'image', mediaType: 'image/png', data: PNG_1X1 });

    const down = await client.call('shutdown');
    expect(down.error).toBeUndefined();
    expect(await exit).toBe(0);
  }, 60_000);
});
