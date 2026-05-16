import { ConfigStore } from './ConfigStore.js';

export type AuthMode =
  | { kind: 'automax'; token: string; baseOverride: string }
  | { kind: 'byok'; apiKey: string }
  | { kind: 'missing'; provider: string };

const AUTOMAX_PROXY_BASE = 'https://automax-proxy.fly.dev';

export class AuthResolver {
  constructor(private readonly config = new ConfigStore()) {}

  resolve(provider: string): AuthMode {
    const proxyToken = process.env.AUTOMAX_PROXY_TOKEN;
    if (proxyToken && proxyToken.length > 0) {
      return {
        kind: 'automax',
        token: proxyToken,
        baseOverride: `${AUTOMAX_PROXY_BASE}/v1/${provider}`,
      };
    }
    const key = this.config.getApiKey(provider as 'anthropic');
    if (key && key.length > 0) {
      return { kind: 'byok', apiKey: key };
    }
    return { kind: 'missing', provider };
  }
}
