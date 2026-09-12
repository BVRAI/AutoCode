// Turns the harness's two output channels — the ConsoleRenderer sink (text,
// streaming chunks, diffs, status) and the EventEmitter (turn and tool
// lifecycle) — into protocol items and notifications (Phase 5.1). The same
// role the Ink bridge plays for the terminal, for a host process instead.

import type { RendererSink, TurnEndInfo } from '../repl/ConsoleRenderer.js';
import type { EventEmitter } from '../repl/EventEmitter.js';
import { unifiedDiff } from '../util/diff.js';
import { activityVerb } from '../repl/ink/bridge.js';
import { markAccountingIncomplete } from '../llm/SubmissionAccounting.js';
import { randomUUID } from 'node:crypto';
import { nextPresentation, presentationActive, type PresentationIdentity } from '../repl/PresentationRun.js';

export type Notify = (method: string, params: Record<string, unknown>) => void;

export class ServerSink implements RendererSink, EventEmitter {
  private turnId = '';
  private turnSeq = 0;
  private message: { id: string; text: string } | null = null;
  private reasoning: { id: string; text: string } | null = null;
  private readonly openTools: Array<{ id: string; name: string; toolCallId?: string }> = [];
  private lastToolId: string | null = null;
  private readonly toolItems = new Map<string, string>();

  constructor(private readonly send: Notify, private readonly compactFileMetadata = false) {}

  private notify(method: string, params: Record<string, unknown>): void {
    const item = params['item'] as Record<string, unknown> | undefined;
    if (item && !item['presentation'] && !item['transient']) {
      const toolCallId = typeof item['toolCallId'] === 'string' ? item['toolCallId'] : undefined;
      const presentation = nextPresentation(toolCallId ? { toolCallId } : {});
      if (presentation) params = { ...params, item: { ...item, presentation } };
    }
    this.send(method, params);
  }

  private nextId(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }

  currentTurn(): string {
    return this.turnId;
  }

  // turn.completed / turn.failed are deferred while a turn is held (see
  // AppServer.submit) and sent, at most once, on release.
  private holding = false;
  private terminal: { method: string; params: Record<string, unknown> } | null = null;

  holdTerminal(): void {
    this.holding = true;
    this.terminal = null;
  }

  releaseTerminal(failure?: { turnId: string; error: string }, cancelledTurnId?: string): void {
    this.holding = false;
    const pending = cancelledTurnId ? { method: 'turn.cancelled', params: { turnId: cancelledTurnId } }
      : failure ? { method: 'turn.failed', params: failure } : this.terminal;
    this.terminal = null;
    if (pending) this.notify(pending.method, pending.params);
  }

  private terminalNotify(method: string, params: Record<string, unknown>): void {
    if (this.holding) {
      this.terminal = { method, params };
      return;
    }
    this.notify(method, params);
  }

  beginTurn(turnId?: string): string {
    this.turnSeq += 1;
    this.turnId = turnId ?? `turn_${this.turnSeq}`;
    this.message = null;
    this.reasoning = null;
    this.openTools.length = 0;
    this.toolItems.clear();
    return this.turnId;
  }

  // ── RendererSink ────────────────────────────────────────────────────────

