import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestHostResult, osOpenCommand } from '../../src/util/host.js';

describe('requestHostResult', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-host-'));
    vi.stubEnv('AUTOCODE_DATA_DIR', root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips a request via the result file the host writes', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const promise = requestHostResult('screenshot', { url: 'http://x' }, 5000);
    // Give the signal a tick to be emitted, then simulate the host.
    await new Promise((r) => setTimeout(r, 60));
    spy.mockRestore();

    const line = writes.find((w) => w.includes('@@autocode:screenshot'));
    expect(line).toBeDefined();
    const payload = JSON.parse(line!.slice(line!.indexOf('{')));
    expect(payload.url).toBe('http://x');
    writeFileSync(payload.resultPath, JSON.stringify({ ok: true, data: 'IMGDATA' }));

    const result = await promise;
    expect(result?.ok).toBe(true);
    expect(result?.data).toBe('IMGDATA');
  });

  it('returns null when the host never responds before the timeout', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = await requestHostResult('screenshot', {}, 400);
    spy.mockRestore();
    expect(result).toBeNull();
  });
});

describe('osOpenCommand', () => {
  it('returns a command containing the url', () => {
    const { cmd, args } = osOpenCommand('https://example.com/');
    expect(cmd.length).toBeGreaterThan(0);
    expect(args).toContain('https://example.com/');
  });
});
