import { createInterface } from 'node:readline';
import pc from 'picocolors';
import { ConfigStore, type AutocodeConfig } from '../auth/ConfigStore.js';
import type { ConsoleRenderer } from './ConsoleRenderer.js';

type Provider = 'anthropic' | 'xai' | 'openai' | 'openrouter';
const PROVIDERS: Provider[] = ['anthropic', 'xai', 'openai', 'openrouter'];

export async function runAuth(renderer: ConsoleRenderer): Promise<void> {
  const provider = await prompt(`Provider [${PROVIDERS.join('|')}]: `);
  if (!provider || !PROVIDERS.includes(provider as Provider)) {
    renderer.error(`Unknown provider: ${provider || '(empty)'}`);
    return;
  }
  const key = await prompt(`API key for ${provider}: `);
  if (!key || key.length < 8) {
    renderer.error('Key too short — refusing to save.');
    return;
  }
  const store = new ConfigStore();
  const config: AutocodeConfig = store.load();
  config.apiKeys = config.apiKeys ?? {};
  config.apiKeys[provider as Provider] = key;
  store.save(config);
  renderer.info(`${pc.green('✓')} Saved ${provider} key to ~/.autocode/config.json`);
  renderer.dim('Restart autocode (/exit then acv1) to use it.');
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
