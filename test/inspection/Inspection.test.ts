import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPromptParts } from '../../src/agent/PromptBuilder.js';
import { DEFER_THRESHOLD, ToolRegistry } from '../../src/agent/ToolRegistry.js';
import { memoryDir } from '../../src/agent/Memory.js';
import type { SessionContext } from '../../src/session/SessionContext.js';
import type { Tool } from '../../src/tools/types.js';
import { buildInspectionPreview, inspectLiveSession } from '../../src/inspection/Inspection.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => process.env.AUTOCODE_TEST_HOME ?? actual.homedir() };
});

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

function optionalTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `Fixture tool ${name}`,
      inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    },
    execute: vi.fn(async () => { throw new Error('Inspection must not execute tools'); }),
  };
}

let fixture: string;
let root: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'autocode-inspection-'));
  root = join(fixture, 'project');
  mkdirSync(root);
  mkdirSync(join(fixture, 'home'));
  mkdirSync(join(fixture, 'config'));
  writeFileSync(join(fixture, 'config', 'config.json'), JSON.stringify({
    webTools: { enabled: false }, computerUse: { enabled: false },
    apiKeys: { openai: 'fixture-only-never-a-real-key' },
  }));
  vi.stubEnv('AUTOCODE_TEST_HOME', join(fixture, 'home'));
  vi.stubEnv('AUTOCODE_CONFIG_DIR', join(fixture, 'config'));
  vi.stubEnv('AUTOCODE_DATA_DIR', join(fixture, 'data'));
  vi.stubEnv('AUTOCODE_INSPECTION', '1');
  vi.stubEnv('AUTOCODE_NO_INDEX', '1');
  vi.stubEnv('AUTOCODE_NO_GIT_TOOLS', '1');
  vi.stubEnv('AUTOCODE_NO_LSP', '1');
  vi.stubEnv('AUTOCODE_BENCH_MODE', '0');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Inspection must not make network calls'); }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(fixture, { recursive: true, force: true });
});

function request(mode: SessionContext['mode'] = 'default') {
  return {
    version: 1 as const,
    projectRoot: root,
    sessionId: 'inspection-fixture',
    provider: 'xai',
    model: 'grok-build-0.1',
    mode,
    locale: 'fr',
    systemAppendix: 'Workspace briefing from the inspection fixture.',
    autoVerify: false,
    verifyCommand: 'fixture-command-that-must-not-run',
  };
}

function context(mode: SessionContext['mode'] = 'default'): SessionContext {
  const req = request(mode);
  return {
    sessionId: req.sessionId, projectRoot: root, model: { provider: req.provider, model: req.model },
    mode, locale: req.locale, systemAppendix: req.systemAppendix,
    dataDir: join(fixture, 'data'), sessionDir: join(fixture, 'data', 'sessions', req.sessionId),
    startedAt: '2026-09-09T00:00:00.000Z',
  };
}

