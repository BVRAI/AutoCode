import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthResolver } from '../../src/auth/AuthResolver.js';

describe('AuthResolver', () => {
  const before = { ...process.env };

  beforeEach(() => {
    delete process.env.AUTOMAX_PROXY_TOKEN;
    delete process.env.AUTOMAX_PROXY_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.XAI_API_KEY;
  });
  afterEach(() => {
    process.env = { ...before };
  });

  it('returns automax mode with default URL when AUTOMAX_PROXY_TOKEN is set', () => {
    process.env.AUTOMAX_PROXY_TOKEN = 'firebase-token';
    const r = new AuthResolver().resolve('xai');
    expect(r).toEqual({
      kind: 'automax',
      token: 'firebase-token',
      baseOverride: 'https://automax-proxy.fly.dev/v1/xai',
    });
  });

  it('honors AUTOMAX_PROXY_URL override', () => {
    process.env.AUTOMAX_PROXY_TOKEN = 'firebase-token';
    process.env.AUTOMAX_PROXY_URL = 'https://my-proxy.example.com';
    const r = new AuthResolver().resolve('anthropic');
    expect(r).toMatchObject({
      kind: 'automax',
      baseOverride: 'https://my-proxy.example.com/v1/anthropic',
    });
  });

  it('strips trailing slash from AUTOMAX_PROXY_URL', () => {
    process.env.AUTOMAX_PROXY_TOKEN = 'firebase-token';
    process.env.AUTOMAX_PROXY_URL = 'https://my-proxy.example.com/';
    const r = new AuthResolver().resolve('xai');
    expect(r).toMatchObject({
      baseOverride: 'https://my-proxy.example.com/v1/xai',
    });
  });

  it('returns byok mode when env API key is set', () => {
    process.env.XAI_API_KEY = 'xai-key';
    const r = new AuthResolver().resolve('xai');
    expect(r).toEqual({ kind: 'byok', apiKey: 'xai-key' });
  });

  it('proxy token wins over BYOK when both are set', () => {
    process.env.AUTOMAX_PROXY_TOKEN = 'firebase-token';
    process.env.XAI_API_KEY = 'xai-key';
    const r = new AuthResolver().resolve('xai');
    expect(r.kind).toBe('automax');
  });

  it('returns missing when no credentials present', () => {
    const r = new AuthResolver().resolve('xai');
    expect(r).toEqual({ kind: 'missing', provider: 'xai' });
  });
});