  info(text: string): void {
    this.note('info', text);
  }
  dim(text: string): void {
    // The "→ tool summary" echoes duplicate tool_call items; hook chatter is
    // reported through its own warnings.
    const t = text.trim();
    if (t.startsWith('→ ') || t.startsWith('hook[')) return;
    this.note('info', text);
  }
  warn(text: string): void {
    this.note('warn', text);
  }
  error(text: string): void {
    this.note('error', text);
  }
  status(text: string): void {
    this.note('info', text);
  }
  rule(): void {
    /* no separator items */
  }
  user(text: string): void {
    this.notify('item.completed', { item: { id: this.nextId('user'), type: 'user_message', turnId: this.turnId, text } });
  }
  assistant(text: string): void {
    if (presentationActive()) {
      // A stream can fail, be retried, or contain several final text blocks.
      // Only assistantCommitted publishes text with a durable transcript anchor.
      if (this.message) this.notify('item.completed', { item: {
        id: this.message.id, type: 'agent_message', turnId: this.turnId, text: '', transient: true,
      } });
      this.message = null;
      return;
    }
    // A full message committed at once (non-streaming providers or the end
    // of a stream): complete the streamed item or emit a whole one.
    if (this.message) {
      const item = { id: this.message.id, type: 'agent_message', turnId: this.turnId, text: text || this.message.text };
      this.message = null;
      this.notify('item.completed', { item });
      return;
    }
    if (!text.trim()) return;
    this.notify('item.completed', { item: { id: this.nextId('msg'), type: 'agent_message', turnId: this.turnId, text } });
  }
  assistantCommitted(text: string, presentation: PresentationIdentity): void {
    this.notify('item.completed', { item: {
      id: presentation.messageId, type: 'agent_message', turnId: this.turnId, text, presentation,
    } });
  }
  assistantChunk(text: string): void {
    if (!this.message) {
      this.message = { id: this.nextId('msg'), text: '' };
      this.notify('item.started', { item: { id: this.message.id, type: 'agent_message', turnId: this.turnId, text: '', transient: presentationActive() } });
    }
    this.message.text += text;
    this.notify('item.updated', { item: { id: this.message.id, type: 'agent_message', turnId: this.turnId, delta: text, transient: presentationActive() } });
  }
  thinkingChunk(text: string): void {
    if (!this.reasoning) {
      this.reasoning = { id: this.nextId('think'), text: '' };
      this.notify('item.started', { item: { id: this.reasoning.id, type: 'reasoning', turnId: this.turnId, text: '' } });
    }
    this.reasoning.text += text;
    this.notify('item.updated', { item: { id: this.reasoning.id, type: 'reasoning', turnId: this.turnId, delta: text } });
  }
  thinkingEnd(durationMs: number): void {
    if (!this.reasoning) return;
    const item = { id: this.reasoning.id, type: 'reasoning', turnId: this.turnId, text: this.reasoning.text, durationMs };
    this.reasoning = null;
    this.notify('item.completed', { item });
  }
  diff(label: string, before: string, after: string, provenance?: { toolCallId: string; changeKind: 'created' | 'modified' }): void {
    // New reports must identify the actual tool execution; never guess by name
    // or whichever parallel task happened to finish last.
    if (presentationActive() && !provenance?.toolCallId) return;
    let added = 0;
    let removed = 0;
    const lines: string[] = [];
    let availability = 'available';
    let bytes = 0;
    const append = (line: string): void => {
      bytes += Buffer.byteLength(line, 'utf8') + (lines.length > 0 ? 1 : 0);
      if (bytes <= 2 * 1024 * 1024) lines.push(line);
    };
    try {
      const hunks = unifiedDiff(before, after);
      if (hunks.some(h => h.simplified)) availability = 'simplified';
      for (const h of hunks) {
        append(h.header);
        for (const l of h.lines) {
          if (l.kind === 'add') added += 1;
          else if (l.kind === 'remove') removed += 1;
          const ending = l.kind === 'remove' ? l.oldLineEnding : l.newLineEnding;
          append(`${l.kind === 'add' ? '+' : l.kind === 'remove' ? '-' : ' '}${l.text}${ending === '\r\n' ? '\r' : ''}`);
          if (ending === '') append('\\ No newline at end of file');
        }
      }
      if (bytes > 2 * 1024 * 1024) availability = 'too_large';
    } catch {
      availability = 'unavailable';
      added = 0;
      removed = 0;
    }
    const diff = availability === 'too_large' || availability === 'unavailable' ? '' : lines.join('\n');
    this.notify('item.completed', {
      item: { id: this.nextId('change'), type: 'file_change', turnId: this.turnId, path: label, diff, added, removed,
        availability, changeKind: provenance?.changeKind ?? 'modified', toolCallId: provenance?.toolCallId,
        toolId: provenance ? this.toolItems.get(provenance.toolCallId) ?? null : this.lastToolId },
    });
  }
  turnEnd(info: TurnEndInfo): void {
    this.notify('usage', { turnId: this.turnId, ...info });
  }
  activity(label: string | null): void {
    this.notify('status', { turnId: this.turnId, activity: label === null ? null : activityVerb(label, this.turnSeq), label });
  }

