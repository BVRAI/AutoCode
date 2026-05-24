import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetPluginCacheForTests,
  discoverPlugins,
  pluginHooksForEvent,
} from '../../src/agent/Plugins.js';

function writeManifest(pluginDir: string, manifest: unknown): void {
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest), 'utf8');
}

function writeSkill(pluginDir: string, filename: string, content: string): void {
  mkdirSync(join(pluginDir, 'skills'), { recursive: true });
  writeFileSync(join(pluginDir, 'skills', filename), content, 'utf8');
}

function writeHooks(pluginDir: string, hooks: unknown): void {
  writeFileSync(join(pluginDir, 'hooks.json'), JSON.stringify(hooks), 'utf8');
}

describe('discoverPlugins', () => {
  let projectRoot: string;
  let userHome: string;

  beforeEach(() => {
    _resetPluginCacheForTests();
    projectRoot = mkdtempSync(join(tmpdir(), 'autocode-plugins-proj-'));
    userHome = mkdtempSync(join(tmpdir(), 'autocode-plugins-user-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  });

  it('returns [] when neither plugins directory exists', () => {
    expect(discoverPlugins(projectRoot, userHome)).toEqual([]);
  });

  it('discovers a manifest-only plugin', () => {
    writeManifest(join(userHome, '.autocode', 'plugins', 'sample'), {
      name: 'sample',
      description: 'a test plugin',
    });
    const r = discoverPlugins(projectRoot, userHome);
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe('sample');
    expect(r[0]!.description).toBe('a test plugin');
    expect(r[0]!.skills).toEqual([]);
    expect(r[0]!.hooks).toEqual({});
    expect(r[0]!.source).toBe('user');
  });

  it('discovers a plugin with skills', () => {
    const dir = join(userHome, '.autocode', 'plugins', 'pack');
    writeManifest(dir, { name: 'pack' });
    writeSkill(dir, 's1.md', '---\nname: greet\ndescription: say hi\n---\nHello!');
    const r = discoverPlugins(projectRoot, userHome);
    expect(r).toHaveLength(1);
    expect(r[0]!.skills).toHaveLength(1);
    expect(r[0]!.skills[0]!.name).toBe('greet');
    expect(r[0]!.skills[0]!.body).toBe('Hello!');
  });

  it('discovers a plugin with hooks', () => {
    const dir = join(userHome, '.autocode', 'plugins', 'lint-pack');
    writeManifest(dir, { name: 'lint-pack' });
    writeHooks(dir, {
      post_tool: [{ match: 'edit_file', command: 'npm run lint' }],
    });
    const r = discoverPlugins(projectRoot, userHome);
    expect(r[0]!.hooks.post_tool).toHaveLength(1);
    expect(r[0]!.hooks.post_tool![0]!.command).toBe('npm run lint');
  });

  it('skips directories without a plugin.json', () => {
    mkdirSync(join(userHome, '.autocode', 'plugins', 'no-manifest'), { recursive: true });
    expect(discoverPlugins(projectRoot, userHome)).toEqual([]);
  });

  it('skips plugins whose manifest is invalid JSON', () => {
    const dir = join(userHome, '.autocode', 'plugins', 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), '{not json', 'utf8');
    expect(discoverPlugins(projectRoot, userHome)).toEqual([]);
  });

  it('skips plugins whose manifest has no name', () => {
    writeManifest(join(userHome, '.autocode', 'plugins', 'anon'), { description: 'oops' });
    expect(discoverPlugins(projectRoot, userHome)).toEqual([]);
  });

  it('handles bad hooks.json silently (empty hooks)', () => {
    const dir = join(userHome, '.autocode', 'plugins', 'flaky');
    writeManifest(dir, { name: 'flaky' });
    writeFileSync(join(dir, 'hooks.json'), '{not json', 'utf8');
    const r = discoverPlugins(projectRoot, userHome);
    expect(r).toHaveLength(1);
    expect(r[0]!.hooks).toEqual({});
  });

  it('project-local plugins override user-global on name conflict', () => {
    writeManifest(join(userHome, '.autocode', 'plugins', 'shared'), { name: 'shared', description: 'user' });
    writeManifest(join(projectRoot, '.autocode', 'plugins', 'shared'), { name: 'shared', description: 'project' });
    const r = discoverPlugins(projectRoot, userHome);
    expect(r).toHaveLength(1);
    expect(r[0]!.source).toBe('project');
    expect(r[0]!.description).toBe('project');
  });

  it('returns plugins sorted by name', () => {
    writeManifest(join(userHome, '.autocode', 'plugins', 'zeta'), { name: 'zeta' });
    writeManifest(join(userHome, '.autocode', 'plugins', 'alpha'), { name: 'alpha' });
    const r = discoverPlugins(projectRoot, userHome);
    expect(r.map((p) => p.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('pluginHooksForEvent', () => {
  it('returns [] for an empty plugin list', () => {
    expect(pluginHooksForEvent([], 'pre_tool')).toEqual([]);
  });

  it('flattens hook specs across plugins for the requested event', () => {
    const plugins = [
      {
        name: 'a',
        dir: '/a',
        source: 'user' as const,
        skills: [],
        hooks: { pre_tool: [{ command: 'a1' }] },
      },
      {
        name: 'b',
        dir: '/b',
        source: 'user' as const,
        skills: [],
        hooks: { pre_tool: [{ command: 'b1' }, { command: 'b2' }], post_tool: [{ command: 'b-post' }] },
      },
    ];
    expect(pluginHooksForEvent(plugins, 'pre_tool').map((h) => h.command)).toEqual(['a1', 'b1', 'b2']);
    expect(pluginHooksForEvent(plugins, 'post_tool').map((h) => h.command)).toEqual(['b-post']);
    expect(pluginHooksForEvent(plugins, 'stop')).toEqual([]);
  });
});
