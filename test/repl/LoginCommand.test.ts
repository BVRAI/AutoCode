import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stateful in-memory keytar mock — same as SecretStore.test.ts so login
// writes land in this map instead of the real OS keyring.
const keytarState: Map<string, string> = new Map();
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(async (s: string, a: string) => keytarState.get(`${s}::${a}`) ?? null),
    setPassword: vi.fn(async (s: string, a: string, p: string) => { keytarState.set(`${s}::${a}`, p); }),
    deletePassword: vi.fn(async (s: string, a: string) => keytarState.delete(`${s}::${a}`)),
  },
}));

import { runLogin, printAlreadyAuthenticatedNotice, printLoginInstructions } from '../../src/repl/LoginCommand.js';
import { initialize as initSecretStore, getSecret, _resetForTests } from '../../src/auth/SecretStore.js';

// In-memory renderer that collects every output line for assertion. Real
// ConsoleRenderer writes to stdout (or the Bridge sink); we just need a
// way to inspect what runLogin printed.
class CapturingRenderer {
  readonly out: Array<{ level: 'info' | 'dim' | 'warn' | 'error' | 'status' | 'assistant' | 'user' | 'rule'; text: string }> = [];
  info(t: string): void { this.out.push({ level: 'info', text: t }); }
  dim(t: string): void { this.out.push({ level: 'dim', text: t }); }
  warn(t: string): void { this.out.push({ level: 'warn', text: t }); }
  error(t: string): void { this.out.push({ level: 'error', text: t }); }
  status(t: string): void { this.out.push({ level: 'status', text: t }); }
  assistant(t: string): void { this.out.push({ level: 'assistant', text: t }); }
  user(t: string): void { this.out.push({ level: 'user', text: t }); }
  rule(): void { this.out.push({ level: 'rule', text: '' }); }
  hasText(needle: string): boolean {
    return this.out.some((e) => e.text.includes(needle));
  }
  textAtLevel(level: CapturingRenderer['out'][number]['level']): string[] {
    return this.out.filter((e) => e.level === level).map((e) => e.text);
  }
}

