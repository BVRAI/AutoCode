// `/proxy` slash-command handler. Resolves the same authentication mode as
// provider requests, then verifies proxy connectivity against the authenticated
// `/v1/usage/me` endpoint. Keeping the probe here (rather than in TerminalMode)
// makes the connection states reusable by future status UI without coupling
// network/auth logic to a rendering surface.

import pc from 'picocolors';

import {
  AuthResolver,
  isProxyAuth,
  proxyRootUrl,
  type AuthMode,
} from '../auth/AuthResolver.js';
import type { ConsoleRenderer } from './ConsoleRenderer.js';

const DEFAULT_TIMEOUT_MS = 10_000;

interface AuthResolverLike {
  resolve(provider: string): AuthMode;
}

export interface ProxyStatusOptions {
  authResolver?: AuthResolverLike;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}

type ProxyAuthKind = 'automax' | 'amxkey';

export type ProxyConnectionStatus =
  | {
      kind: 'not-configured';
      authKind: 'byok' | 'missing';
      endpoint: string;
    }
  | {
      kind: 'connected';
      authKind: ProxyAuthKind;
      endpoint: string;
    }
  | {
      kind: 'rejected';
      authKind: ProxyAuthKind;
      endpoint: string;
      statusCode: 401 | 403;
    }
  | {
      kind: 'unavailable';
      authKind: ProxyAuthKind;
      endpoint: string;
      detail: string;
    };

export async function runProxyStatus(
  renderer: ConsoleRenderer,
  provider: string,
  options: ProxyStatusOptions = {},
): Promise<ProxyConnectionStatus> {
  const endpoint = proxyRootUrl();
  const resolver = options.authResolver ?? new AuthResolver();
  const auth = resolver.resolve(provider);

  if (!isProxyAuth(auth)) {
    const status: ProxyConnectionStatus = {
      kind: 'not-configured',
      authKind: auth.kind,
      endpoint,
    };
    renderer.info(`${pc.yellow('Not connected')} to the BVRAI proxy.`);
    if (auth.kind === 'byok') {
      renderer.dim(`  ${provider} requests are using a provider API key directly.`);
      renderer.dim('  Run /login if you want to route requests through BVRAI.');
    } else {
      renderer.dim('  No active proxy credential was found. Run /login to connect.');
    }
    return status;
  }

  renderer.dim(`Checking ${endpoint}…`);
  const status = await probeProxy(auth.kind, auth.token, endpoint, {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  switch (status.kind) {
    case 'connected':
      renderer.info(`${pc.green('Connected')} to the BVRAI proxy.`);
      renderer.info(`  Endpoint:       ${status.endpoint}`);
      renderer.info(`  Authentication: ${authLabel(status.authKind)}`);
      return status;
    case 'rejected':
      renderer.error(`Not connected to the BVRAI proxy (credentials rejected: HTTP ${status.statusCode}).`);
      renderer.info(`  Endpoint: ${status.endpoint}`);
      renderer.dim(
        status.authKind === 'automax'
          ? '  Reauthenticate in Automax, then restart this session.'
          : '  Run /login to replace the saved BVRAI credential.',
      );
      return status;
    case 'unavailable':
      renderer.warn(`BVRAI proxy is configured, but the connection could not be verified (${status.detail}).`);
      renderer.info(`  Endpoint: ${status.endpoint}`);
      renderer.dim('  Check your network or proxy URL, then run /proxy again.');
      return status;
    case 'not-configured':
      // `probeProxy` only accepts proxy authentication, so this state cannot
      // occur here. The exhaustive branch keeps future status additions safe.
      return status;
  }
}

interface ProbeOptions {
  fetchImpl: typeof globalThis.fetch;
  timeoutMs: number;
}

async function probeProxy(
  authKind: ProxyAuthKind,
  token: string,
  endpoint: string,
  options: ProbeOptions,
): Promise<ProxyConnectionStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchImpl(`${endpoint}/v1/usage/me`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (response.ok) {
      return { kind: 'connected', authKind, endpoint };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        kind: 'rejected',
        authKind,
        endpoint,
        statusCode: response.status,
      };
    }
    return {
      kind: 'unavailable',
      authKind,
      endpoint,
      detail: `HTTP ${response.status}`,
    };
  } catch (error) {
    const detail = controller.signal.aborted
      ? `timed out after ${options.timeoutMs} ms`
      : error instanceof Error
        ? error.message
        : String(error);
    return { kind: 'unavailable', authKind, endpoint, detail };
  } finally {
    clearTimeout(timer);
  }
}

function authLabel(kind: ProxyAuthKind): string {
  return kind === 'automax' ? 'Automax-managed session' : 'saved BVRAI login';
}
