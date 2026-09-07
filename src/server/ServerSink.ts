// Turns the harness's two output channels — the ConsoleRenderer sink (text,
// streaming chunks, diffs, status) and the EventEmitter (turn and tool
// lifecycle) — into protocol items and notifications (Phase 5.1). The same
// role the Ink bridge plays for the terminal, for a host process instead.

import type { RendererSink, TurnEndInfo } from '../repl/ConsoleRenderer.js';
import type { EventEmitter } from '../repl/EventEmitter.js';
import { unifiedDiff } from '../util/diff.js';
import { activityVerb } from '../repl/ink/bridge.js';

export type Notify = (method: string, params: Record<string, unknown>) => void;

export class ServerSink implements RendererSink, EventEmitter {
  private seq = 0;
  private turnId = '';
  private turnSeq = 0;
  private message: { id: string; text: string } | null = null;
  private reasoning: { id: string; text: string } | null = null;
  private readonly openTools: Array<{ id: string; name: string }> = [];
  private lastToolId: string | null = null;

  constructor(private readonly notify: Notify) {}

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
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

  releaseTerminal(failure?: { turnId: string; error: string }): void {
    this.holding = false;
    const pending = failure ? { method: 'turn.failed', params: failure } : this.terminal;
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
  assistantChunk(text: string): void {
    if (!this.message) {
      this.message = { id: this.nextId('msg'), text: '' };
      this.notify('item.started', { item: { id: this.message.id, type: 'agent_message', turnId: this.turnId, text: '' } });
    }
    this.message.text += text;
    this.notify('item.updated', { item: { id: this.message.id, type: 'agent_message', turnId: this.turnId, delta: text } });
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
  diff(label: string, before: string, after: string): void {
    const hunks = unifiedDiff(before, after);
    let added = 0;
    let removed = 0;
    const lines: string[] = [];
    for (const h of hunks) {
      lines.push(h.header);
      for (const l of h.lines) {
        if (l.kind === 'add') added += 1;
        else if (l.kind === 'remove') removed += 1;
        lines.push(`${l.kind === 'add' ? '+' : l.kind === 'remove' ? '-' : ' '}${l.text}`);
      }
    }
    this.notify('item.completed', {
      item: { id: this.nextId('change'), type: 'file_change', turnId: this.turnId, path: label, diff: lines.join('\n'), added, removed, toolId: this.lastToolId },
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
        this.openTools.push({ id, name });
        this.lastToolId = id;
        this.notify('item.started', { item: { id, type: 'tool_call', turnId: this.turnId, name, args: data['args'] ?? {}, status: 'running' } });
        return;
      }
      case 'tool_result': {
        const name = String(data['name'] ?? 'tool');
        let idx = this.openTools.findIndex((o) => o.name === name);
        if (idx < 0) idx = this.openTools.length - 1;
        const row = idx >= 0 ? this.openTools.splice(idx, 1)[0]! : { id: this.nextId('tool'), name };
        this.lastToolId = row.id;
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
            metadata: data['metadata'],
          },
        });
        return;
      }
      case 'file_edit_proposed':
        this.notify('item.completed', { item: { id: this.nextId('edit'), type: 'note', turnId: this.turnId, level: 'info', text: `${data['summary'] ?? 'edit'} ${data['path'] ?? ''}`.trim() } });
        return;
      case 'completed':
        for (const o of this.openTools) this.notify('item.completed', { item: { id: o.id, type: 'tool_call', turnId: this.turnId, name: o.name, status: 'ok' } });
        this.openTools.length = 0;
        this.terminalNotify('turn.completed', { turnId: this.turnId, summary: data['summary'], filesChanged: data['filesChanged'] ?? [] });
        return;
      case 'failed':
        for (const o of this.openTools) this.notify('item.completed', { item: { id: o.id, type: 'tool_call', turnId: this.turnId, name: o.name, status: 'error' } });
        this.openTools.length = 0;
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
