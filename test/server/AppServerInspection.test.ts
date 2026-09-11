import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFER_THRESHOLD, type ToolRegistry } from '../../src/agent/ToolRegistry.js';
import type { Tool } from '../../src/tools/types.js';
import { initialize as initializeSecrets } from '../../src/auth/SecretStore.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => process.env.AUTOCODE_TEST_HOME ?? actual.homedir() };
});

// Starting the test session may initialize the ordinary host lifecycle, but
// must never access the developer's keyring. No model turn is submitted.
vi.mock('../../src/auth/SecretStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/SecretStore.js')>();
  return { ...actual, initialize: vi.fn(async () => undefined), getSecret: vi.fn(() => undefined) };
});

type Message = {
  id?: number; method?: string; params?: Record<string, unknown>;
  result?: Record<string, unknown>; error?: { code: number; message: string };
};

class Client {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly messages: Message[] = [];
  private sequence = 0;
  private readonly waiting = new Map<number, (message: Message) => void>();
  private readonly reader = createInterface({ input: this.output });

  constructor() {
    this.reader.on('line', (line) => {
      const message = JSON.parse(line) as Message;
      this.messages.push(message);
      if (message.id !== undefined) this.waiting.get(message.id)?.(message);
    });
  }

  call(method: string, params?: Record<string, unknown>): Promise<Message> {
    const id = ++this.sequence;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`Timed out awaiting ${method}`));
      }, 10_000);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolvePromise(message);
      });
      this.input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  close(): void {
    this.input.end();
    this.reader.close();
  }
}

function snapshot(root: string): Record<string, { modified: number; contents?: string }> {
  const entries: Record<string, { modified: number; contents?: string }> = {};
  function visit(dir: string, prefix: string): void {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = statSync(path);
      entries[relative] = { modified: stat.mtimeMs, ...(stat.isFile() ? { contents: readFileSync(path).toString('base64') } : {}) };
      if (stat.isDirectory()) visit(path, relative);
    }
  }
  visit(root, '');
  return entries;
}

let fixture: string;
let project: string;
let config: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'autocode-server-inspection-'));
  project = join(fixture, 'project');
  config = join(fixture, 'config');
  mkdirSync(project);
  mkdirSync(config);
  mkdirSync(join(fixture, 'home'));
  writeFileSync(join(project, 'AGENTS.md'), 'Inspection fixture project.\n');
  writeFileSync(join(config, 'config.json'), JSON.stringify({
    autoVerify: true, verifyCommand: 'config-policy', review: 'off', autoMode: { reviewer: false },
    webTools: { enabled: false }, computerUse: { enabled: false },
  }));
  const fake = join(fixture, 'fake.json');
  writeFileSync(fake, JSON.stringify({ turns: [{ text: 'This fixture should never submit a turn.' }] }));
  vi.stubEnv('AUTOCODE_TEST_HOME', join(fixture, 'home'));
  vi.stubEnv('AUTOCODE_CONFIG_DIR', config);
  vi.stubEnv('AUTOCODE_DATA_DIR', join(fixture, 'data'));
  vi.stubEnv('AUTOCODE_FAKE_LLM', fake);
  vi.stubEnv('AUTOCODE_TRUST_ALL', '1');
  vi.stubEnv('AUTOCODE_NO_INDEX', '1');
  vi.stubEnv('AUTOCODE_NO_GIT_TOOLS', '1');
  vi.stubEnv('AUTOCODE_NO_LSP', '1');
  vi.stubEnv('AUTOCODE_REVIEW', 'off');
  vi.stubEnv('AUTOCODE_AUTO_JUDGE', 'off');
  vi.stubEnv('AUTOCODE_INSPECTION', '');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Inspection must not call a provider or network'); }));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(fixture, { recursive: true, force: true });
});

