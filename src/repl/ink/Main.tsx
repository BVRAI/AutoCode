// Bridge main column — turn headers, conversation, tool cards, diffs,
// spinner thinkline, and the hairline-bordered footer prompt.
// Translated from tui-bridge.jsx:262–536.

import React from 'react';
import { Box, Text } from 'ink';
import { BR } from './theme.js';
import type { BridgeState, ToolEntry, TranscriptItem } from './store.js';
import { Spinner } from './spinners.js';
import type { SpinnerId } from './spinners.js';
import { renderUnifiedDiff } from '../../util/diff.js';

export interface MainProps {
  state: BridgeState;
  input: string;
  cursor: number;
  spinnerId: SpinnerId;
  // Optional slot rendered between the chat region and the footer —
  // used by overlays (model picker, slash menu) so they appear as
  // popups attached to the input area without disturbing the chat layout.
  overlay?: React.ReactNode;
  // True when Ctrl+C has been pressed once and a 3-second window is open
  // for the second press to confirm exit. Surfaced in the footer hint.
  exitArmed?: boolean;
}

export function Main({ state, input, cursor, spinnerId, overlay, exitArmed }: MainProps): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Chat region: takes all remaining height between top of main and
          the footer. justifyContent="flex-end" packs content to the
          bottom — with few messages they sit just above the footer, with
          many the newest pins to the bottom and oldest get clipped off
          the top of the viewport. flexShrink=1 so the container respects
          its parent's height (won't push the footer past the bottom). */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingX={2} paddingY={1} justifyContent="flex-end" overflow="hidden">
        <Transcript
          items={state.items}
          thinking={state.thinking}
          thinkingStartedAt={state.thinkingStartedAt}
          spinnerId={spinnerId}
        />
      </Box>
      {overlay}
      <Footer input={input} cursor={cursor} state={state} exitArmed={exitArmed === true} />
    </Box>
  );
}

// ── transcript ────────────────────────────────────────────────────────

function Transcript({
  items,
  thinking,
  thinkingStartedAt,
  spinnerId,
}: {
  items: TranscriptItem[];
  thinking: string | null;
  thinkingStartedAt: number | null;
  spinnerId: SpinnerId;
}): React.JSX.Element {
  // Group items by turn for "TURN N · time" headers.
  const grouped: Array<{ turn: number; ts: number; items: TranscriptItem[] }> = [];
  for (const it of items) {
    const last = grouped[grouped.length - 1];
    if (last && last.turn === it.turn) {
      last.items.push(it);
    } else {
      grouped.push({ turn: it.turn, ts: it.ts, items: [it] });
    }
  }

  return (
    <Box flexDirection="column">
      {grouped.map((g) => (
        <Box key={`t${g.turn}-${g.ts}`} flexDirection="column">
          {g.turn > 0 && <TurnHeader turn={g.turn} ts={g.ts} />}
          {g.items.map((it) => (
            <Row key={it.id} item={it} />
          ))}
        </Box>
      ))}
      {/* Live thinking indicator: appears INSIDE the transcript stream,
          appended as the last item. With justifyContent="flex-end" on
          the parent, this sits directly under the most recent message
          — exactly where chat apps show the "typing…" indicator. */}
      {thinking && (
        <ThinkLine text={thinking} startedAt={thinkingStartedAt} spinnerId={spinnerId} />
      )}
    </Box>
  );
}

function TurnHeader({ turn, ts }: { turn: number; ts: number }): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text color={BR.inkFaint}>TURN {String(turn).padStart(2, '0')}  </Text>
      <Text color={BR.rule}>{'─'.repeat(40)}  </Text>
      <Text color={BR.inkFaint}>{formatTime(ts)}</Text>
    </Box>
  );
}

function Row({ item }: { item: TranscriptItem }): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return <UserMsg text={item.text ?? ''} />;
    case 'assistant':
      return <AcMsg text={item.text ?? ''} />;
    case 'info':
      return (
        <Box>
          <Text color={BR.ink}>{item.text ?? ''}</Text>
        </Box>
      );
    case 'warn':
      return (
        <Box>
          <Text color={BR.yellow}>{item.text ?? ''}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box>
          <Text color={BR.rose}>{item.text ?? ''}</Text>
        </Box>
      );
    case 'rule':
      return (
        <Box>
          <Text color={BR.rule}>{'─'.repeat(60)}</Text>
        </Box>
      );
    case 'tool':
      return item.tool ? <ToolCard tool={item.tool} /> : <></>;
    case 'diff':
      return item.diff ? <StandaloneDiff label={item.diff.label} before={item.diff.before} after={item.diff.after} /> : <></>;
    case 'thinking':
      // Live thinkline is rendered separately; transcript thinking items
      // are kept around as a record but rendered dim.
      return (
        <Box>
          <Text color={BR.inkDim}>{item.text ?? ''}</Text>
        </Box>
      );
    case 'compact':
      return (
        <Box>
          <Text color={BR.inkDim}>{item.text ?? ''}</Text>
        </Box>
      );
  }
}

function UserMsg({ text }: { text: string }): React.JSX.Element {
  return (
    <Box>
      <Text color={BR.teal} bold>{'> '}</Text>
      <Box flexGrow={1}>
        <Text color={BR.ink}>{text}</Text>
      </Box>
    </Box>
  );
}

