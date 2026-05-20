import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionContext } from './SessionContext.js';
import type { Message } from '../llm/types.js';

export interface CumulativeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const CONVERSATION_VERSION = 1;

interface ConversationFile {
  version: number;
  updatedAt: string;
  messages: Message[];
  usage: CumulativeUsage;
}

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
  private readonly conversationPath: string;

  constructor(private readonly ctx: SessionContext) {
    mkdirSync(ctx.sessionDir, { recursive: true });
    this.transcriptPath = join(ctx.sessionDir, 'transcript.jsonl');
    this.toolLogPath = join(ctx.sessionDir, 'tool_log.jsonl');
    this.statePath = join(ctx.sessionDir, 'state.json');
    this.conversationPath = join(ctx.sessionDir, 'conversation.json');
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

  // Full-fidelity conversation snapshot for session resume. Unlike
  // transcript.jsonl (text-only), this keeps tool_use/tool_result blocks so
  // a resumed session sees exactly what the agent saw. Overwritten each turn.
  saveConversation(messages: Message[], usage: CumulativeUsage): void {
    const file: ConversationFile = {
      version: CONVERSATION_VERSION,
      updatedAt: new Date().toISOString(),
      messages,
      usage,
    };
    writeFileSync(this.conversationPath, JSON.stringify(file, null, 2), 'utf8');
  }

  loadConversation(): { messages: Message[]; usage: CumulativeUsage } | null {
    if (!existsSync(this.conversationPath)) return null;
    try {
      const file = JSON.parse(readFileSync(this.conversationPath, 'utf8')) as ConversationFile;
      if (file.version !== CONVERSATION_VERSION || !Array.isArray(file.messages)) return null;
      const usage: CumulativeUsage = {
        inputTokens: file.usage?.inputTokens ?? 0,
        outputTokens: file.usage?.outputTokens ?? 0,
        cacheReadTokens: file.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: file.usage?.cacheWriteTokens ?? 0,
      };
      return { messages: file.messages, usage };
    } catch {
      return null;
    }
  }

  paths(): { transcript: string; toolLog: string; state: string; conversation: string } {
    return {
      transcript: this.transcriptPath,
      toolLog: this.toolLogPath,
      state: this.statePath,
      conversation: this.conversationPath,
    };
  }
}
