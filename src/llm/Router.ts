import type { CompletionRequest, CompletionResponse, LlmProvider, StreamEvent } from './types.js';
import { AnthropicProvider } from './providers/AnthropicProvider.js';
import { XaiProvider } from './providers/XaiProvider.js';
import { OpenAIProvider } from './providers/OpenAIProvider.js';
import { OpenRouterProvider } from './providers/OpenRouterProvider.js';
import { GeminiProvider } from './providers/GeminiProvider.js';
import { FakeProvider } from './providers/FakeProvider.js';
import { AuthResolver } from '../auth/AuthResolver.js';

export type ProviderName = 'anthropic' | 'openai' | 'google' | 'xai' | 'openrouter';

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 800;

// Request watchdog. A provider that stops sending — a half-open socket, a
// stalled gateway — must fail the request (retryable before the first
// event) instead of hanging the turn forever; the Phase 5 battery lost a
// 15-minute Aider task to exactly that silence. Thinking models can be quiet
// for a while, so the ceilings are generous and env-tunable.
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const FIRST_EVENT_TIMEOUT_MS = envMs('AUTOCODE_LLM_FIRST_EVENT_MS', 120_000);
const IDLE_TIMEOUT_MS = envMs('AUTOCODE_LLM_IDLE_MS', 180_000);
const COMPLETE_TIMEOUT_MS = envMs('AUTOCODE_LLM_COMPLETE_MS', 600_000);

class Watchdog {
  readonly signal: AbortSignal;
  fired = false;
  lastMs = 0;
  private readonly ctrl = new AbortController();
  private timer: NodeJS.Timeout | null = null;

  constructor(parent?: AbortSignal) {
    this.signal = parent ? AbortSignal.any([parent, this.ctrl.signal]) : this.ctrl.signal;
  }

  arm(ms: number): void {
    this.disarm();
    this.lastMs = ms;
    this.timer = setTimeout(() => {
      this.fired = true;
      this.ctrl.abort();
    }, ms);
    this.timer.unref?.();
  }

  disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The error to surface: the watchdog's own message when it fired, else the original. */
  explain(provider: string, e: unknown, stage: string): unknown {
    if (!this.fired) return e;
    return new Error(`${provider} timeout: no ${stage} for ${Math.round(this.lastMs / 1000)}s`);
  }
}

export class LlmRouter {
  private readonly cache = new Map<ProviderName, LlmProvider>();

  constructor(private readonly auth = new AuthResolver()) {}

  async complete(provider: ProviderName, req: CompletionRequest): Promise<CompletionResponse> {
    const p = this.providerFor(provider);
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const dog = new Watchdog(req.signal);
      try {
        dog.arm(COMPLETE_TIMEOUT_MS);
        return await p.complete({ ...req, signal: dog.signal });
      } catch (raw) {
        const e = dog.explain(provider, raw, 'response');
        lastErr = e;
        if (req.signal?.aborted === true || !isRetryable(e) || attempt === MAX_RETRIES - 1) throw e;
        await sleep(BACKOFF_BASE_MS * 2 ** attempt);
      } finally {
        dog.disarm();
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async *completeStream(provider: ProviderName, req: CompletionRequest): AsyncIterable<StreamEvent> {
    const p = this.providerFor(provider);
    if (!p.completeStream) {
      throw new Error(`provider ${provider} does not support streaming`);
    }
    // Same retry/backoff as complete(), but ONLY for failures raised before
    // the first event is delivered (connect errors, 429/5xx on the POST).
    // Once events have flowed, a mid-stream error is NOT retried — replaying
    // a partial stream would duplicate deltas the consumer already rendered.
    for (let attempt = 0; ; attempt++) {
      let yielded = false;
      const dog = new Watchdog(req.signal);
      try {
        dog.arm(FIRST_EVENT_TIMEOUT_MS);
        for await (const evt of p.completeStream({ ...req, signal: dog.signal })) {
          dog.arm(IDLE_TIMEOUT_MS);
          yielded = true;
          yield evt;
        }
        return;
      } catch (raw) {
        const e = dog.explain(provider, raw, yielded ? 'stream data' : 'response');
        if (
          yielded ||
          req.signal?.aborted === true ||
          !isRetryable(e) ||
          attempt >= MAX_RETRIES - 1
        ) {
          throw e;
        }
        await sleep(BACKOFF_BASE_MS * 2 ** attempt);
      } finally {
        dog.disarm();
      }
    }
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
  // End-to-end tests: AUTOCODE_FAKE_LLM=<script.json> replaces every provider
  // with the scripted one, so a whole session runs with no network or keys.
  const fake = FakeProvider.fromEnv();
  if (fake) return fake;
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
      return new GeminiProvider(auth);
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
