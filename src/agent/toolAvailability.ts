import { ConfigStore } from '../auth/ConfigStore.js';

// Honor user-facing config flags by removing disabled capabilities from the
// model's tool schema entirely. Tool availability is checked at registry
// construction and when the user toggles a feature mid-session.
export function webToolsEnabled(): boolean {
  try {
    const cfg = new ConfigStore().load();
    return cfg.webTools?.enabled !== false;
  } catch {
    return true;
  }
}

export function computerUseEnabled(): boolean {
  try {
    const cfg = new ConfigStore().load();
    return cfg.computerUse?.enabled === true;
  } catch {
    return false;
  }
}

// AUTOCODE_BENCH_MODE=1 trims tools the agent cannot use in headless
// benchmark runs. Set by autocode-bench's runner-common.ts; never set by V6
// or by real interactive users.
export function benchMode(): boolean {
  return process.env.AUTOCODE_BENCH_MODE === '1';
}

export function guiToolsEnabled(): boolean {
  return !benchMode();
}