  private note(level: 'info' | 'warn' | 'error', text: string): void {
    if (!text.trim()) return;
    this.notify('log', { turnId: this.turnId, level, text });
  }

  // ── EventEmitter (AgentLoop lifecycle) ─────────────────────────────────

  emit(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case 'started':
        this.notify('turn.started', { turnId: this.turnId, task: data['task'], mode: data['mode'], model: data['model'] });
        return;
      case 'tool_call': {
        const id = this.nextId('tool');
        const name = String(data['name'] ?? 'tool');
        const toolCallId = typeof data['toolCallId'] === 'string' ? data['toolCallId'] : undefined;
        this.openTools.push({ id, name, toolCallId });
        if (toolCallId) this.toolItems.set(toolCallId, id);
        this.lastToolId = id;
        this.notify('item.started', { item: { id, type: 'tool_call', turnId: this.turnId, name, args: data['args'] ?? {}, status: 'running', toolCallId } });
        return;
      }
      case 'tool_result': {
        const name = String(data['name'] ?? 'tool');
        const toolCallId = typeof data['toolCallId'] === 'string' ? data['toolCallId'] : undefined;
        // Older/synthetic activity (e.g. the harness review pass) has no
        // provider tool ID. Its legacy pairing never supplies diff provenance.
        let idx = toolCallId ? this.openTools.findIndex(o => o.toolCallId === toolCallId)
          : this.openTools.findIndex(o => o.name === name && !o.toolCallId);
        if (idx < 0 && !toolCallId && !presentationActive()) idx = this.openTools.length - 1;
        const row = idx >= 0 ? this.openTools.splice(idx, 1)[0]! : { id: this.nextId('tool'), name, toolCallId };
        if (toolCallId) this.toolItems.set(toolCallId, row.id);
        this.lastToolId = row.id;
        let metadata = data['metadata'];
        if (this.compactFileMetadata && metadata && typeof metadata === 'object') {
          metadata = Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'before' && key !== 'after'));
        }
        this.notify('item.completed', {
          item: {
            id: row.id,
            type: 'tool_call',
            turnId: this.turnId,
            name,
            status: data['isError'] === true ? 'error' : 'ok',
            summary: data['summary'],
            content: data['content'],
            durationMs: data['durationMs'],
            metadata,
            toolCallId,
          },
        });
        return;
      }
      case 'file_edit_proposed':
        this.notify('item.completed', { item: { id: this.nextId('edit'), type: 'note', turnId: this.turnId, level: 'info', text: `${data['summary'] ?? 'edit'} ${data['path'] ?? ''}`.trim() } });
        return;
      case 'todo':
        this.notify('item.completed', { item: { id: this.nextId('todo'), type: 'todo', turnId: this.turnId, items: data['items'] ?? [] } });
        return;
      case 'verification':
        this.notify('item.completed', {
          item: { id: this.nextId('verify'), type: 'verification', turnId: this.turnId, command: data['command'], passed: data['passed'] === true, exitCode: data['exitCode'] ?? null, output: data['output'] ?? '' },
        });
        return;
      case 'completed':
        for (const o of this.openTools) this.notify('item.completed', { item: { id: o.id, type: 'tool_call', turnId: this.turnId, name: o.name, status: 'ok', toolCallId: o.toolCallId } });
        this.openTools.length = 0;
        this.terminalNotify('turn.completed', { turnId: this.turnId, summary: data['summary'], filesChanged: data['filesChanged'] ?? [] });
        return;
      case 'failed':
        for (const o of this.openTools) this.notify('item.completed', { item: { id: o.id, type: 'tool_call', turnId: this.turnId, name: o.name, status: 'error', toolCallId: o.toolCallId } });
        this.openTools.length = 0;
        markAccountingIncomplete();
        this.terminalNotify('turn.failed', { turnId: this.turnId, error: data['error'] });
        return;
      case 'picker_opened':
      case 'picker_resolved':
      case 'text_input_opened':
      case 'text_input_resolved':
        return; // requests carry their own notifications (ServerPrompter)
      default:
        this.notify(`event.${type}`, { turnId: this.turnId, ...data });
    }
  }
}