describe('AppServer session.inspect', () => {
  it('advertises the version, requires an existing session, and inspects its actual context/registry/policy without writes', async () => {
    const { AppServer } = await import('../../src/server/AppServer.js');
    const client = new Client();
    const server = new AppServer({ input: client.input, output: client.output });
    const stopped = server.run();
    try {
      const initial = snapshot(fixture);
      const initialize = await client.call('initialize');
      expect(initialize.result?.capabilities).toMatchObject({ inspectionVersion: 1 });
      const early = await client.call('session.inspect');
      expect(early.error?.code).toBe(-32001);
      expect(snapshot(fixture)).toEqual(initial);
      expect(initializeSecrets).not.toHaveBeenCalled();

      const created = await client.call('session.new', {
        projectRoot: project, provider: 'xai', model: 'grok-build-0.1', mode: 'default', locale: 'en',
        systemAppendix: 'Live fixture briefing', autoVerify: false, verifyCommand: 'host-policy',
      });
      expect(created.error).toBeUndefined();
      const registry = (server as unknown as { session: { agent: { registry: ToolRegistry } } }).session.agent.registry;
      const optional: Tool[] = Array.from({ length: DEFER_THRESHOLD + 1 }, (_, index) => ({
        definition: {
          name: `mcp__fixture__${index}`, description: `Live optional fixture ${index}`,
          inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
        },
        execute: vi.fn(async () => { throw new Error('Inspection must not execute tools'); }),
      }));
      for (const tool of optional) registry.registerOptional(tool);
      registry.loadDeferred('mcp__fixture__0');

      // Persisted defaults deliberately differ now. Inspection must report the
      // already-created runtime registry and host policy, not rebuild them.
      writeFileSync(join(config, 'config.json'), JSON.stringify({
        autoVerify: true, verifyCommand: 'changed-config-policy',
        webTools: { enabled: true }, computerUse: { enabled: true },
      }));
      await client.call('session.setMode', { mode: 'planning' });
      await client.call('session.command', { name: 'model', args: ['openai', 'fixture-live-model'] });
      const before = snapshot(fixture);
      const deferred = registry.deferredNames();
      const schemas = registry.schemas();
      const secretInitializations = vi.mocked(initializeSecrets).mock.calls.length;
      const messageCount = client.messages.length;

      const response = await client.call('session.inspect');
      expect(response.error).toBeUndefined();
      expect(response.result).toMatchObject({
        version: 1, source: 'live',
        context: {
          projectRoot: project, sessionId: created.result?.sessionId,
          provider: 'openai', model: 'fixture-live-model', mode: 'planning',
          locale: 'en', systemAppendix: 'Live fixture briefing',
        },
        verification: { autoVerify: false, verifyCommand: 'host-policy' },
      });
      expect(Number.isFinite(Date.parse(String(response.result?.generatedAt)))).toBe(true);
      // Full file/prompt assembly belongs to the isolated preview worker.
      expect(response.result?.system).toBeUndefined();
      expect(response.result?.instructions).toBeUndefined();
      expect(response.result?.memory).toBeUndefined();
      const tools = response.result?.tools as Array<Record<string, unknown>>;
      expect(tools.find((tool) => tool.name === 'mcp__fixture__0')).toMatchObject({ availability: 'loaded' });
      expect(tools.find((tool) => tool.name === 'mcp__fixture__1')).toMatchObject({ availability: 'on-demand', inputSchema: optional[1]!.definition.inputSchema });
      expect(tools.find((tool) => tool.name === 'write_file')?.modePolicy).toBe('block');
      expect(tools.find((tool) => tool.name === 'read_file')?.modePolicy).toBe('allow');
      expect(tools.some((tool) => tool.name === 'web_search' || tool.name === 'computer_use_task')).toBe(false);

      await client.call('session.inspect');
      expect(client.messages.slice(messageCount).every((message) => !message.method)).toBe(true);
      expect(registry.deferredNames()).toEqual(deferred);
      expect(registry.schemas()).toEqual(schemas);
      expect(vi.mocked(initializeSecrets).mock.calls.length).toBe(secretInitializations);
      for (const tool of optional) expect(tool.execute).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(snapshot(fixture)).toEqual(before);
    } finally {
      await client.call('shutdown');
      await stopped;
      client.close();
    }
  }, 20_000);
});
