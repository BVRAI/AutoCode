export interface ModelConfig {
  provider: string;
  model: string;
}

// Workflow modes, cycled with Shift+Tab in the REPL:
//  - planning:  read-only — edits/commands are disabled; the agent plans.
//  - default:   the agent works, but each edit/command is shown for approval.
//  - autocode:  auto-accept — edits/commands apply with no prompt.
export type AgentMode = 'planning' | 'default' | 'autocode';

export interface SessionContext {
  sessionId: string;
  projectRoot: string;
  dataDir: string;
  sessionDir: string;
  model: ModelConfig;
  startedAt: string;
  mode: AgentMode;
}

// Shift+Tab cycle order: default → autocode → planning → default.
export function nextMode(mode: AgentMode): AgentMode {
  switch (mode) {
    case 'default':
      return 'autocode';
    case 'autocode':
      return 'planning';
    case 'planning':
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
