// Optional OS-level sandbox for shell commands (Phase 5.4), on Anthropic's
// open-source sandbox runtime (`@anthropic-ai/sandbox-runtime`: Seatbelt on
// macOS, bubblewrap on Linux, a dedicated local user + Windows Filtering
// Platform fence on Windows). Opt-in through config:
//
//   "sandbox": { "enabled": true, "allowedDomains": ["github.com", "*.npmjs.org"],
//                "allowWrite": ["."], "denyRead": ["~/.ssh", "~/.aws"] }
//
// Network is denied by default inside the sandbox — list the domains the
// project's tooling needs. The runtime is an optional dependency: when it is
// missing or fails to initialize, commands run unsandboxed and the session
// says so once.

import { homedir } from 'node:os';

export interface SandboxConfig {
  enabled?: boolean;
  allowedDomains?: string[];
  deniedDomains?: string[];
  allowWrite?: string[];
  denyRead?: string[];
  allowRead?: string[];
}

interface RuntimeModule {
  SandboxManager: {
    initialize(config: unknown): Promise<void>;
    wrapWithSandbox(command: string): Promise<string>;
    annotateStderrWithSandboxFailures?(key: string, stderr: string): string;
    reset(): Promise<void>;
  };
}

let runtime: RuntimeModule | null | undefined;
let initialized = false;
let warned = false;

export function sandboxEnabled(config: SandboxConfig | undefined): boolean {
  return Boolean(config?.enabled) && process.env.AUTOCODE_NO_SANDBOX !== '1';
}

/** The runtime's config from ours (pure; tested). */
export function runtimeConfigFor(config: SandboxConfig, projectRoot: string): Record<string, unknown> {
  const expand = (p: string): string => p.replace(/^~(?=[\\/]|$)/, homedir());
  return {
    network: {
      allowedDomains: config.allowedDomains ?? [],
      deniedDomains: config.deniedDomains ?? [],
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead: (config.denyRead ?? ['~/.ssh', '~/.aws', '~/.gnupg', '~/.autocode']).map(expand),
      allowRead: (config.allowRead ?? []).map(expand),
      allowWrite: (config.allowWrite ?? ['.', '/tmp']).map((p) => (p === '.' ? projectRoot : expand(p))),
    },
  };
}

// The package is optional (not in package.json): resolve it by a variable
// specifier so the compiler does not require it to be installed.
const RUNTIME_PACKAGE = '@anthropic-ai/sandbox-runtime';

async function load(): Promise<RuntimeModule | null> {
  if (runtime !== undefined) return runtime;
  try {
    runtime = (await import(RUNTIME_PACKAGE)) as unknown as RuntimeModule;
  } catch {
    runtime = null;
  }
  return runtime;
}

/**
 * Wrap a shell command for the sandbox. Returns the command to run and a
 * note for the user when the sandbox could not be applied (once).
 */
export async function wrapForSandbox(
  command: string,
  opts: { config: SandboxConfig; projectRoot: string },
): Promise<{ command: string; sandboxed: boolean; note?: string }> {
  const mod = await load();
  if (!mod) {
    const note = warned ? undefined : 'sandbox: @anthropic-ai/sandbox-runtime is not installed — commands run unsandboxed (npm i -g @anthropic-ai/sandbox-runtime, or add it to this project)';
    warned = true;
    return { command, sandboxed: false, note };
  }
  try {
    if (!initialized) {
      await mod.SandboxManager.initialize(runtimeConfigFor(opts.config, opts.projectRoot));
      initialized = true;
    }
    const wrapped = await mod.SandboxManager.wrapWithSandbox(command);
    return { command: wrapped, sandboxed: true };
  } catch (e) {
    const note = warned ? undefined : `sandbox: could not initialize (${e instanceof Error ? e.message : String(e)}) — commands run unsandboxed`;
    warned = true;
    return { command, sandboxed: false, note };
  }
}

export function annotateSandboxFailures(commandId: string, stderr: string): string {
  try {
    return runtime?.SandboxManager.annotateStderrWithSandboxFailures?.(commandId, stderr) ?? stderr;
  } catch {
    return stderr;
  }
}

export async function shutdownSandbox(): Promise<void> {
  if (!initialized || !runtime) return;
  try {
    await runtime.SandboxManager.reset();
  } catch {
    /* best effort */
  }
  initialized = false;
}

export function _resetSandboxForTests(): void {
  runtime = undefined;
  initialized = false;
  warned = false;
}
