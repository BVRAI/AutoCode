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
  // Map of arbitrary server name → spawn config. Same shape as Claude Code's
  // mcpServers entry, so users can paste configs across tools.
  mcpServers?: Record<string, McpServerConfig>;
  // Verification: the command the harness runs after file edits to check the
  // project. `verifyCommand` overrides the inferred default; `autoVerify`
  // disables the post-edit verification loop when set to false.
  verifyCommand?: string;
  autoVerify?: boolean;
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
