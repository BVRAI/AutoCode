import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CaptureScreenshotTool } from '../../src/tools/captureScreenshot.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

function ctx(): ToolExecutionContext {
  const session: SessionContext = {
    sessionId: 't',
    projectRoot: '/tmp',
    dataDir: '/tmp',
    sessionDir: '/tmp/s',
    model: { provider: 'xai', model: 'm' },
    startedAt: new Date().toISOString(),
    mode: 'autocode',
  };
  return { session };
}

describe('capture_screenshot', () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it('reports host-required when running standalone (not under Automax)', async () => {
    // AUTOMAX_PROXY_TOKEN unset → not hosted
    const out = await new CaptureScreenshotTool().execute({ url: 'http://localhost:5173' }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/Automax host/i);
  });

  it('rejects a non-http URL', async () => {
    const out = await new CaptureScreenshotTool().execute({ url: 'file:///etc/passwd' }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/http/i);
  });

  it('rejects an invalid URL', async () => {
    const out = await new CaptureScreenshotTool().execute({ url: 'not a url' }, ctx());
    expect(out.isError).toBe(true);
  });
});
