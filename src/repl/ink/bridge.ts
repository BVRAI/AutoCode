// Adapters that let the existing ConsoleRenderer and EventEmitter route
// into the BridgeStore instead of stdout. Drop-in: no other code in the
// project needs to know whether the Ink path is active.

import type { BridgeStore } from './store.js';
import type { ToolDiff } from './store.js';
import type { EventEmitter } from '../EventEmitter.js';
import type { RendererSink } from '../ConsoleRenderer.js';
import { renderUnifiedDiff } from '../../util/diff.js';

// Routes ConsoleRenderer writes into the store.
export function createRendererSink(store: BridgeStore): RendererSink {
  // The agent loop narrates tool execution as dim/info text: a shell-command
  // preview block, a "→ tool summary (Nms)" result line, hook chatter. The
  // structured tool cards (from tool_call/completed events) already represent
  // each tool, so surfacing this text too would double everything. Drop it —
  // purely a rendering choice; the agent still emits it (and --automax sees it).
  let inPreview = false;
  const isNoise = (text: string): boolean => {
    const t = text.trim();
    if (t === '--- preview ---') {
      inPreview = true;
      return true;
    }
    if (/^-{3,}$/.test(t)) {
      inPreview = false;
      return true; // closing rule of the preview block
    }
    if (inPreview) return true; // the echoed command between the markers
    if (t.startsWith('→ ')) return true; // tool result summary (the card shows it)
    if (t.startsWith('hook[')) return true; // pre-hook chatter
    return false;
  };
  return {
    info(text) {
      if (isNoise(text)) return;
      store.appendText('info', text);
    },
    assistant(text) {
      store.appendText('assistant', text);
    },
    dim(text) {
      if (isNoise(text)) return;
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
      store.appendDiff(label, before, after);
    },
    user(text) {
      store.appendText('user', text);
    },
  };
}

// Routes AgentLoop's emit() calls into the store: tool_call → startTool;
// completed/failed → finishTool; file_edit_proposed → recordEdit.
export function createBridgeEventEmitter(
  store: BridgeStore,
  inner?: EventEmitter,
): EventEmitter {
  // Track which tool we just started so completed/failed can finish it.
  // AgentLoop emits in a strict order: one tool_call → tool runs → next
  // tool_call. We track the most recent tool id; if events arrive out of
  // order we just abandon the unmatched one.
  let openToolId: string | null = null;

  return {
    emit(type, data) {
      try {
        switch (type) {
          case 'started': {
            store.beginTurn();
            store.setBusy(true);
            const task = (data['task'] as string | undefined) ?? '';
            if (task) store.appendText('user', task);
            break;
          }
          case 'tool_call': {
            // Finish the previously-open tool first: the agent loop emits only
            // one 'completed' per turn, so without this every tool except the
            // last would stay stuck in the running state.
            if (openToolId) {
              store.finishTool(openToolId, 'ok');
              openToolId = null;
            }
            const name = String(data['name'] ?? 'tool');
            const args = (data['args'] as Record<string, unknown>) ?? {};
            const target = pickTarget(args);
            openToolId = store.startTool(name, target);
            break;
          }
          case 'file_edit_proposed': {
            const path = String(data['path'] ?? '');
            const summary =
              (data['summary'] as { added?: number; deleted?: number; isNew?: boolean }) ?? {};
            store.recordEdit({
              file: path,
              added: summary.added ?? 0,
              deleted: summary.deleted ?? 0,
              isNew: summary.isNew ?? false,
            });
            break;
          }
          case 'completed': {
            if (openToolId) {
              store.finishTool(openToolId, 'ok');
              openToolId = null;
            }
            store.setBusy(false);
            store.setThinking(null);
            // Usage totals come through here as well.
            const u = data['usage'] as
              | { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number }
              | undefined;
            if (u) {
              store.setUsage({
                inputTokens: u.inputTokens ?? 0,
                outputTokens: u.outputTokens ?? 0,
                cacheReadTokens: u.cacheReadTokens ?? 0,
                cacheWriteTokens: u.cacheWriteTokens ?? 0,
                costUsd: u.costUsd ?? 0,
              });
            }
            break;
          }
          case 'failed': {
            if (openToolId) {
              store.finishTool(openToolId, 'err');
              openToolId = null;
            }
            store.setBusy(false);
            store.setThinking(null);
            const err = String(data['error'] ?? 'failed');
            store.appendText('error', err);
            break;
          }
        }
      } catch {
        /* never let a UI bug kill the agent */
      }
      // Pass through to inner emitter (e.g. --automax JSON) if present.
      inner?.emit(type, data);
    },
  };
}

function pickTarget(args: Record<string, unknown>): string | undefined {
  for (const k of ['path', 'file', 'target', 'filepath', 'file_path', 'command', 'pattern', 'query', 'url', 'name']) {
    const v = args[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
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