function AcMsg({ text }: { text: string }): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text color={BR.violet} bold>{'ac '}</Text>
      <Box flexGrow={1}>
        <Text color={BR.ink}>{text}</Text>
      </Box>
    </Box>
  );
}

// ── tool card (bordered, status icon, optional body + diff) ───────────

function ToolCard({ tool }: { tool: ToolEntry }): React.JSX.Element {
  const statusColor =
    tool.status === 'ok' ? BR.add : tool.status === 'err' ? BR.rose : BR.amber;
  const statusGlyph = tool.status === 'ok' ? '✓' : tool.status === 'err' ? '✗' : '⠿';
  const duration =
    tool.endedAt && tool.startedAt
      ? formatDuration(tool.endedAt - tool.startedAt)
      : '';

  return (
    <Box marginLeft={3} marginTop={1} flexDirection="column" borderStyle="single" borderColor={BR.rule}>
      <Box paddingX={1}>
        <Text color={statusColor}>{statusGlyph} </Text>
        <Text color={BR.teal} bold>{tool.name}</Text>
        {tool.target && <Text color={BR.ink}>  {tool.target}</Text>}
        {tool.detail && <Text color={BR.inkDim}>  · {tool.detail}</Text>}
        <Box flexGrow={1}>
          <Text> </Text>
        </Box>
        {duration && <Text color={BR.inkFaint}>{duration}</Text>}
      </Box>
      {(tool.body || (tool.diff && tool.diff.length > 0)) && (
        <Box paddingX={1} flexDirection="column" borderStyle="single" borderColor={BR.rule} borderBottom={false} borderLeft={false} borderRight={false}>
          {tool.body && <Text color={BR.inkDim}>{tool.body}</Text>}
          {tool.diff && tool.diff.length > 0 && (
            <Box flexDirection="column">
              {tool.diff.slice(0, 24).map((d, i) => (
                <Text
                  key={i}
                  color={d.kind === 'add' ? BR.add : d.kind === 'del' ? BR.del : d.kind === 'hunk' ? BR.teal : BR.inkDim}
                >
                  {d.text}
                </Text>
              ))}
              {tool.diff.length > 24 && (
                <Text color={BR.inkFaint}>… +{tool.diff.length - 24} more lines</Text>
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

// Stand-alone diff (rendered outside a tool card, e.g. for `/diff` command).
function StandaloneDiff({ label, before, after }: { label: string; before: string; after: string }): React.JSX.Element {
  if (before === after) return <></>;
  const out = renderUnifiedDiff(before, after);
  if (out === '(no textual change)') return <></>;
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color={BR.inkDim}>{label}</Text>
      {out.split('\n').slice(0, 40).map((raw, i) => {
        const color =
          raw.startsWith('+ ') ? BR.add :
          raw.startsWith('- ') ? BR.del :
          raw.startsWith('@@') ? BR.teal :
          BR.inkDim;
        return <Text key={i} color={color}>{raw}</Text>;
      })}
    </Box>
  );
}

// ── live spinner line ─────────────────────────────────────────────────

function ThinkLine({ text, startedAt, spinnerId }: { text: string; startedAt: number | null; spinnerId: SpinnerId }): React.JSX.Element {
  const elapsed = startedAt ? formatDuration(Date.now() - startedAt) : '';
  return (
    <Box marginLeft={3} marginTop={1}>
      <Spinner id={spinnerId} color={BR.teal} />
      <Text>  </Text>
      <Text color={BR.ink}>{text}</Text>
      {elapsed && <Text color={BR.inkFaint}>  · {elapsed}</Text>}
    </Box>
  );
}

// ── footer (hairline rule + prompt + status hint) ─────────────────────

function Footer({ input, cursor, state, exitArmed }: { input: string; cursor: number; state: BridgeState; exitArmed: boolean }): React.JSX.Element {
  const modeColor =
    state.mode === 'planning' ? BR.yellow :
    state.mode === 'autocode' ? BR.add :
    state.mode === 'admin' ? BR.violet :
    BR.teal;

  // Render the input with a cursor block at `cursor`. Cursor is shown as
  // a teal block on the character it points at (or after the text).
  const before = input.slice(0, cursor);
  const at = input.slice(cursor, cursor + 1) || ' ';
  const after = input.slice(cursor + 1);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={BR.rule} borderLeft={false} borderRight={false} borderBottom={false} paddingX={2} paddingY={1}>
      <Box>
        <Text color={BR.teal} bold>{'=> '}</Text>
        <Text color={BR.ink}>{before}</Text>
        <Text backgroundColor={BR.teal} color={BR.bg}>{at}</Text>
        <Text color={BR.ink}>{after}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={modeColor}>▸ {state.mode}</Text>
        {state.queueDepth > 0 && <Text color={BR.inkDim}>  ·  {state.queueDepth} queued</Text>}
        {state.busy && <Text color={BR.amber}>  ·  busy</Text>}
        {exitArmed && <Text color={BR.amber} bold>  ·  press ^C again to exit</Text>}
        <Box flexGrow={1}><Text> </Text></Box>
        <Text color={BR.inkFaint}>
          enter send · esc {state.busy ? 'interrupt' : 'clear'} · ↑ history · ^c {exitArmed ? 'EXIT' : 'exit (2×)'}
        </Text>
      </Box>
    </Box>
  );
}

// ── helpers ───────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}
