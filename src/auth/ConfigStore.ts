import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../util/paths.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AutocodeConfig {
  defaultProvider?: string;
  defaultModel?: string;
  apiKeys?: {
    anthropic?: string;
    openai?: string;
    google?: string;
    xai?: string;
    openrouter?: string;
    brave?: string;
  };
  // Non-secret metadata for BYOK keys — the keys themselves live in the OS
  // keyring (via SecretStore), but the "when did I add this" timestamp is
  // not sensitive, so it sits here. Keyed by provider id. Surfaced by the
  // `/keys` manager as "added <date>".
  apiKeyMeta?: Record<string, { addedAt: string }>;
  // Map of arbitrary server name → spawn config. Same shape as Claude Code's
  // mcpServers entry, so users can paste configs across tools.
  mcpServers?: Record<string, McpServerConfig>;
  // Verification: the command the harness runs after file edits to check the
  // project. `verifyCommand` overrides the inferred default; `autoVerify`
  // disables the post-edit verification loop when set to false.
  verifyCommand?: string;
  autoVerify?: boolean;
  // Auto-update is **opt-out** — when a newer version is detected at startup
  // (standalone install only; never for the V6-bundled copy or in headless
  // mode or on a prerelease), autocode auto-installs and tells the user to
  // relaunch. Set `autoUpdate: false` here, or set the env var
  // `AUTOCODE_NO_UPDATE=1`, to disable. On disable you still see the notify
  // banner — you just have to run `/update` yourself.
  autoUpdate?: boolean;
  // Smart docs — at /exit, if the session changed files or made ≥3 tool
  // calls, autocode asks a small model to propose 0-5 lines worth appending
  // to AUTOCODE.md. Default true; set to false to skip the auto-trigger
  // (the explicit /reflect command still works either way).
  reflectAfterSession?: boolean;
  // User-defined event hooks. Each entry is a shell command that fires at the
  // named event. `pre_tool` exit code 2 BLOCKS the tool call (stderr fed back
  // to the model); other non-zero codes (and post_tool / stop entirely) are
  // advisory. Optional `match` is a `|`-separated list of exact tool names,
  // or `*` for all (default).
  hooks?: {
    pre_tool?: HookSpec[];
    post_tool?: HookSpec[];
    stop?: HookSpec[];
  };
  // Spinner picker for the Ink Bridge TUI. `default` is what shows for any
  // in-flight LLM/tool call; `longOps` auto-engages for ops running >4s.
  // Valid ids: braille (default), pulse, orbit, arc, dots, heartbeat, bars,
  // shimmer, pipeline, reactor.
  spinner?: {
    default?: string;
    planning?: string;
    autocode?: string;
    longOps?: string;
    speed?: number;
  };
  // Web-tool guard rails. See src/util/urlGuard.ts for the validation rules.
  // Defaults are safe: https only, private IPs blocked, no extra entries.
  // Set `enabled: false` to remove web_fetch + web_search from the tool
  // list entirely (the LLM won't see them as options).
  webTools?: {
    enabled?: boolean;
    allowHttp?: boolean;
    blockPrivateIps?: boolean;
    extraBlockedHosts?: string[];
    extraAllowedHosts?: string[];
  };
  // ISO timestamp recorded when the first-run wizard finished — either by
  // saving credentials, opening the bvrai.com signup page, or by the user
  // explicitly choosing Skip. Set once; suppresses the wizard on subsequent
  // launches so it never re-prompts.
  firstRunCompletedAt?: string;
  // Bridge TUI rendering. `mode`: 'inline' (default — flicker-free append-only
  // scrolling log) or 'cockpit' (the full-screen alt-screen rail). `theme`:
  // 'dark' (default) or 'light'. Toggled at runtime with `/ui`.
  ui?: {
    mode?: 'inline' | 'cockpit';
    theme?: 'dark' | 'light';
  };
  // Long-lived BVRAI proxy API key (`sk_amx_*`) obtained via `/login`. When
  // present, AutoCode authenticates standalone proxy requests with this
  // key. Distinct from `AUTOMAX_PROXY_TOKEN` (a short-lived Firebase ID
  // token injected by V6) — the precedence in AuthResolver puts the env
  // var first, so V6-embedded sessions always use V6's session and never
  // see this key. Stored plaintext in Phase A; Phase C will migrate to OS
  // keyring.
  amxKey?: string;
}

export interface HookSpec {
  match?: string;
  command: string;
  timeoutMs?: number;
}

export class ConfigStore {
  private readonly path: string;

  constructor() {
    mkdirSync(configDir(), { recursive: true });
    this.path = join(configDir(), 'config.json');
  }

  load(): AutocodeConfig {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as AutocodeConfig;
    } catch {
      return {};
    }
  }

  save(config: AutocodeConfig): void {
    writeFileSync(this.path, JSON.stringify(config, null, 2), 'utf8');
  }

  getApiKey(provider: keyof NonNullable<AutocodeConfig['apiKeys']>): string | undefined {
    const envKey = envKeyFor(provider);
    const fromEnv = envKey ? process.env[envKey] : undefined;
    if (fromEnv && fromEnv.length > 0) return fromEnv;
    return this.load().apiKeys?.[provider];
  }
}

function envKeyFor(provider: string): string | undefined {
  switch (provider) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'google':
      return 'GOOGLE_API_KEY';
    case 'xai':
      return 'XAI_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    case 'brave':
      return 'BRAVE_API_KEY';
    default:
      return undefined;
  }
}
