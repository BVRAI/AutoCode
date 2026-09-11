// Run both compiled entry points under the same guards: this catches accidental
// ordinary startup, including catalog fetches and .env loading.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve('dist/cli.js');
const desktopEntry = resolve('dist/inspection/entry.js');
let fixture: string;
let project: string;
let guardPath: string;
let environment: NodeJS.ProcessEnv;

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

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'autocode-inspection-cli-'));
  project = join(fixture, 'project');
  mkdirSync(project);
  mkdirSync(join(fixture, 'home'));
  writeFileSync(join(project, 'AGENTS.md'), 'Use fixture instructions.\n');
  writeFileSync(join(project, '.env'), 'AUTOCODE_INSPECTION_ENV_MARKER=dotenv-was-loaded\n');
  guardPath = join(fixture, 'guard.cjs');
  writeFileSync(guardPath, `
const fs = require('node:fs');
const writeMarker = fs.appendFileSync.bind(fs);
function blocked(action) {
  writeMarker(process.env.INSPECTION_GUARD_MARKER, action + '\\n');
  throw new Error('Inspection side effect blocked: ' + action);
}
globalThis.fetch = () => blocked('fetch');
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  module.request = () => blocked(name + '.request');
  module.get = () => blocked(name + '.get');
}
require('node:net').Socket.prototype.connect = function () { return blocked('socket.connect'); };
const children = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = children[name];
  children[name] = function (command, ...args) {
    if (!/^(?:git(?:\\.exe)?)(?:\\s|$)/i.test(String(command))) return blocked('process:' + name + ':' + command);
    return original.call(this, command, ...args);
  };
}
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'copyFileSync', 'cpSync', 'truncateSync']) {
  fs[name] = () => blocked('fs.' + name);
}
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'copyFile', 'cp', 'truncate']) {
  fs.promises[name] = () => blocked('fs.promises.' + name);
}
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'keytar') return blocked('keytar');
  return originalLoad.call(this, request, ...args);
};
Module.syncBuiltinESMExports();
process.on('exit', () => {
  if (process.env.AUTOCODE_INSPECTION_ENV_MARKER) writeMarker(process.env.INSPECTION_GUARD_MARKER, 'dotenv-loaded\\n');
});
`);
  environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/TOKEN|SECRET|PASSWORD|API_KEY|^AUTOCODE_|^AUTOMAX_|^NODE_OPTIONS$|^INSPECTION_/i.test(name)));
  Object.assign(environment, {
    USERPROFILE: join(fixture, 'home'), HOME: join(fixture, 'home'),
    LOCALAPPDATA: join(fixture, 'home', 'AppData', 'Local'),
    AUTOCODE_CONFIG_DIR: join(fixture, 'missing-config'),
    AUTOCODE_DATA_DIR: join(fixture, 'missing-data'),
    // Ordinary startup would contact the catalog. The preload records and
    // refuses that call before any connection can leave this test process.
    AUTOMAX_PROXY_TOKEN: 'fixture-token-with-no-real-authority',
    AUTOMAX_PROXY_URL: 'http://127.0.0.1:1',
    NO_UPDATE_NOTIFIER: '1',
    INSPECTION_GUARD_MARKER: join(fixture, 'unexpected-side-effects.txt'),
  });
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

function request() {
  return {
    version: 1, projectRoot: project, sessionId: 'preview-before-first-message',
    provider: 'xai', model: 'grok-build-0.1', mode: 'default',
    systemAppendix: 'CLI inspection fixture host context',
  };
}

