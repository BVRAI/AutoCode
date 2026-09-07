// Adapters that let the ConsoleRenderer sink and the EventEmitter route into
// the BridgeStore instead of stdout. Drop-in: no other code in the project
// needs to know whether the Ink path is active.

import type { BridgeStore, ToolDiff } from './store.js';
import type { EventEmitter } from '../EventEmitter.js';
import type { RendererSink } from '../ConsoleRenderer.js';
import { renderUnifiedDiff } from '../../util/diff.js';
import { ACTIVITY_VERBS, describeCall, verbFor } from './grammar.js';

// Routes ConsoleRenderer writes into the store.
export function createRendererSink(store: BridgeStore): RendererSink {
  // The agent loop still narrates a few things as dim text that the
  // structured rows already show (the "→ tool summary (Nms)" line, hook
  // chatter). Drop those — a rendering choice; --automax still sees them.
  const isNoise = (text: string): boolean => {
    const t = text.trim();
    if (/^-{3,}$/.test(t)) return true;
    if (t.startsWith('→ ')) return true;
    if (t.startsWith('hook[')) return true;
    return false;
  };
  // One activity verb per turn for the status line, Claude Code style.
  let turnSeed = 0;
  return {
    info(text) {
      if (isNoise(text)) return;
      store.appendText('info', text);
    },
    assistant(text) {
      store.commitAssistant(text);
    },
    dim(text) {
      if (isNoise(text)) return;
      // "✗ tool blocked/declined" echoes duplicate the tool row's Error line.
      if (text.trim().startsWith('✗ ')) return;
      store.appendText('info', text);
    },
    warn(text) {
      store.appendText('warn', text);
    },
    error(text) {
      store.appendText('error', text);
    },
    status(text) {
      if (isNoise(text)) return;
      store.appendText('info', text);
    },
    rule() {
      store.appendRule();
    },
    diff(label, before, after) {
      store.attachDiff(label, before, after);
    },
    user(text) {
      store.appendText('user', text);
    },
    assistantChunk(text) {
      store.streamChunk(text);
    },
    thinkingChunk(text) {
      store.thinkingChunk(text);
    },
    thinkingEnd(durationMs) {
      store.thinkingEnd(durationMs);
    },
    turnEnd(info) {
      store.turnEnd(info);
    },
    activity(label) {
      if (label === null) {
        store.setActivity(null);
        return;
      }
      store.setActivity(activityVerb(label, store.get().turn + turnSeed));
      if (label === 'thinking') turnSeed = store.get().turn;
    },
  };
}

/** Map the loop's spinner labels onto Claude-Code-style status verbs. */
export function activityVerb(label: string, seed: number): string {
  const l = label.trim();
  if (l === 'thinking' || l.length === 0) return verbFor(ACTIVITY_VERBS, seed);
  if (l.startsWith('verifying')) return 'Verifying';
  if (l.startsWith('task')) return 'Exploring';
  const known = describeCall(l, {});
  if (known.label !== l) return known.activity;
  return l.charAt(0).toUpperCase() + l.slice(1);
}

// Routes AgentLoop's emit() calls into the store: started → beginTurn;
// tool_call → startTool; tool_result → finishTool; completed/failed → close.
export function createBridgeEventEmitter(
  store: BridgeStore,
  inner?: EventEmitter,
): EventEmitter {
  // Tool rows are opened by tool_call and closed by the matching
  // tool_result. AgentLoop emits them in order for sequential tools; the
  // parallel `task` fan-out emits several tool_calls before their results,
  // so keep a FIFO of open rows keyed by tool name.
  const open: Array<{ id: string; name: string }> = [];

  const closeAll = (status: 'ok' | 'err'): void => {
    for (const o of open) store.closeTool(o.id, status);
    open.length = 0;
  };

  return {
    emit(type, data) {
      try {
        switch (type) {
          case 'started': {
            store.beginTurn();
            store.setBusy(true);
            const task = store.takeUserDisplay() ?? ((data['task'] as string | undefined) ?? '');
            if (task) store.appendText('user', task);
            break;
          }
          case 'tool_call': {
            const name = String(data['name'] ?? 'tool');
            const args = (data['args'] as Record<string, unknown>) ?? {};
            const id = store.startTool(name, args);
            open.push({ id, name });
            break;
          }
          case 'tool_result': {
            const name = String(data['name'] ?? 'tool');
            let idx = open.findIndex((o) => o.name === name);
            if (idx < 0) idx = open.length - 1;
            if (idx >= 0) {
              const [row] = open.splice(idx, 1);
              const durationMs = typeof data['durationMs'] === 'number' ? (data['durationMs'] as number) : undefined;
              store.finishTool(
                row!.id,
                {
                  summary: String(data['summary'] ?? ''),
                  content: String(data['content'] ?? ''),
                  isError: data['isError'] === true,
                  metadata: (data['metadata'] as Record<string, unknown> | undefined) ?? undefined,
                },
                durationMs,
              );
            }
            break;
          }
          case 'file_edit_proposed': {
            const path = String(data['path'] ?? '');
            const summary = String(data['summary'] ?? '');
            store.recordEdit({ file: path, added: 0, deleted: 0, isNew: summary === 'create' || summary === 'mkdir' });
            break;
          }
          case 'completed': {
            closeAll('ok');
            store.setBusy(false);
            store.setThinking(null);
            store.setActivity(null);
            break;
          }
          case 'failed': {
            closeAll('err');
            store.setBusy(false);
            store.setThinking(null);
            store.setActivity(null);
            const err = String(data['error'] ?? 'failed');
            store.appendText('error', err);
            break;
          }
        }
      } catch {
        /* never let a UI bug kill the agent */
      }
      // Pass through to the inner emitter (the --automax JSON stream).
      // `tool_result` is a Bridge-internal UI detail; the host already gets the
      // public tool lifecycle through tool_call/completed/failed.
      if (type !== 'tool_result') inner?.emit(type, data);
    },
  };
}

// Used elsewhere when we want to render a raw unified diff inside a tool card.
export function parseUnifiedDiff(before: string, after: string): ToolDiff[] {
  const out: ToolDiff[] = [];
  for (const raw of renderUnifiedDiff(before, after).split('\n')) {
    if (raw.startsWith('+ ')) out.push({ kind: 'add', text: raw });
    else if (raw.startsWith('- ')) out.push({ kind: 'del', text: raw });
    else if (raw.startsWith('@@')) out.push({ kind: 'hunk', text: raw });
    else out.push({ kind: 'context', text: raw });
  }
  return out;
}
