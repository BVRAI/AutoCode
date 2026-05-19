import type { CompletionRequest, CompletionResponse, LlmProvider, StreamEvent } from './types.js';
import { AnthropicProvider } from './providers/AnthropicProvider.js';
import { XaiProvider } from './providers/XaiProvider.js';
import { OpenAIProvider } from './providers/OpenAIProvider.js';
import { OpenRouterProvider } from './providers/OpenRouterProvider.js';
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

  async *completeStream(provider: ProviderName, req: CompletionRequest): AsyncIterable<StreamEvent> {
    const p = this.providerFor(provider);
    if (!p.completeStream) {
      throw new Error(`provider ${provider} does not support streaming`);
    }
    yield* p.completeStream(req);
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
    case 'xai':
      return new XaiProvider(auth);
    case 'openai':
      return new OpenAIProvider(auth);
    case 'openrouter':
      return new OpenRouterProvider(auth);
    case 'google':
      throw new Error('google (gemini) provider not yet implemented — deferred to a later phase');
    default:
      throw new Error(`provider not yet implemented: ${name}`);
  }
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (
    msg.includes('overloaded') ||
    msg.includes('rate limit') ||
    msg.includes('timeout') ||
    msg.includes('econnreset')
  ) {
    return true;
  }
  // Match "<provider> 5xx" or "<provider> 429" for any provider name
  return /^[a-z]+ (5\d\d|429)\b/.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
