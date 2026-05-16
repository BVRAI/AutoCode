import type { CompletionRequest, CompletionResponse, LlmProvider } from './types.js';
import { AnthropicProvider } from './providers/AnthropicProvider.js';
import { AuthResolver } from '../auth/AuthResolver.js';

export type ProviderName = 'anthropic' | 'openai' | 'google' | 'xai' | 'openrouter';

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 800;

export class LlmRouter {
  private readonly cache = new Map<ProviderName, LlmProvider>();

  constructor(private readonly auth = new AuthResolver()) {}

  async complete(provider: ProviderName, req: CompletionRequest): Promise<CompletionResponse> {
    const p = this.providerFor(provider);
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await p.complete(req);
      } catch (e) {
        lastErr = e;
        if (!isRetryable(e) || attempt === MAX_RETRIES - 1) throw e;
        await sleep(BACKOFF_BASE_MS * 2 ** attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private providerFor(name: ProviderName): LlmProvider {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const resolved = this.auth.resolve(name);
    const created = construct(name, resolved);
    this.cache.set(name, created);
    return created;
  }
}

function construct(name: ProviderName, auth: ReturnType<AuthResolver['resolve']>): LlmProvider {
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider(auth);
    default:
      throw new Error(`provider not yet implemented: ${name}`);
  }
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('overloaded') ||
    msg.includes('rate limit') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.startsWith('anthropic 5') ||
    msg.startsWith('anthropic 429')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
