import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { XaiProvider } from '../../src/llm/providers/XaiProvider.js';
import type { CompletionRequest } from '../../src/llm/types.js';
import type { AuthMode } from '../../src/auth/AuthResolver.js';

const sampleResp = {
  id: 'r',
  model: 'grok-code-fast-1',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const req: CompletionRequest = {
  model: 'grok-code-fast-1',
  system: 'autocode',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
};

describe('XaiProvider', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(sampleResp), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('uses BYOK base URL and bearer when auth is byok', async () => {
    const auth: AuthMode = { kind: 'byok', apiKey: 'xai-test-key' };
    const p = new XaiProvider(auth);
    await p.complete(req);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer xai-test-key');
    expect(headers['content-type']).toBe('application/json');
  });

  it('uses proxy base URL and Firebase bearer when auth is automax', async () => {
    const auth: AuthMode = {
      kind: 'automax',
      token: 'firebase-id-token',
      baseOverride: 'https://automax-proxy.fly.dev/v1/xai',
    };
    const p = new XaiProvider(auth);
    await p.complete(req);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://automax-proxy.fly.dev/v1/xai/chat/completions');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer firebase-id-token');
  });

  it('throws when auth is missing', async () => {
    const p = new XaiProvider({ kind: 'missing', provider: 'xai' });
    await expect(p.complete(req)).rejects.toThrow(/xai credentials missing/);
  });

  it('throws on non-200 with body excerpt', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('rate limited', { status: 429 }),
    );
    const p = new XaiProvider({ kind: 'byok', apiKey: 'k' });
    await expect(p.complete(req)).rejects.toThrow(/xai 429.*rate limited/);
  });
});
