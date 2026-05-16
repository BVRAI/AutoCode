export interface ModelConfig {
  provider: string;
  model: string;
}

export interface SessionContext {
  sessionId: string;
  projectRoot: string;
  dataDir: string;
  sessionDir: string;
  model: ModelConfig;
  startedAt: string;
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
