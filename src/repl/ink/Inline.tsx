// Inline.tsx — the flicker-free renderer (the new default).
//
// Append-only model: committed history is printed ONCE into the terminal's
// native scrollback via Ink <Static> and never redrawn; only the small live
// region at the bottom (in-progress tool / thinking → plan → input → status)
// repaints. Nothing above the live region can flicker. Per the Claude Design
// handoff (_context_only/design-upgrades/autocode-tui-design/tui/*).
//
// Ephemerality is enforced at the render layer: a tool that is still running
// is the LAST item and renders LIVE with its streaming body; once finished it
// commits to <Static> as a one-line summary (its text body dropped — only an
// edit/write diff, capped, rides along). The store needs no behavioural change.

import React from 'react';
import { Box, Text, Static } from 'ink';
import { basename } from 'node:path';
import type { BridgeState, ToolEntry, TranscriptItem } from './store.js';
import { useTheme, type Theme } from './theme.js';
import { Spinner } from './spinners.js';
import type { SpinnerId } from './spinners.js';
import { useTerminalSize } from './hooks.js';
import { StatusBar } from './StatusBar.js';
import { PlanPanel } from './PlanPanel.js';

const DIFF_CAP = 24;

export interface InlineProps {
  state: BridgeState;
  input: string;
  cursor: number;
  spinnerId: SpinnerId;
  overlay?: React.ReactNode;
  exitArmed?: boolean;
  projectRoot: string;
  version: string;
  modelProvider: string;
  modelName: string;
}

type WelcomeItem = { id: string; kind: 'welcome' };
type StaticEntry = WelcomeItem | TranscriptItem;

export function Inline(props: InlineProps): React.JSX.Element {
  const t = useTheme();
  const { columns } = useTerminalSize();
  const { state } = props;

  // Split committed (→ Static) from the single in-flight tool (→ live region).
  // The agent runs sequentially, so a running tool is always the last item.
  const items = state.items;
  let committed: TranscriptItem[] = items;
  let liveTool: ToolEntry | null = null;
  const last = items[items.length - 1];
  if (last && last.kind === 'tool' && last.tool && last.tool.status === 'running') {
    committed = items.slice(0, -1);
    liveTool = last.tool;
  }

  const welcome: WelcomeItem = { id: '__welcome__', kind: 'welcome' };
  const staticItems: StaticEntry[] = [welcome, ...committed];

  return (
    <Box flexDirection="column">
      {/* committed history — printed once, never repainted */}
      <Static items={staticItems}>
        {(item) =>
          item.kind === 'welcome' ? (
            <Welcome
              key={item.id}
              t={t}
              version={props.version}
              provider={props.modelProvider}
              model={props.modelName}
              projectRoot={props.projectRoot}
              branch={state.project.branch}
            />
          ) : (
            <Row key={item.id} t={t} item={item} columns={columns} />
          )
        }
      </Static>

      {/* live region — the only part that repaints (≤ ~6 rows) */}
      <Box flexDirection="column" paddingX={1}>
        {liveTool ? (
          <ToolLive t={t} tool={liveTool} spinnerId={props.spinnerId} columns={columns} />
        ) : state.thinking ? (
          <ThinkLine t={t} text={state.thinking} startedAt={state.thinkingStartedAt} spinnerId={props.spinnerId} />
        ) : null}

        <PlanPanel items={state.plan.items} collapsed={state.plan.collapsed} />

        {props.overlay}

        {/* input */}
        <Box marginTop={1}>
          <Text color={t.accent} bold>{'› '}</Text>
          <Text color={t.ink}>{props.input.slice(0, props.cursor)}</Text>
          <Text backgroundColor={t.accent} color={t.cursorInk}>
            {props.input.slice(props.cursor, props.cursor + 1) || ' '}
          </Text>
          <Text color={t.ink}>{props.input.slice(props.cursor + 1)}</Text>
        </Box>

        <StatusBar state={state} columns={columns} />

        <Text color={t.inkFaint}>
          enter send · esc {state.busy ? 'interrupt' : 'clear'} · ^P plan · ↑ history · ^c{' '}
          {props.exitArmed ? 'EXIT' : 'exit (2×)'}
        </Text>
      </Box>
    </Box>
  );
}

