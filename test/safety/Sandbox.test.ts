import { describe, expect, it, beforeEach } from 'vitest';
import { homedir } from 'node:os';
import { _resetSandboxForTests, runtimeConfigFor, sandboxEnabled, wrapForSandbox } from '../../src/safety/Sandbox.js';

describe('Sandbox (Phase 5.4)', () => {
  beforeEach(() => {
    _resetSandboxForTests();
    delete process.env.AUTOCODE_NO_SANDBOX;
  });

  it('is off unless enabled, and AUTOCODE_NO_SANDBOX=1 forces it off', () => {
    expect(sandboxEnabled(undefined)).toBe(false);
    expect(sandboxEnabled({})).toBe(false);
    expect(sandboxEnabled({ enabled: true })).toBe(true);
    process.env.AUTOCODE_NO_SANDBOX = '1';
    expect(sandboxEnabled({ enabled: true })).toBe(false);
  });

  it('maps our config onto the runtime settings with safe defaults', () => {
    const cfg = runtimeConfigFor({ enabled: true, allowedDomains: ['github.com'] }, 'C:/proj') as {
      network: { allowedDomains: string[]; deniedDomains: string[] };
      filesystem: { denyRead: string[]; allowWrite: string[] };
    };
    expect(cfg.network.allowedDomains).toEqual(['github.com']);
    expect(cfg.network.deniedDomains).toEqual([]);
    // Secrets directories are unreadable by default, expanded from `~`.
    expect(cfg.filesystem.denyRead.some((p) => p.startsWith(homedir()) && p.endsWith('.ssh'))).toBe(true);
    // `.` means the project root; the temp dir stays writable.
    expect(cfg.filesystem.allowWrite).toContain('C:/proj');
    expect(cfg.filesystem.allowWrite).toContain('/tmp');
  });

  it('honours explicit lists over the defaults', () => {
    const cfg = runtimeConfigFor({ enabled: true, denyRead: ['~/secret'], allowWrite: ['.', 'D:/out'] }, '/p') as {
      filesystem: { denyRead: string[]; allowWrite: string[] };
    };
    expect(cfg.filesystem.denyRead).toEqual([`${homedir()}/secret`]);
    expect(cfg.filesystem.allowWrite).toEqual(['/p', 'D:/out']);
  });

  it('runs commands unsandboxed with one note when the runtime is not installed', async () => {
    const first = await wrapForSandbox('echo hi', { config: { enabled: true }, projectRoot: '/p' });
    expect(first.sandboxed).toBe(false);
    expect(first.command).toBe('echo hi');
    expect(first.note).toMatch(/not installed/);
    const second = await wrapForSandbox('echo again', { config: { enabled: true }, projectRoot: '/p' });
    expect(second.sandboxed).toBe(false);
    expect(second.note).toBeUndefined();
  });
});
