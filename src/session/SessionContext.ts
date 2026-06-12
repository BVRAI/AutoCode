export interface ModelConfig {
  provider: string;
  model: string;
}

// Workflow modes:
//  - planning:  read-only — edits/commands are disabled; the agent plans.
//  - default:   the agent works, but each edit/command is shown for approval.
//  - autocode:  auto-accept — edits/commands apply with no prompt.
//  - admin:     general computer admin tasks (file ops, scripting, Excel).
//               Same auto-apply gate as `autocode`, but the system prompt
//               is framed for results-not-process work and the post-edit
//               verify-loop is skipped. Reached via `/mode admin` or the
//               `--mode admin` CLI flag (Automax V6 uses this when routing
//               admin tasks). Not in the Shift+Tab cycle — opt-in.
//  - sights:    locked-down static-website builder for Automax V6's Sights
//               workspace. Auto-apply like autocode, but the tool registry
//               is restricted to file ops inside the project root (no shell,
//               no web, no subagents) and the system prompt mandates a fully
//               offline site. CLI-only (`--mode sights`, headless) — not in
//               the Shift+Tab cycle and not accepted by `/mode`.
export type AgentMode = 'planning' | 'default' | 'autocode' | 'admin' | 'sights';

export interface SessionContext {
  sessionId: string;
  projectRoot: string;
  dataDir: string;
  sessionDir: string;
  model: ModelConfig;
  startedAt: string;
  mode: AgentMode;
  // Optional per-invocation sampling + budget controls, set from CLI flags
  // (used by the benchmark harness; absent for normal interactive runs, where
  // the provider sampling default and the built-in iteration cap apply).
  sampling?: { temperature?: number };
  budget?: { maxCostUsd?: number; maxIterations?: number };
}

// Shift+Tab cycle order: default → autocode → planning → default.
// Admin mode is excluded from the cycle on purpose — it's opt-in via
// `/mode admin` (in-session) or `--mode admin` (CLI). When admin is
// active, the next cycle step pops back to `default` so the user can
// rejoin the regular coding loop without typing `/mode default`.
export function nextMode(mode: AgentMode): AgentMode {
  switch (mode) {
    case 'default':
      return 'autocode';
    case 'autocode':
      return 'planning';
    case 'planning':
      return 'default';
    case 'admin':
      return 'default';
    case 'sights':
      return 'default';
  }
}

export function newSessionId(now: Date = new Date()): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return (
    `${now.getUTCFullYear()}` +
    `${pad(now.getUTCMonth() + 1)}` +
    `${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}` +
    `${pad(now.getUTCMinutes())}` +
    `${pad(now.getUTCSeconds())}-` +
    `${Math.random().toString(36).slice(2, 8)}`
  );
}