// ── committed row dispatch ───────────────────────────────────────────────

function Row({ t, item, columns }: { t: Theme; item: TranscriptItem; columns: number }): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return (
        <Box>
          <Text color={t.accent} bold>{'› '}</Text>
          <Text color={t.ink}>{item.text ?? ''}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1}>
          <Text color={t.agent} bold>{'ac '}</Text>
          <Box flexGrow={1}>
            <Text color={t.ink}>{item.text ?? ''}</Text>
          </Box>
        </Box>
      );
    case 'info':
      return (
        <Box>
          <Text color={t.accent}>{'ℹ '}</Text>
          <Text color={t.inkDim}>{item.text ?? ''}</Text>
        </Box>
      );
    case 'warn':
      return (
        <Box>
          <Text color={t.warn}>{'⚠ '}</Text>
          <Text color={t.warn}>{item.text ?? ''}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box>
          <Text color={t.rose}>{'✗ '}</Text>
          <Text color={t.rose}>{item.text ?? ''}</Text>
        </Box>
      );
    case 'rule':
      return <TurnSep t={t} turn={item.turn} ts={item.ts} columns={columns} />;
    case 'tool':
      return item.tool ? <ToolCommitted t={t} tool={item.tool} columns={columns} /> : <></>;
    case 'diff':
      return item.diff ? <StandaloneDiff t={t} label={item.diff.label} before={item.diff.before} after={item.diff.after} /> : <></>;
    case 'thinking':
    case 'compact':
      return (
        <Box>
          <Text color={t.inkDim}>{item.text ?? ''}</Text>
        </Box>
      );
  }
}

// ── tool cards ───────────────────────────────────────────────────────────

function toolHead(t: Theme, tool: ToolEntry, glyph: string, glyphColor: string, columns: number): React.JSX.Element {
  const nameW = columns <= 80 ? 11 : 13;
  return (
    <Box>
      <Text color={glyphColor}>{glyph} </Text>
      <Text color={t.accent} bold>{pad(tool.name, nameW)}</Text>
      <Box flexGrow={1}>
        <Text color={t.ink}>{truncate(tool.target ?? '', Math.max(8, columns - nameW - 24))}</Text>
      </Box>
      {tool.detail && <Text color={t.inkDim}>{tool.detail} </Text>}
      {tool.endedAt && tool.startedAt && <Text color={t.inkFaint}>{formatDuration(tool.endedAt - tool.startedAt)}</Text>}
    </Box>
  );
}

// Committed: one-line summary + (only) an edit/write diff, capped. The streamed
// text body is intentionally dropped — that's the ephemerality contract.
function ToolCommitted({ t, tool, columns }: { t: Theme; tool: ToolEntry; columns: number }): React.JSX.Element {
  const ok = tool.status !== 'err';
  return (
    <Box flexDirection="column">
      {toolHead(t, tool, ok ? '✓' : '✗', ok ? t.add : t.rose, columns)}
      {tool.diff && tool.diff.length > 0 && <DiffBody t={t} diff={tool.diff} />}
    </Box>
  );
}

// Live: spinner glyph + the full streaming body while the tool runs.
function ToolLive({ t, tool, spinnerId, columns }: { t: Theme; tool: ToolEntry; spinnerId: SpinnerId; columns: number }): React.JSX.Element {
  const elapsed = tool.startedAt ? formatDuration(Date.now() - tool.startedAt) : '';
  const nameW = columns <= 80 ? 11 : 13;
  return (
    <Box flexDirection="column">
      <Box>
        <Spinner id={spinnerId} color={t.amber} />
        <Text> </Text>
        <Text color={t.accent} bold>{pad(tool.name, nameW)}</Text>
        <Box flexGrow={1}>
          <Text color={t.ink}>{truncate(tool.target ?? '', Math.max(8, columns - nameW - 16))}</Text>
        </Box>
        {elapsed && <Text color={t.inkFaint}>{elapsed}</Text>}
      </Box>
      {tool.body && (
        <Box flexDirection="column">
          {tool.body.split('\n').slice(-6).map((line, i) => (
            <Box key={i}>
              <Text color={t.ruleStrong}>{'│ '}</Text>
              <Text color={t.inkDim}>{truncate(line, columns - 4)}</Text>
            </Box>
          ))}
        </Box>
      )}
      {tool.diff && tool.diff.length > 0 && <DiffBody t={t} diff={tool.diff} />}
    </Box>
  );
}

