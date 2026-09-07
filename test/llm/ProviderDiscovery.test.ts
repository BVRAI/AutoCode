import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  capRate,
  discoverModels,
  discoveryState,
  isChatModelId,
  openRouterId,
  oracleFrom,
  parseProviderModels,
  resetDiscovery,
  sortModelIds,
  toModelInfos,
} from '../../src/llm/ProviderDiscovery.js';
import { discoveredProviders, getKnownModels, labelFor, modelCatalogDetail } from '../../src/llm/models.js';
import { rateFor } from '../../src/util/pricing.js';

// Fixtures follow the shapes the live endpoints returned on 2026-09-07.
const XAI = {
  models: [
    { id: 'grok-4.6', prompt_text_token_price: 20000, cached_prompt_text_token_price: 5000, completion_text_token_price: 60000, input_modalities: ['text', 'image'], aliases: [] },
    { id: 'grok-4.20-0309-reasoning', prompt_text_token_price: 12500, cached_prompt_text_token_price: 2000, completion_text_token_price: 25000, input_modalities: ['text', 'image'], aliases: ['grok-4.20-reasoning-latest', 'grok-4.20', 'grok-4.20-reasoning'] },
    { id: 'grok-build-0.1', prompt_text_token_price: 10000, cached_prompt_text_token_price: 2000, completion_text_token_price: 20000, input_modalities: ['text', 'image'], aliases: ['grok-code-fast-1', 'grok-code-fast', 'grok-code-fast-1-0825'] },
  ],
};
const OPENAI = {
  data: [
    { id: 'gpt-6-astra', object: 'model', shutdown_date: null },
    { id: 'gpt-5.4', shutdown_date: null },
    { id: 'gpt-5.4-2026-03-05', shutdown_date: null },
    { id: 'gpt-5-chat-latest' },
    { id: 'gpt-4o-mini-tts' },
    { id: 'text-embedding-3-large' },
    { id: 'gpt-4-turbo', shutdown_date: '2026-01-01' },
    { id: 'gpt-4.1', shutdown_date: '2027-01-01' },
    { id: 'gpt-9-nova' },
    { id: 'gpt-4' },
    { id: 'gpt-4-0613' },
  ],
};
const ANTHROPIC = {
  data: [
    { id: 'claude-opus-4-7-20251001', display_name: 'Claude Opus 4.7' },
    { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' },
    { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' },
  ],
};
const GOOGLE = {
  models: [
    { name: 'models/gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576 },
    { name: 'models/embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
  ],
};
const OPENROUTER = {
  data: [
    { id: 'openai/gpt-9-nova', name: 'OpenAI: GPT-9 Nova', pricing: { prompt: '0.000007', completion: '0.000021', input_cache_read: '0.0000007' }, context_length: 1000000, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['reasoning'] },
    { id: 'openai/gpt-9-nova:batch', pricing: { prompt: '0.0000035', completion: '0.0000105' } },
    { id: 'anthropic/claude-opus-4.7', pricing: { prompt: '0.000005', completion: '0.000025' } },
    { id: 'openai/gpt-4', pricing: { prompt: '0.00003', completion: '0.00006' } },
  ],
};
const NOW = Date.parse('2026-09-07T00:00:00Z');

describe('parseProviderModels', () => {
  it('xai: prices in 1/10,000 USD per million, known aliases as the rows, renamed aliases as extra rows', () => {
    const models = parseProviderModels('xai', XAI);
    expect(models.map((m) => m.id)).toEqual(['grok-4.6', 'grok-4.20', 'grok-build-0.1', 'grok-code-fast-1']);
    expect(models[0]).toMatchObject({ inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.5, vision: true });
    expect(models[1]).toMatchObject({ aliasOf: 'grok-4.20-0309-reasoning', inputPerM: 1.25 });
    // Without a bundled-known alias the undated alias names the row.
    const nonReasoning = parseProviderModels('xai', {
      models: [{ id: 'grok-4.20-0309-non-reasoning', prompt_text_token_price: 12500, completion_text_token_price: 25000, aliases: ['grok-4.20-non-reasoning', 'grok-4.20-non-reasoning-latest'] }],
    });
    expect(nonReasoning.map((m) => m.id)).toEqual(['grok-4.20-non-reasoning']);
    expect(models[2]!.aliasOf).toBeUndefined();
    expect(models[3]).toMatchObject({ aliasOf: 'grok-build-0.1', inputPerM: 1, outputPerM: 2, cacheReadPerM: 0.2 });
  });

  it('openai: drops non-chat ids, dated twins and models past their shutdown date', () => {
    expect(parseProviderModels('openai', OPENAI, NOW).map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.4', 'gpt-4.1', 'gpt-9-nova', 'gpt-4']);
  });

  it('anthropic: keeps display names and prefers the undated id over its dated twin', () => {
    const models = parseProviderModels('anthropic', ANTHROPIC);
    expect(models).toEqual([
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
    ]);
  });

  it('google: generateContent models only, with context window and thinking flag', () => {
    const models = parseProviderModels('google', GOOGLE);
    expect(models).toEqual([{ id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', contextWindow: 1048576, supportsThinking: true }]);
  });

  it('openrouter: per-token strings become per-million prices; batch variants are skipped', () => {
    const models = parseProviderModels('openrouter', OPENROUTER);
    expect(models.map((m) => m.id)).toEqual(['openai/gpt-9-nova', 'anthropic/claude-opus-4.7', 'openai/gpt-4']);
    expect(models[0]).toMatchObject({ inputPerM: 7, outputPerM: 21, cacheReadPerM: 0.7, contextWindow: 1000000, vision: true, supportsThinking: true });
  });

  it('isChatModelId keeps chat ids and rejects speech, image, search and batch variants', () => {
    expect(isChatModelId('openai', 'o3')).toBe(true);
    expect(isChatModelId('openai', 'gpt-4o-search-preview')).toBe(false);
    expect(isChatModelId('openai', 'gpt-realtime-2')).toBe(false);
    expect(isChatModelId('xai', 'grok-2-image-1212')).toBe(false);
    expect(isChatModelId('anthropic', 'claude-fable-5-1')).toBe(true);
  });
});

describe('sorting, ids and labels', () => {
  it('sorts newest version first, then shorter ids', () => {
    const sorted = sortModelIds([{ id: 'gpt-4.1' }, { id: 'o3' }, { id: 'gpt-6-astra' }, { id: 'gpt-5.6-terra' }, { id: 'gpt-5.6-sol' }]);
    expect(sorted.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-4.1', 'o3']);
  });

  it('maps provider ids onto OpenRouter ids', () => {
    expect(openRouterId('anthropic', 'claude-opus-4-7-20251001')).toBe('anthropic/claude-opus-4.7');
    expect(openRouterId('anthropic', 'claude-fable-5-1')).toBe('anthropic/claude-fable-5.1');
    expect(openRouterId('anthropic', 'claude-opus-5')).toBe('anthropic/claude-opus-5');
    expect(openRouterId('xai', 'grok-4.6')).toBe('x-ai/grok-4.6');
    expect(openRouterId('openrouter', 'x')).toBeNull();
  });

  it('labelFor matches families at a boundary only and reports the matched key', () => {
    expect(labelFor('gpt-5.3-codex')).toEqual({ label: 'gpt-5.3-codex' });
    expect(labelFor('gpt-5.1-codex').key).toBe('gpt-5.1');
    expect(labelFor('claude-opus-4-7-20251001')).toMatchObject({ label: 'Claude Opus 4.7', key: 'claude-opus-4-7' });
    expect(labelFor('grok-4.20').key).toBe('grok-4.20');
  });
});

describe('toModelInfos', () => {
  it('prices: provider first, then bundled family, then the oracle, then a flagged cap', () => {
    const oracle = oracleFrom(parseProviderModels('openrouter', OPENROUTER));
    const xai = toModelInfos('xai', parseProviderModels('xai', XAI));
    expect(xai.infos[0]).toMatchObject({ model: 'grok-4.6', label: 'Grok 4.6', inputPerM: 2, outputPerM: 6, notes: 'frontier' });
    expect(xai.infos[1]).toMatchObject({ model: 'grok-4.20', label: 'Grok 4.20', notes: 'mid-tier · alias of grok-4.20-0309-reasoning' });
    expect(xai.infos[2]).toMatchObject({ model: 'grok-build-0.1', label: 'Grok Build 0.1' });
    expect(xai.infos[3]).toMatchObject({ model: 'grok-code-fast-1', label: 'Grok Code Fast 1', notes: 'alias of grok-build-0.1 (current default)' });
    expect(xai.rates['grok-4.20-0309-reasoning']?.inputPerM).toBe(1.25);
    expect(xai.unpriced).toEqual([]);

    const openai = toModelInfos('openai', parseProviderModels('openai', OPENAI, NOW), oracle);
    const byId = new Map(openai.infos.map((m) => [m.model, m]));
    expect(byId.get('gpt-5.4')).toMatchObject({ inputPerM: 2.5, outputPerM: 15, label: 'GPT-5.4' });
    expect(byId.get('gpt-9-nova')).toMatchObject({ inputPerM: 7, outputPerM: 21, cacheReadPerM: 0.7, label: 'gpt-9-nova' });
    expect(byId.get('gpt-9-nova')!.priceUnknown).toBeUndefined();
    expect(openai.unpriced).toEqual([]);

    const noOracle = toModelInfos('openai', [{ id: 'gpt-9-nova' }]);
    const cap = capRate('openai');
    expect(noOracle.infos[0]).toMatchObject({ priceUnknown: true, inputPerM: cap.inputPerM, outputPerM: cap.outputPerM });
    expect(noOracle.infos[0]!.notes).toBe(`billed as $${cap.inputPerM}/$${cap.outputPerM} for the cost cap`);
    expect(noOracle.unpriced).toEqual(['gpt-9-nova']);
  });

  it('uses the provider display name when the id is not a known family', () => {
    const anthropic = toModelInfos('anthropic', parseProviderModels('anthropic', ANTHROPIC));
    expect(anthropic.infos.map((m) => m.label)).toEqual(['Claude Opus 4.7', 'Claude Fable 5.1']);
    expect(anthropic.infos[1]!.supportsThinking).toBe(true);
  });
});

describe('discoverModels', () => {
  let tmp: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'autocode-discovery-test-'));
    originalDataDir = process.env.AUTOCODE_DATA_DIR;
    process.env.AUTOCODE_DATA_DIR = tmp;
    resetDiscovery();
  });

  afterEach(() => {
    resetDiscovery();
    if (originalDataDir === undefined) delete process.env.AUTOCODE_DATA_DIR;
    else process.env.AUTOCODE_DATA_DIR = originalDataDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  function fakeFetch(bodies: Record<string, unknown>, log: Array<{ url: string; headers: Record<string, string> }>): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      log.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const hit = Object.entries(bodies).find(([prefix]) => url.startsWith(prefix));
      if (!hit) throw new Error('network down');
      return new Response(JSON.stringify(hit[1]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }

  const keyFor = (provider: string): string | null => (provider === 'xai' ? 'k-xai' : provider === 'openai' ? 'k-openai' : null);
  const BODIES = {
    'https://api.x.ai/': XAI,
    'https://api.openai.com/': OPENAI,
    'https://openrouter.ai/': OPENROUTER,
  };

  it('installs live rows for keyed providers, caches the lists and prices unknown ids through OpenRouter', async () => {
    const log: Array<{ url: string; headers: Record<string, string> }> = [];
    const report = await discoverModels({ keyFor, fetchImpl: fakeFetch(BODIES, log) });
    expect(report.providers.map((p) => `${p.provider}:${p.source}:${p.count}`)).toEqual([
      'anthropic:no-key:0',
      'openai:fresh:5',
      'xai:fresh:4',
      'google:no-key:0',
      'openrouter:no-key:0',
    ]);
    expect(report.unpriced).toEqual([]);
    expect(discoveryState()).toBe('done');
    expect(discoveredProviders().sort()).toEqual(['openai', 'xai']);
    expect(modelCatalogDetail()).toBe('live from openai, xai · bundled for the rest');

    // The oracle call is public: no authorization header.
    const oracleCall = log.find((c) => c.url.startsWith('https://openrouter.ai/'));
    expect(oracleCall).toBeDefined();
    expect(oracleCall!.headers['authorization']).toBeUndefined();
    for (const p of ['xai', 'openai', 'openrouter']) expect(existsSync(join(tmp, 'provider-models', `${p}.json`))).toBe(true);

    const known = getKnownModels();
    const providersInOrder = [...new Set(known.map((m) => m.provider))];
    expect(providersInOrder).toEqual(['anthropic', 'xai', 'openai', 'openrouter']);
    expect(known.filter((m) => m.provider === 'xai').map((m) => m.model)).toEqual(['grok-4.6', 'grok-4.20', 'grok-code-fast-1', 'grok-build-0.1']);
    expect(known.find((m) => m.provider === 'anthropic')!.label).toBe('Claude Fable 5.1');
    expect(known.filter((m) => m.provider === 'openai')[0]!.model).toBe('gpt-9-nova');

    expect(rateFor('xai', 'grok-code-fast-1')).toMatchObject({ inputPerM: 1, outputPerM: 2 });
    expect(rateFor('xai', 'grok-4.20-0309-reasoning')?.inputPerM).toBe(1.25);
    expect(rateFor('openai', 'gpt-9-nova')).toMatchObject({ inputPerM: 7, outputPerM: 21 });

    // A second call without force is the same run.
    const again = await discoverModels({ keyFor, fetchImpl: fakeFetch(BODIES, log) });
    expect(again).toBe(report);
    expect(log.filter((c) => c.url.startsWith('https://api.x.ai/')).length).toBe(1);
  });

  it('a forced refresh that cannot reach the network keeps the cached lists', async () => {
    const log: Array<{ url: string; headers: Record<string, string> }> = [];
    await discoverModels({ keyFor, fetchImpl: fakeFetch(BODIES, log) });
    const report = await discoverModels({ keyFor, force: true, fetchImpl: fakeFetch({}, log) });
    expect(report.providers.find((p) => p.provider === 'xai')).toMatchObject({ source: 'cache', count: 4 });
    expect(getKnownModels().filter((m) => m.provider === 'xai')).toHaveLength(4);
  });

  it('with no cache and no network the bundled rows stay', async () => {
    const log: Array<{ url: string; headers: Record<string, string> }> = [];
    const report = await discoverModels({ keyFor, fetchImpl: fakeFetch({}, log) });
    expect(report.providers.find((p) => p.provider === 'xai')).toMatchObject({ source: 'failed', count: 0 });
    expect(discoveredProviders()).toEqual([]);
    expect(getKnownModels().find((m) => m.provider === 'xai')!.model).toBe('grok-build');
    expect(modelCatalogDetail()).toBe('bundled list');
  });
});
