// Optional host accounting. This scope never participates in model context,
// agent decisions, budgets, or retry policy.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { CompletionResponse } from './types.js';
import { estimateCost } from '../util/pricing.js';

export interface UsageReceipt {
  submissionId: string;
  runId: string;
  callId: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  usageAvailable: boolean;
  pricingAvailable: boolean;
  costUsd: number | null;
  complete: boolean;
}

type Notify = (method: string, params: Record<string, unknown>) => void;
const scope = new AsyncLocalStorage<SubmissionAccounting>();

export function currentSubmissionId(): string | undefined {
  const current = scope.getStore();
  return current?.isOpen ? current.submissionId : undefined;
}

export function markAccountingIncomplete(): void {
  scope.getStore()?.markIncomplete();
}

export class SubmissionAccounting {
  readonly runId = randomUUID();
  isOpen = false;
  private complete = true;
  private readonly calls = new Set<string>();

  constructor(readonly submissionId: string, private readonly notify: Notify) {}

  private emit(method: string, params: Record<string, unknown>): void {
    try { this.notify(method, params); } catch { /* Accounting cannot fail a run. */ }
  }

  markIncomplete(): void { this.complete = false; }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.isOpen = true;
    this.emit('accounting.started', { submissionId: this.submissionId, runId: this.runId });
    try {
      return await scope.run(this, work);
    } catch (error) {
      this.complete = false;
      throw error;
    } finally {
      this.isOpen = false;
      this.emit('accounting.completed', {
        submissionId: this.submissionId, runId: this.runId, complete: this.complete && this.calls.size === 0,
      });
    }
  }

  beginCall(provider: string, requestedModel: string): (response?: CompletionResponse, finished?: boolean) => void {
    const callId = randomUUID();
    this.calls.add(callId);
    let recorded = false;
    return (response, finished = false) => {
      if (recorded) return;
      recorded = true;
      this.calls.delete(callId);
      // Detached background work must never charge a subsequent submission.
      if (!this.isOpen) return;
      const model = response?.accountingModel || response?.model || requestedModel;
      const usage = response?.accountingUsage ?? response?.usage;
      const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
      const usageAvailable = !!usage && response?.usageAvailable !== false &&
        valid(usage.inputTokens) && valid(usage.outputTokens) &&
        (usage.cacheReadTokens === undefined || valid(usage.cacheReadTokens)) &&
        (usage.cacheWriteTokens === undefined || valid(usage.cacheWriteTokens));
      const priced = usageAvailable ? estimateCost(usage!, provider, model) : { cost: 0, rate: null };
      const rate = priced.rate;
      // Catalogs currently also use 0/0 as "pricing pending". They carry no
      // explicit free-model provenance into ModelRate, so treat those rates
      // conservatively here without changing the engine's budget estimator.
      const hasBasePrice = !!rate && valid(rate.inputPerM) && valid(rate.outputPerM) &&
        (rate.inputPerM > 0 || rate.outputPerM > 0);
      const pricingAvailable = hasBasePrice &&
        ((usage?.cacheReadTokens ?? 0) === 0 || valid(rate.cacheReadPerM)) &&
        ((usage?.cacheWriteTokens ?? 0) === 0 || valid(rate.cacheWritePerM));
      // A zero subtotal is meaningful only if at least one used category was
      // actually priced (or all reported usage was zero). Cached-only usage
      // with an unknown cache rate must not masquerade as a free call.
      const hasPricedUsage = hasBasePrice && !!usage && (
        usage.inputTokens > 0 || usage.outputTokens > 0 ||
        ((usage.cacheReadTokens ?? 0) > 0 && valid(rate.cacheReadPerM)) ||
        ((usage.cacheWriteTokens ?? 0) > 0 && valid(rate.cacheWritePerM)) ||
        (usage.inputTokens === 0 && usage.outputTokens === 0 &&
          (usage.cacheReadTokens ?? 0) === 0 && (usage.cacheWriteTokens ?? 0) === 0));
      const costUsd = hasPricedUsage && valid(priced.cost) ? priced.cost : null;
      const complete = finished && response?.accountingComplete !== false && response?.stopReason !== 'error' &&
        usageAvailable && pricingAvailable;
      if (!complete) this.complete = false;
      const receipt: UsageReceipt = {
        submissionId: this.submissionId, runId: this.runId, callId, provider, model,
        inputTokens: usageAvailable ? usage!.inputTokens : null,
        outputTokens: usageAvailable ? usage!.outputTokens : null,
        cacheReadTokens: usageAvailable ? usage!.cacheReadTokens ?? null : null,
        cacheWriteTokens: usageAvailable ? usage!.cacheWriteTokens ?? null : null,
        usageAvailable, pricingAvailable, costUsd, complete,
      };
      this.emit('accounting.receipt', { ...receipt });
    };
  }
}

export function beginAccountingCall(provider: string, model: string): ReturnType<SubmissionAccounting['beginCall']> {
  const current = scope.getStore();
  return current?.isOpen ? current.beginCall(provider, model) : () => {};
}