function DiffBody({ t, diff }: { t: Theme; diff: NonNullable<ToolEntry['diff']> }): React.JSX.Element {
  const shown = diff.slice(0, DIFF_CAP);
  return (
    <Box flexDirection="column">
      {shown.map((d, i) => (
        <Box key={i}>
          <Text color={t.ruleStrong}>{'│ '}</Text>
          <Text
            color={d.kind === 'add' ? t.add : d.kind === 'del' ? t.del : d.kind === 'hunk' ? t.accent : t.inkDim}
            backgroundColor={d.kind === 'add' ? t.addBg : d.kind === 'del' ? t.delBg : undefined}
          >
            {d.text}
          </Text>
        </Box>
      ))}
      {diff.length > DIFF_CAP && (
        <Box>
          <Text color={t.ruleStrong}>{'│ '}</Text>
          <Text color={t.inkFaint}>… +{diff.length - DIFF_CAP} more lines</Text>
        </Box>
      )}
    </Box>
  );
}

// ── other atoms ──────────────────────────────────────────────────────────

function Welcome({
  t,
  version,
  provider,
  model,
  projectRoot,
  branch,
}: {
  t: Theme;
  version: string;
  provider: string;
  model: string;
  projectRoot: string;
  branch: string | null;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={t.accent} bold>autocode</Text>
        <Text color={t.inkFaint}> v{version}</Text>
        <Text color={t.inkFaint}>{'  ·  '}</Text>
        <Text color={t.ink}>{provider}/{model}</Text>
        <Text color={t.inkFaint}>{'  ·  '}</Text>
        <Text color={t.inkDim}>{basename(projectRoot)}</Text>
        {branch && (
          <>
            <Text color={t.inkFaint}>{'  '}</Text>
            <Text color={t.inkDim}>⎇ </Text>
            <Text color={t.accent}>{branch}</Text>
          </>
        )}
      </Box>
      <Text color={t.inkFaint}>/help for commands · /model to switch · shift+tab cycles mode</Text>
    </Box>
  );
}

function TurnSep({ t, turn, ts, columns }: { t: Theme; turn: number; ts: number; columns: number }): React.JSX.Element {
  const n = String(turn).padStart(2, '0');
  const time = formatTime(ts);
  const dashes = Math.max(4, Math.min(80, columns - 18));
  return (
    <Box marginTop={1}>
      <Text color={t.inkDim}>── {n} ──</Text>
      <Text color={t.rule}> {'─'.repeat(dashes)} </Text>
      <Text color={t.inkDim}>{time}</Text>
    </Box>
  );
}

function StandaloneDiff({ t, label, before, after }: { t: Theme; label: string; before: string; after: string }): React.JSX.Element {
  if (before === after) return <></>;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={t.inkDim}>{label}</Text>
    </Box>
  );
}

function ThinkLine({ t, text, startedAt, spinnerId }: { t: Theme; text: string; startedAt: number | null; spinnerId: SpinnerId }): React.JSX.Element {
  const elapsed = startedAt ? formatDuration(Date.now() - startedAt) : '';
  return (
    <Box>
      <Spinner id={spinnerId} color={t.accent} />
      <Text> </Text>
      <Text color={t.ink}>{text}</Text>
      {elapsed && <Text color={t.inkFaint}>{'  · '}{elapsed}</Text>}
    </Box>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function truncate(s: string, n: number): string {
  if (n <= 1) return s.slice(0, Math.max(0, n));
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}