async function runInspection(input: string, entryArgs: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--require', guardPath, ...entryArgs], {
      cwd: project, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Inspection CLI did not exit within 15s; stderr=${stderr}`));
    }, 15_000);
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

function onlyResponse(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split(/\r?\n/);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe.each([
  { label: 'CLI --inspect', args: [cli, '--inspect'] },
  { label: 'dedicated desktop entry', args: [desktopEntry] },
])('$label safety', ({ args }) => {
  const inspect = (input: string) => runInspection(input, args);

  it('answers before any session exists without config/data creation, networking, keyring access, or ordinary startup', async () => {
    const before = snapshot(fixture);
    const completed = await inspect(`${JSON.stringify(request())}\n`);
    expect(completed.code, completed.stderr).toBe(0);
    const result = onlyResponse(completed.stdout);
    expect(result).toMatchObject({
      version: 1, source: 'preview',
      context: { projectRoot: project, sessionId: 'preview-before-first-message', provider: 'xai', mode: 'default' },
    });
    expect(result.error).toBeUndefined();
    expect(result.system).toContain('Use fixture instructions.');
    expect(result.system).toContain('CLI inspection fixture host context');
    expect(typeof result.systemVolatile).toBe('string');
    expect(Array.isArray(result.tools)).toBe(true);
    expect(snapshot(fixture)).toEqual(before);
  }, 20_000);

  it('does not run configured hooks, MCP commands, verification, or write existing settings', async () => {
    const config = join(fixture, 'config');
    mkdirSync(config);
    environment.AUTOCODE_CONFIG_DIR = config;
    const command = 'node -e "throw new Error(\'must not run during inspection\')"';
    writeFileSync(join(config, 'config.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] },
      mcpServers: { fixture: { command: 'node', args: ['-e', 'throw new Error("MCP must not start")'] } },
      autoVerify: true, verifyCommand: command,
      webTools: { enabled: false }, computerUse: { enabled: true },
      apiKeys: { openai: 'fixture-only-never-a-real-key' },
    }));
    const before = snapshot(fixture);
    const completed = await inspect(JSON.stringify({ ...request(), autoVerify: true, verifyCommand: command }));
    expect(completed.code, completed.stderr).toBe(0);
    const result = onlyResponse(completed.stdout);
    expect(result.error).toBeUndefined();
    expect(result.verification).toEqual({ autoVerify: true, verifyCommand: command });
    expect(completed.stdout).not.toContain('fixture-only-never-a-real-key');
    expect(snapshot(fixture)).toEqual(before);
  }, 20_000);

  it('collects git state without refreshing the index or invoking a configured fsmonitor', async () => {
    environment.GIT_CONFIG_NOSYSTEM = '1';
    environment.GIT_CONFIG_GLOBAL = join(fixture, 'missing-global-git-config');
    const git = (args: string[]) => execFileSync('git', args, {
      cwd: project, env: environment, windowsHide: true, stdio: 'ignore', timeout: 5_000,
    });
    git(['-c', 'init.templateDir=', 'init']);
    const tracked = join(project, 'tracked.ts');
    writeFileSync(tracked, 'export const tracked = true;\n');
    git(['add', 'tracked.ts']);
    const fsmonitor = join(fixture, 'fsmonitor.cjs');
    writeFileSync(fsmonitor, `require('node:fs').writeFileSync(${JSON.stringify(join(fixture, 'fsmonitor-was-run.txt'))}, 'unexpected fsmonitor');`);
    git(['config', 'core.fsmonitor', `node "${fsmonitor.replace(/\\/g, '/')}"`]);
    // A stat change with identical content invites ordinary git status to
    // refresh cached index metadata. Inspection must suppress that write.
    const touched = new Date(Date.now() - 10_000);
    utimesSync(tracked, touched, touched);
    const before = snapshot(fixture);

    const completed = await inspect(JSON.stringify(request()));

    expect(completed.code, completed.stderr).toBe(0);
    const result = onlyResponse(completed.stdout);
    expect(result.error).toBeUndefined();
    expect(result.systemVolatile).toContain('Working state');
    expect(result.systemVolatile).toContain('tracked.ts');
    expect(snapshot(fixture)).toEqual(before);
  }, 20_000);

  it.each(['{broken-json', '', 'null'])('returns one structured error for malformed input %j with no writes', async (input) => {
    const before = snapshot(fixture);
    const completed = await inspect(input);
    const result = onlyResponse(completed.stdout);
    expect(result.version).toBe(1);
    expect(typeof result.error).toBe('string');
    expect(String(result.error).length).toBeGreaterThan(0);
    expect(result.system).toBeUndefined();
    expect(snapshot(fixture)).toEqual(before);
  }, 20_000);

  it('rejects a missing project root instead of creating it', async () => {
    const before = snapshot(fixture);
    const completed = await inspect(JSON.stringify({ ...request(), projectRoot: join(fixture, 'missing-project') }));
    const result = onlyResponse(completed.stdout);
    expect(result).toMatchObject({ version: 1, error: expect.any(String) });
    expect(result.system).toBeUndefined();
    expect(snapshot(fixture)).toEqual(before);
  }, 20_000);
});
