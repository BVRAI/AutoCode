import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenInBrowserTool } from '../../src/tools/openInBrowser.js';
import { osOpenCommand } from '../../src/util/host.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

function ctx(): ToolExecutionContext {
  const session: SessionContext = {
    sessionId: 't',
    projectRoot: '/tmp',
    dataDir: '/tmp',
    sessionDir: '/tmp/s',
    model: { provider: 'xai', model: 'grok-code-fast-1' },
    startedAt: new Date().toISOString(),
  };
  return { session };
}

describe('open_in_browser', () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it('emits a host signal line when running under Automax', async () => {
    vi.stubEnv('AUTOMAX_PROXY_TOKEN', 'tok');
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const out = await new OpenInBrowserTool().execute(
        { urls: ['https://a.example/', 'https://b.example/'] },
        ctx(),
      );
      expect(out.isError).toBeFalsy();
      expect(out.metadata?.hosted).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const signal = written.find((w) => w.startsWith('@@autocode:open_browser'));
    expect(signal).toBeDefined();
    expect(signal).toContain('https://a.example/');
    expect(signal).toContain('https://b.example/');
  });

  it('rejects a non-http URL and opens nothing', async () => {
    const out = await new OpenInBrowserTool().execute({ url: 'file:///etc/passwd' }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/http/i);
  });

  it('rejects an invalid URL', async () => {
    const out = await new OpenInBrowserTool().execute({ url: 'not a url' }, ctx());
    expect(out.isError).toBe(true);
  });

  it('errors when no urls are provided', async () => {
    const out = await new OpenInBrowserTool().execute({}, ctx());
    expect(out.isError).toBe(true);
  });

  it('osOpenCommand includes the url and a non-empty command', () => {
    const { cmd, args } = osOpenCommand('https://example.com/');
    expect(cmd.length).toBeGreaterThan(0);
    expect(args).toContain('https://example.com/');
  });
});