describe('inspection snapshots', () => {
  it('requires the isolated worker flag before reading or constructing preview state', () => {
    vi.stubEnv('AUTOCODE_INSPECTION', '');
    const before = snapshot(fixture);
    expect(() => buildInspectionPreview(request())).toThrow(/isolated inspection worker/i);
    expect(snapshot(fixture)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns the actual prompt, instruction sources, full memory, and host policy without writing', async () => {
    writeFileSync(join(root, 'AGENTS.md'), '# Project instructions\nUse small independent modules.\n');
    writeFileSync(join(root, 'master.md'), '# Host constraints\nKeep the fixture marker.\n');
    mkdirSync(join(root, 'feature'));
    writeFileSync(join(root, 'feature', 'AUTOCODE.md'), '---\nverify: fixture-verify\n---\nFeature-specific instructions.\n');
    writeFileSync(join(root, 'main.ts'), 'export const fixtureValue = 1;\n');
    const memories = memoryDir(root);
    mkdirSync(memories, { recursive: true });
    const memoryPath = join(memories, 'workflow.md');
    writeFileSync(memoryPath, '---\nname: workflow\ndescription: Preferred review style\ntype: feedback\n---\n\nExplain the user-visible change first.\n');
    const before = snapshot(fixture);

    const result = await buildInspectionPreview(request());
    const actualPrompt = buildSystemPromptParts(context());

    expect(result).toMatchObject({
      version: 1, source: 'preview',
      context: {
        projectRoot: root, sessionId: 'inspection-fixture', provider: 'xai', model: 'grok-build-0.1',
        mode: 'default', locale: 'fr', systemAppendix: request().systemAppendix,
      },
      verification: { autoVerify: false, verifyCommand: 'fixture-command-that-must-not-run' },
      system: actualPrompt.system, systemVolatile: actualPrompt.systemVolatile,
    });
    expect(Number.isFinite(Date.parse(result.generatedAt))).toBe(true);
    expect(result.instructions).toEqual(expect.arrayContaining([
      expect.objectContaining({ fileName: 'AGENTS.md', path: join(root, 'AGENTS.md'), relativeDir: '', depth: 0, truncated: false }),
      expect.objectContaining({ fileName: 'master.md', isAuthoritative: true }),
      expect.objectContaining({ fileName: 'AUTOCODE.md', relativeDir: 'feature', depth: 1, verify: 'fixture-verify', content: expect.stringContaining('Feature-specific instructions.') }),
    ]));
    expect(result.memory).toEqual([expect.objectContaining({
      name: 'workflow', description: 'Preferred review style', kind: 'feedback',
      body: 'Explain the user-visible change first.', path: memoryPath,
      updatedAt: statSync(memoryPath).mtime.toISOString(),
    })]);
    expect(result.system).toContain('Use small independent modules.');
    expect(result.system).toContain('Explain the user-visible change first.');
    expect(result.system).toContain(request().systemAppendix);
    expect(Array.isArray(result.diagnostics)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('fixture-only-never-a-real-key');
    expect(snapshot(fixture)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports malformed memory metadata without repairing or including its body', async () => {
    const memories = memoryDir(root);
    mkdirSync(memories, { recursive: true });
    const malformed = join(memories, 'broken.md');
    writeFileSync(malformed, 'A malformed private fixture body without frontmatter.\n');
    const before = snapshot(fixture);

    const result = await buildInspectionPreview(request());

    expect(result.memory).toEqual([]);
    expect(result.diagnostics.some((message) => message.includes(malformed))).toBe(true);
    expect(result.diagnostics.join('\n')).not.toContain('A malformed private fixture body');
    expect(result.system).not.toContain('A malformed private fixture body');
    expect(snapshot(fixture)).toEqual(before);
  });

  it.each([
    ['planning', 'block'], ['default', 'approve'], ['autocode', 'allow'],
  ] as const)('reports actual schemas and %s mode policy', async (mode, policy) => {
    const result = await buildInspectionPreview(request(mode));
    const registry = new ToolRegistry();
    expect(result.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })).sort((a, b) => a.name.localeCompare(b.name)))
      .toEqual(registry.schemas().sort((a, b) => a.name.localeCompare(b.name)));
    expect(result.tools.find((tool) => tool.name === 'write_file')).toMatchObject({ availability: 'loaded', modePolicy: policy });
    expect(result.tools.find((tool) => tool.name === 'read_file')).toMatchObject({ availability: 'loaded', modePolicy: 'allow' });
    expect(result.tools.map((tool) => tool.name)).not.toContain('web_search');
    expect(result.tools.map((tool) => tool.name)).not.toContain('computer_use_task');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('inspects a live registry including deferred definitions without loading or executing them', async () => {
    const registry = new ToolRegistry();
    const tools = Array.from({ length: DEFER_THRESHOLD + 1 }, (_, i) => optionalTool(`mcp__fixture__tool_${i}`));
    for (const tool of tools) registry.registerOptional(tool);
    registry.loadDeferred('mcp__fixture__tool_0');
    const deferredBefore = registry.deferredNames();
    const schemasBefore = registry.schemas();
    const before = snapshot(fixture);

    const result = await inspectLiveSession(context('planning'), registry, { autoVerify: true, verifyCommand: 'live-verify' });

    expect(result.source).toBe('live');
    expect(result.context.mode).toBe('planning');
    expect(result.verification).toEqual({ autoVerify: true, verifyCommand: 'live-verify' });
    expect(result.tools.find((tool) => tool.name === 'mcp__fixture__tool_0')).toMatchObject({ availability: 'loaded' });
    expect(result.tools.find((tool) => tool.name === 'mcp__fixture__tool_1')).toMatchObject({
      availability: 'on-demand', description: 'Fixture tool mcp__fixture__tool_1', inputSchema: tools[1]!.definition.inputSchema,
    });
    expect(result.tools.find((tool) => tool.name === 'write_file')?.modePolicy).toBe('block');
    expect(new Set(result.tools.map((tool) => tool.name)).size).toBe(result.tools.length);
    expect(registry.deferredNames()).toEqual(deferredBefore);
    expect(registry.schemas()).toEqual(schemasBefore);
    for (const tool of tools) expect(tool.execute).not.toHaveBeenCalled();
    expect(snapshot(fixture)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
});
