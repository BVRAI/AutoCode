import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchProxyCatalog,
  validateCatalog,
  readCachedCatalog,
  writeCachedCatalog,
  loadCatalogForStartup,
  CATALOG_SCHEMA_VERSION,
  type FullCatalog,
} from '../../src/llm/CatalogClient.js';

const wellFormedCatalog: FullCatalog = {
  schema_version: CATALOG_SCHEMA_VERSION,
  fetched_at: '2026-05-25T00:00:00Z',
  run_id: 'r1',
  providers: {
    anthropic: {
      last_verified_at: '2026-05-25T00:00:00Z',
      models: [
        {
          id: 'claude-foo',
          input_price_per_million: 1,
          output_price_per_million: 2,
          status: 'active',
          last_verified_at: '2026-05-25T00:00:00Z',
          last_priced_at: '2026-05-25T00:00:00Z',
          supports_thinking: false,
          thinking_budget_default: null,
          max_output_tokens: 4096,
          context_window: 100000,
          vision: false,
          tools: true,
          supports_caching: false,
          max_cache_breakpoints: 0,
          cache_read_multiplier: 1.0,
          cache_write_multiplier: 1.0,
        },
      ],
    },
  },
};

describe('validateCatalog', () => {
  it('accepts a well-formed v1 catalog', () => {
    const out = validateCatalog(wellFormedCatalog);
    expect(out).not.toBeNull();
    expect(out?.providers.anthropic?.models[0]?.id).toBe('claude-foo');
  });

  it('rejects a payload with the wrong schema_version', () => {
    const bad = { ...wellFormedCatalog, schema_version: 2 };
    expect(validateCatalog(bad)).toBeNull();
  });

  it('rejects non-object payloads', () => {
    expect(validateCatalog(null)).toBeNull();
    expect(validateCatalog('a string')).toBeNull();
    expect(validateCatalog(42)).toBeNull();
    expect(validateCatalog(undefined)).toBeNull();
  });

  it('drops malformed model entries but keeps valid siblings', () => {
    const mixed = {
      schema_version: 1,
      fetched_at: '2026-05-25T00:00:00Z',
      run_id: 'r1',
      providers: {
        anthropic: {
          last_verified_at: '',
          models: [
            { id: 42, input_price_per_million: 1, output_price_per_million: 2, status: 'active' },
            { id: 'claude-foo', input_price_per_million: 1, output_price_per_million: 2, status: 'active' },
          ],
        },
      },
    };
    const out = validateCatalog(mixed);
    expect(out?.providers.anthropic?.models).toHaveLength(1);
    expect(out?.providers.anthropic?.models[0]?.id).toBe('claude-foo');
  });
});

describe('fetchProxyCatalog', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns parsed catalog on 200', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(wellFormedCatalog), { status: 200 }),
    ) as typeof globalThis.fetch;
    const out = await fetchProxyCatalog({ baseUrl: 'https://x', token: 't' });
    expect(out).not.toBeNull();
    expect(out?.providers.anthropic?.models[0]?.id).toBe('claude-foo');
  });

  it('returns null on non-2xx (e.g. 401)', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 401 }),
    ) as typeof globalThis.fetch;
    const out = await fetchProxyCatalog({ baseUrl: 'https://x', token: 'bad' });
    expect(out).toBeNull();
  });

  it('returns null on 503 catalog_not_available', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { type: 'catalog_not_available' } }), {
        status: 503,
      }),
    ) as typeof globalThis.fetch;
    const out = await fetchProxyCatalog({ baseUrl: 'https://x', token: 't' });
    expect(out).toBeNull();
  });

  it('returns null when the network throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof globalThis.fetch;
    const out = await fetchProxyCatalog({ baseUrl: 'https://x', token: 't' });
    expect(out).toBeNull();
  });

  it('returns null when the body is not JSON', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('<html>not json</html>', { status: 200 }),
    ) as typeof globalThis.fetch;
    const out = await fetchProxyCatalog({ baseUrl: 'https://x', token: 't' });
    expect(out).toBeNull();
  });

  it('strips a trailing slash from baseUrl', async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify(wellFormedCatalog), { status: 200 });
    }) as typeof globalThis.fetch;
    await fetchProxyCatalog({ baseUrl: 'https://x/', token: 't' });
    expect(seen[0]).toBe('https://x/v1/catalog');
  });

  it('sends Authorization: Bearer <token>', async () => {
    let observedAuth = '';
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      observedAuth = headers.get('authorization') ?? '';
      return new Response(JSON.stringify(wellFormedCatalog), { status: 200 });
    }) as typeof globalThis.fetch;
    await fetchProxyCatalog({ baseUrl: 'https://x', token: 'firebase-token' });
    expect(observedAuth).toBe('Bearer firebase-token');
  });
});

describe('cache + loadCatalogForStartup', () => {
  let tmp: string;
  let originalDataDir: string | undefined;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'autocode-catalog-test-'));
    originalDataDir = process.env.AUTOCODE_DATA_DIR;
    process.env.AUTOCODE_DATA_DIR = tmp;
  });
  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.AUTOCODE_DATA_DIR;
    else process.env.AUTOCODE_DATA_DIR = originalDataDir;
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes and reads a cached catalog round-trip', () => {
    writeCachedCatalog(wellFormedCatalog);
    const cached = readCachedCatalog();
    expect(cached).not.toBeNull();
    expect(cached?.catalog.providers.anthropic?.models[0]?.id).toBe('claude-foo');
    // On Windows, mtime precision can lag wall-clock by a few ms — assert
    // the read happened recently (within a generous bound) rather than
    // non-negative.
    expect(Math.abs(cached?.ageMs ?? Number.POSITIVE_INFINITY)).toBeLessThan(5000);
  });

  it('readCachedCatalog returns null when no cache file exists', () => {
    expect(readCachedCatalog()).toBeNull();
  });

  it('loadCatalogForStartup returns cache when fresh, signals refresh', async () => {
    writeCachedCatalog(wellFormedCatalog);
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network should not be called when cache is fresh');
    }) as typeof globalThis.fetch;
    const result = await loadCatalogForStartup({ baseUrl: 'https://x', token: 't' });
    expect(result.source).toBe('cache');
    expect(result.refreshInBackground).toBe(true);
    expect(result.catalog).not.toBeNull();
  });

  it('loadCatalogForStartup fetches when no cache exists', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(wellFormedCatalog), { status: 200 }),
    ) as typeof globalThis.fetch;
    const result = await loadCatalogForStartup({ baseUrl: 'https://x', token: 't' });
    expect(result.source).toBe('fresh');
    expect(result.catalog).not.toBeNull();
    // And it should have written the cache for next time.
    expect(readCachedCatalog()).not.toBeNull();
  });

  it('loadCatalogForStartup returns none when fetch fails and no cache exists', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as typeof globalThis.fetch;
    const result = await loadCatalogForStartup({ baseUrl: 'https://x', token: 't' });
    expect(result.source).toBe('none');
    expect(result.catalog).toBeNull();
  });
});