describe('runLogin (Phase A — arg-based flow)', () => {
  let tmp: string;
  let origDataDir: string | undefined;
  let origConfigDir: string | undefined;
  let origFetch: typeof globalThis.fetch;
  const envBefore = { ...process.env };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'autocode-login-test-'));
    origDataDir = process.env.AUTOCODE_DATA_DIR;
    origConfigDir = process.env.AUTOCODE_CONFIG_DIR;
    // ConfigStore reads via configDir() in paths.ts. AUTOCODE_CONFIG_DIR
    // is the explicit override; without it ConfigStore would write to the
    // user's real ~/.autocode/ (HOME/USERPROFILE manipulation isn't
    // reliable cross-platform). Tests stay fully isolated this way.
    process.env.AUTOCODE_CONFIG_DIR = tmp;
    process.env.AUTOCODE_DATA_DIR = tmp;
    delete process.env.AUTOMAX_PROXY_URL;
    delete process.env.AUTOMAX_PROXY_TOKEN;
    origFetch = globalThis.fetch;
    keytarState.clear();
    _resetForTests();
    await initSecretStore();
  });
  afterEach(() => {
    if (origDataDir === undefined) delete process.env.AUTOCODE_DATA_DIR;
    else process.env.AUTOCODE_DATA_DIR = origDataDir;
    if (origConfigDir === undefined) delete process.env.AUTOCODE_CONFIG_DIR;
    else process.env.AUTOCODE_CONFIG_DIR = origConfigDir;
    process.env = { ...envBefore };
    rmSync(tmp, { recursive: true, force: true });
    globalThis.fetch = origFetch;
    keytarState.clear();
    _resetForTests();
    vi.clearAllMocks();
  });

  it('rejects a key without the sk_amx_ prefix', async () => {
    const renderer = new CapturingRenderer();
    await runLogin(renderer as never, 'sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(renderer.hasText('must start with "sk_amx_"')).toBe(true);
    expect(getSecret('amx')).toBeUndefined();
  });

  it('rejects a key that is too short', async () => {
    const renderer = new CapturingRenderer();
    await runLogin(renderer as never, 'sk_amx_abc');
    expect(renderer.hasText('too short')).toBe(true);
    expect(getSecret('amx')).toBeUndefined();
  });

  it('rejects a 401 from the proxy and does NOT persist', async () => {
    globalThis.fetch = vi.fn(async () => new Response('invalid', { status: 401 })) as typeof globalThis.fetch;
    const renderer = new CapturingRenderer();
    await runLogin(renderer as never, 'sk_amx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(renderer.hasText('rejected the key')).toBe(true);
    expect(getSecret('amx')).toBeUndefined();
  });

  it('rejects a 403 from the proxy and does NOT persist', async () => {
    globalThis.fetch = vi.fn(async () => new Response('forbidden', { status: 403 })) as typeof globalThis.fetch;
    const renderer = new CapturingRenderer();
    await runLogin(renderer as never, 'sk_amx_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(renderer.hasText('rejected the key')).toBe(true);
    expect(getSecret('amx')).toBeUndefined();
  });

  it('persists with a warning on a 5xx response (treats as transient)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('server fault', { status: 503 })) as typeof globalThis.fetch;
    const renderer = new CapturingRenderer();
    await runLogin(renderer as never, 'sk_amx_ccccccccccccccccccccccccccccccccc');
    expect(renderer.hasText("Couldn't reach")).toBe(true);
    expect(getSecret('amx')).toBe('sk_amx_ccccccccccccccccccccccccccccccccc');
  });

  it('persists with a warning when fetch throws (network error)', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as typeof globalThis.fetch;
    const renderer = new CapturingRenderer();
    await runLogin(renderer as never, 'sk_amx_dddddddddddddddddddddddddddddddd');
    expect(renderer.hasText("Couldn't reach")).toBe(true);
    expect(getSecret('amx')).toBe('sk_amx_dddddddddddddddddddddddddddddddd');
  });

  it('persists and shows balance on a 200 response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        tier: 'automax',
        subscriptionCreditCents: 1500,
        topUpCreditCents: 2500,
        totalCreditCents: 4000,
        currentPeriodEnd: '2026-06-15T00:00:00Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as typeof globalThis.fetch;
    const renderer = new CapturingRenderer();
    await runLogin(renderer as never, 'sk_amx_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    expect(renderer.hasText('Logged in')).toBe(true);
    expect(renderer.hasText('automax')).toBe(true);
    expect(renderer.hasText('$15.00')).toBe(true);
    expect(renderer.hasText('$25.00')).toBe(true);
    expect(renderer.hasText('2026-06-15')).toBe(true);
    expect(getSecret('amx')).toBe('sk_amx_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  });

  it('sends Authorization: Bearer sk_amx_… on the validate call', async () => {
    let observedAuth = '';
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      observedAuth = headers.get('authorization') ?? '';
      return new Response(JSON.stringify({ tier: 'automax', subscriptionCreditCents: 0, topUpCreditCents: 0 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
    await runLogin(new CapturingRenderer() as never, 'sk_amx_ffffffffffffffffffffffffffffffff');
    expect(observedAuth).toBe('Bearer sk_amx_ffffffffffffffffffffffffffffffff');
  });

  it('honors AUTOMAX_PROXY_URL when validating', async () => {
    let observedUrl = '';
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      observedUrl = String(url);
      return new Response(JSON.stringify({ tier: 'automax', subscriptionCreditCents: 0, topUpCreditCents: 0 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
    process.env.AUTOMAX_PROXY_URL = 'https://staging.example.com';
    await runLogin(new CapturingRenderer() as never, 'sk_amx_ggggggggggggggggggggggggggggggg');
    expect(observedUrl).toBe('https://staging.example.com/v1/usage/me');
  });

  it('trims whitespace from the key argument', async () => {
    let observedAuth = '';
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      observedAuth = headers.get('authorization') ?? '';
      return new Response(JSON.stringify({ tier: 'automax', subscriptionCreditCents: 0, topUpCreditCents: 0 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
    await runLogin(new CapturingRenderer() as never, '  sk_amx_hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh  ');
    expect(observedAuth).toBe('Bearer sk_amx_hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh');
  });
});

describe('printLoginInstructions (wizard chain-through hint)', () => {
  it('points the user at /login (device-flow default)', () => {
    class R {
      out: string[] = [];
      info(t: string): void { this.out.push(t); }
      dim(t: string): void { this.out.push(t); }
      warn(): void {} error(): void {} status(): void {} assistant(): void {}
      user(): void {} rule(): void {}
    }
    const r = new R();
    printLoginInstructions(r as never);
    const all = r.out.join('\n');
    expect(all).toContain('/login');
    expect(all).toContain('browser');
  });
});

describe('runDeviceFlow (Phase B — no-arg /login)', () => {
  let tmp: string;
  let origDataDir: string | undefined;
  let origConfigDir: string | undefined;
  let origFetch: typeof globalThis.fetch;
  const envBefore = { ...process.env };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'autocode-deviceflow-test-'));
    origDataDir = process.env.AUTOCODE_DATA_DIR;
    origConfigDir = process.env.AUTOCODE_CONFIG_DIR;
    process.env.AUTOCODE_CONFIG_DIR = tmp;
    process.env.AUTOCODE_DATA_DIR = tmp;
    delete process.env.AUTOMAX_PROXY_URL;
    delete process.env.AUTOMAX_PROXY_TOKEN;
    origFetch = globalThis.fetch;
    keytarState.clear();
    _resetForTests();
    await initSecretStore();
  });
  afterEach(() => {
    if (origDataDir === undefined) delete process.env.AUTOCODE_DATA_DIR;
    else process.env.AUTOCODE_DATA_DIR = origDataDir;
    if (origConfigDir === undefined) delete process.env.AUTOCODE_CONFIG_DIR;
    else process.env.AUTOCODE_CONFIG_DIR = origConfigDir;
    process.env = { ...envBefore };
    rmSync(tmp, { recursive: true, force: true });
    globalThis.fetch = origFetch;
    keytarState.clear();
    _resetForTests();
    vi.clearAllMocks();
  });

  // Build a sequenced fetch mock — each call returns the next Response in
  // the queue, or throws if exhausted (catches "called more times than
  // expected" in test logic).
  function queueFetch(responses: Response[]): void {
    let i = 0;
    globalThis.fetch = vi.fn(async () => {
      if (i >= responses.length) throw new Error('mock fetch exhausted');
      return responses[i++]!;
    }) as typeof globalThis.fetch;
  }

  function startResp(): Response {
    return new Response(JSON.stringify({
      device_code: 'dev-code-12345',
      user_code: 'XKMP-QR3V',
      verification_uri: 'https://bvrai.ca/cli-auth',
      verification_uri_complete: 'https://bvrai.ca/cli-auth?code=XKMP-QR3V',
      expires_in: 600,
      interval: 5,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  function pollResp(body: object): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  it('happy path: start → pending → ok → key saved + balance shown', async () => {
    queueFetch([
      startResp(),
      pollResp({ status: 'pending' }),
      pollResp({ status: 'ok', access_token: 'sk_amx_devflow1234567890abcdef12345678' }),
      pollResp({ tier: 'automax', subscriptionCreditCents: 2000, topUpCreditCents: 500, currentPeriodEnd: '2026-06-15T00:00:00Z' }),
    ]);
    const renderer = new CapturingRenderer();
    await runLogin(renderer as never, undefined, { pollIntervalOverrideMs: 1 });
    expect(renderer.hasText('XKMP-QR3V')).toBe(true);
    expect(renderer.hasText('Approved')).toBe(true);
    expect(renderer.hasText('automax')).toBe(true);
    expect(renderer.hasText('$20.00')).toBe(true);
    expect(renderer.hasText('$5.00')).toBe(true);
    expect(renderer.hasText('2026-06-15')).toBe(true);
    expect(getSecret('amx')).toBe('sk_amx_devflow1234567890abcdef12345678');
  });

  it('slow_down: keeps polling without bailing', async () => {
    queueFetch([
      startResp(),
      pollResp({ status: 'pending' }),
      pollResp({ status: 'slow_down' }),
      pollResp({ status: 'ok', access_token: 'sk_amx_slowed1234567890abcdef123456789' }),
      pollResp({ tier: 'automax', subscriptionCreditCents: 0, topUpCreditCents: 0 }),
    ]);
    const renderer = new CapturingRenderer();
    await runLogin(renderer as never, undefined, { pollIntervalOverrideMs: 1 });
    expect(renderer.hasText('Approved')).toBe(true);
    expect(getSecret('amx')).toBe('sk_amx_slowed1234567890abcdef123456789');
  });

  it('denied: prints error, does NOT save', async () => {
    queueFetch([startResp(), pollResp({ status: 'denied' })]);
    const renderer = new CapturingRenderer();
    await runLogin(renderer as never, undefined, { pollIntervalOverrideMs: 1 });
    expect(renderer.hasText('denied in the browser')).toBe(true);
    expect(getSecret('amx')).toBeUndefined();
  });

  it('expired: prints error, does NOT save', async () => {
    queueFetch([startResp(), pollResp({ status: 'expired' })]);
    const renderer = new CapturingRenderer();
    await runLogin(renderer as never, undefined, { pollIntervalOverrideMs: 1 });
    expect(renderer.hasText('expired')).toBe(true);
    expect(getSecret('amx')).toBeUndefined();
  });

  it('start failure (5xx): prints error, does NOT save', async () => {
    queueFetch([new Response('boom', { status: 500 })]);
    const renderer = new CapturingRenderer();
    await runLogin(renderer as never, undefined, { pollIntervalOverrideMs: 1 });
    expect(renderer.hasText("Couldn't start login")).toBe(true);
    expect(getSecret('amx')).toBeUndefined();
  });

  it('start failure (network throw): prints error, does NOT save', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as typeof globalThis.fetch;
    const renderer = new CapturingRenderer();
    await runLogin(renderer as never, undefined, { pollIntervalOverrideMs: 1 });
    expect(renderer.hasText("Couldn't reach")).toBe(true);
    expect(getSecret('amx')).toBeUndefined();
  });

  it('saves key even when the post-approval balance fetch fails', async () => {
    queueFetch([
      startResp(),
      pollResp({ status: 'ok', access_token: 'sk_amx_balancef1234567890abcdef1234567' }),
      new Response('balance unavailable', { status: 503 }),
    ]);
    const renderer = new CapturingRenderer();
    await runLogin(renderer as never, undefined, { pollIntervalOverrideMs: 1 });
    expect(renderer.hasText('Approved')).toBe(true);
    expect(renderer.hasText('Balance unavailable')).toBe(true);
    expect(getSecret('amx')).toBe('sk_amx_balancef1234567890abcdef1234567');
  });

  it('opens the browser to the verification_uri_complete URL', async () => {
    queueFetch([
      startResp(),
      pollResp({ status: 'expired' }),
    ]);
    const renderer = new CapturingRenderer();
    await runLogin(renderer as never, undefined, { pollIntervalOverrideMs: 1 });
    expect(renderer.hasText('https://bvrai.ca/cli-auth?code=XKMP-QR3V')).toBe(true);
  });

  it('sends device_code in the poll body', async () => {
    let pollBody = '';
    let n = 0;
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (n === 0) {
        n++;
        return startResp();
      }
      pollBody = init?.body as string;
      return pollResp({ status: 'expired' });
    }) as typeof globalThis.fetch;
    await runLogin(new CapturingRenderer() as never, undefined, { pollIntervalOverrideMs: 1 });
    expect(JSON.parse(pollBody)).toEqual({ device_code: 'dev-code-12345' });
  });
});

describe('printAlreadyAuthenticatedNotice (inside-V6 no-op)', () => {
  const envBefore = { ...process.env };
  afterEach(() => { process.env = { ...envBefore }; });

  it('extracts the email from a Firebase ID token when present', () => {
    // Build a synthetic JWT: header.payload.signature where payload claims
    // include an email. Only the payload is decoded; signature is unused.
    const payload = Buffer.from(JSON.stringify({ email: 'greg@bvrai.ca', uid: 'u1' }))
      .toString('base64')
      .replace(/=+$/, '');
    process.env.AUTOMAX_PROXY_TOKEN = `header.${payload}.signature`;
    const renderer = new CapturingRenderer();
    printAlreadyAuthenticatedNotice(renderer as never);
    expect(renderer.hasText('greg@bvrai.ca')).toBe(true);
    expect(renderer.hasText("`acv1` standalone")).toBe(true);
  });

  it('falls back to a generic line when the token has no email claim', () => {
    const payload = Buffer.from(JSON.stringify({ uid: 'u1' }))
      .toString('base64')
      .replace(/=+$/, '');
    process.env.AUTOMAX_PROXY_TOKEN = `header.${payload}.signature`;
    const renderer = new CapturingRenderer();
    printAlreadyAuthenticatedNotice(renderer as never);
    expect(renderer.hasText("via Automax")).toBe(true);
    expect(renderer.textAtLevel('info').some((t) => t.includes('@'))).toBe(false);
  });

  it('falls back to generic when the env var is malformed (not a JWT)', () => {
    process.env.AUTOMAX_PROXY_TOKEN = 'not-a-jwt';
    const renderer = new CapturingRenderer();
    printAlreadyAuthenticatedNotice(renderer as never);
    expect(renderer.hasText('via Automax')).toBe(true);
  });
});
