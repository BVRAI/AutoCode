import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionContext } from './SessionContext.js';

export type TranscriptRole = 'user' | 'assistant' | 'system' | 'tool';

export interface TranscriptEntry {
  timestamp: string;
  role: TranscriptRole;
  text?: string;
  toolName?: string;
  toolCallId?: string;
}

export interface ToolLogEntry {
  timestamp: string;
  tool: string;
  arguments: unknown;
  status: 'success' | 'error' | 'blocked' | 'confirmed';
  durationMs: number;
  summary?: string;
  error?: string;
}

export interface SessionState {
  sessionId: string;
  projectRoot: string;
  provider: string;
  model: string;
  createdAt: string;
  lastActiveAt: string;
  currentTask: string | null;
  cancelRequested: boolean;
}

export class TranscriptStore {
  private readonly transcriptPath: string;
  private readonly toolLogPath: string;
  private readonly statePath: string;

  constructor(private readonly ctx: SessionContext) {
    mkdirSync(ctx.sessionDir, { recursive: true });
    this.transcriptPath = join(ctx.sessionDir, 'transcript.jsonl');
    this.toolLogPath = join(ctx.sessionDir, 'tool_log.jsonl');
    this.statePath = join(ctx.sessionDir, 'state.json');
    this.writeState({
      sessionId: ctx.sessionId,
      projectRoot: ctx.projectRoot,
      provider: ctx.model.provider,
      model: ctx.model.model,
      createdAt: ctx.startedAt,
      lastActiveAt: ctx.startedAt,
      currentTask: null,
      cancelRequested: false,
    });
  }

  appendTranscript(entry: Omit<TranscriptEntry, 'timestamp'>): void {
    const line: TranscriptEntry = { timestamp: new Date().toISOString(), ...entry };
    appendFileSync(this.transcriptPath, JSON.stringify(line) + '\n', 'utf8');
  }

  appendToolLog(entry: Omit<ToolLogEntry, 'timestamp'>): void {
    const line: ToolLogEntry = { timestamp: new Date().toISOString(), ...entry };
    appendFileSync(this.toolLogPath, JSON.stringify(line) + '\n', 'utf8');
  }

  writeState(state: SessionState): void {
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  touch(currentTask: string | null = null, cancelRequested = false): void {
    this.writeState({
      sessionId: this.ctx.sessionId,
      projectRoot: this.ctx.projectRoot,
      provider: this.ctx.model.provider,
      model: this.ctx.model.model,
      createdAt: this.ctx.startedAt,
      lastActiveAt: new Date().toISOString(),
      currentTask,
      cancelRequested,
    });
  }

  paths(): { transcript: string; toolLog: string; state: string } {
    return {
      transcript: this.transcriptPath,
      toolLog: this.toolLogPath,
      state: this.statePath,
    };
  }
}
