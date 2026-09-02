import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthMode } from '../../src/auth/AuthResolver.js';
import {
  runProxyStatus,
  type ProxyStatusOptions,
} from '../../src/repl/ProxyStatusCommand.js';

class CapturingRenderer {
  readonly out: Array<{ level: 'info' | 'dim' | 'warn' | 'error'; text: string }> = [];

  info(text: string): void { this.out.push({ level: 'info', text }); }
  dim(text: string): void { this.out.push({ level: 'dim', text }); }
  warn(text: string): void { this.out.push({ level: 'warn', text }); }
  error(text: string): void { this.out.push({ level: 'error', text }); }

  allText(): string {
    return this.out.map((entry) => entry.text).join('\n');
  }
}

function optionsFor(
  auth: AuthMode,
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<ProxyStatusOptions> = {},
): ProxyStatusOptions {
  return {
    authResolver: { resolve: () => auth },
    fetchImpl,
    ...overrides,
  };
}

describe('runProxyStatus', () => {
  const originalProxyUrl = process.env.AUTOMAX_PROXY_URL;

  beforeEach(() => {
    delete process.env.AUTOMAX_PROXY_URL;
  });

  afterEach(() => {
    if (originalProxyUrl === undefined) delete process.env.AUTOMAX_PROXY_URL;
    else process.env.AUTOMAX_PROXY_URL = originalProxyUrl;
    vi.restoreAllMocks();
  });

  it('reports direct BYOK routing without making a network request', async () => {
    const renderer = new CapturingRenderer();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;

    const status = await runProxyStatus(
      renderer as never,
      'anthropic',
      optionsFor({ kind: 'byok', apiKey: 'provider-secret' }, fetchImpl),
    );

    expect(status).toEqual({
      kind: 'not-configured',
      authKind: 'byok',
      endpoint: 'https://automax-proxy.fly.dev',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(renderer.allText()).toContain('Not connected');
    expect(renderer.allText()).toContain('provider API key directly');
    expect(renderer.allText()).not.toContain('provider-secret');
  });

  it('reports a verified Automax-managed connection and honors the proxy URL override', async () => {
    process.env.AUTOMAX_PROXY_URL = 'https://proxy.example.test/';
    const renderer = new CapturingRenderer();
    let observedUrl = '';
    let observedAuthorization = '';
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      observedUrl = String(url);
      observedAuthorization = new Headers(init?.headers).get('authorization') ?? '';
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;

    const status = await runProxyStatus(
      renderer as never,
      'xai',
      optionsFor(
        {
          kind: 'automax',
          token: 'firebase-secret-token',
          baseOverride: 'https://proxy.example.test/v1/xai',
        },
        fetchImpl,
      ),
    );

    expect(status).toEqual({
      kind: 'connected',
      authKind: 'automax',
      endpoint: 'https://proxy.example.test',
    });
    expect(observedUrl).toBe('https://proxy.example.test/v1/usage/me');
    expect(observedAuthorization).toBe('Bearer firebase-secret-token');
    expect(renderer.allText()).toContain('Connected');
    expect(renderer.allText()).toContain('Automax-managed session');
    expect(renderer.allText()).not.toContain('firebase-secret-token');
  });

  it('describes a standalone BVRAI login on a successful probe', async () => {
    const renderer = new CapturingRenderer();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch;

    const status = await runProxyStatus(
      renderer as never,
      'openai',
      optionsFor(
        {
          kind: 'amxkey',
          token: 'sk_amx_secret',
          baseOverride: 'https://automax-proxy.fly.dev/v1/openai',
        },
        fetchImpl,
      ),
    );

    expect(status.kind).toBe('connected');
    expect(renderer.allText()).toContain('saved BVRAI login');
    expect(renderer.allText()).not.toContain('sk_amx_secret');
  });

  it('reports rejected credentials and suggests logging in again', async () => {
    const renderer = new CapturingRenderer();
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 })) as typeof globalThis.fetch;

    const status = await runProxyStatus(
      renderer as never,
      'openai',
      optionsFor(
        {
          kind: 'amxkey',
          token: 'sk_amx_revoked',
          baseOverride: 'https://automax-proxy.fly.dev/v1/openai',
        },
        fetchImpl,
      ),
    );

    expect(status.kind).toBe('rejected');
    expect(renderer.allText()).toContain('credentials rejected: HTTP 401');
    expect(renderer.allText()).toContain('/login');
    expect(renderer.allText()).not.toContain('sk_amx_revoked');
  });

  it('distinguishes a reachable proxy error from rejected authentication', async () => {
    const renderer = new CapturingRenderer();
    const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 503 })) as typeof globalThis.fetch;

    const status = await runProxyStatus(
      renderer as never,
      'xai',
      optionsFor(
        {
          kind: 'automax',
          token: 'session-token',
          baseOverride: 'https://automax-proxy.fly.dev/v1/xai',
        },
        fetchImpl,
      ),
    );

    expect(status).toMatchObject({ kind: 'unavailable', detail: 'HTTP 503' });
    expect(renderer.allText()).toContain('could not be verified (HTTP 503)');
  });

  it('times out a stalled connection check', async () => {
    const renderer = new CapturingRenderer();
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
    ) as typeof globalThis.fetch;

    const status = await runProxyStatus(
      renderer as never,
      'xai',
      optionsFor(
        {
          kind: 'automax',
          token: 'session-token',
          baseOverride: 'https://automax-proxy.fly.dev/v1/xai',
        },
        fetchImpl,
        { timeoutMs: 5 },
      ),
    );

    expect(status).toMatchObject({ kind: 'unavailable', detail: 'timed out after 5 ms' });
    expect(renderer.allText()).toContain('timed out after 5 ms');
  });
});
