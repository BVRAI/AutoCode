// Bridge main column — turn headers, conversation, tool cards, diffs,
// spinner thinkline, and the hairline-bordered footer prompt.
// Translated from tui-bridge.jsx:262–536.

import React from 'react';
import { Box, Text } from 'ink';
import { BR } from './theme.js';
import type { BridgeState, ToolEntry, TranscriptItem } from './store.js';
import { Spinner } from './spinners.js';
import type { SpinnerId } from './spinners.js';
import { Markdown } from './Markdown.js';
import { renderUnifiedDiff } from '../../util/diff.js';

export interface MainProps {
  state: BridgeState;
  input: string;
  cursor: number;
  spinnerId: SpinnerId;
  rows?: number;
  columns?: number;
  scrollOffset?: number;
  maxScrollOffset?: number;
  // Optional slot rendered between the chat region and the footer —
  // used by overlays (model picker, slash menu) so they appear as
  // popups attached to the input area without disturbing the chat layout.
  overlay?: React.ReactNode;
  // True when Ctrl+C has been pressed once and a 3-second window is open
  // for the second press to confirm exit. Surfaced in the footer hint.
  exitArmed?: boolean;
}

export function Main({
  state,
  input,
  cursor,
  spinnerId,
  overlay,
  exitArmed,
  rows = 30,
  columns = 100,
  scrollOffset = 0,
  maxScrollOffset = 0,
}: MainProps): React.JSX.Element {
  const footerRows = 5;
  const transcriptRowBudget = Math.max(4, rows - footerRows - 2);
  const transcriptWidth = Math.max(32, columns - 4);
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} width={columns}>
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
          rowBudget={transcriptRowBudget}
          width={transcriptWidth}
          scrollOffset={scrollOffset}
        />
      </Box>
      {overlay}
      <Footer
        input={input}
        cursor={cursor}
        state={state}
        exitArmed={exitArmed === true}
        width={columns}
        scrollOffset={scrollOffset}
        maxScrollOffset={maxScrollOffset}
      />
    </Box>
  );
}

// ── transcript ────────────────────────────────────────────────────────

function Transcript({
  items,
  thinking,
  thinkingStartedAt,
  spinnerId,
  rowBudget,
  width,
  scrollOffset,
}: {
  items: TranscriptItem[];
  thinking: string | null;
  thinkingStartedAt: number | null;
  spinnerId: SpinnerId;
  rowBudget: number;
  width: number;
  scrollOffset: number;
}): React.JSX.Element {
  // Group items by turn for "TURN N · time" headers.
  const visibleThinking = scrollOffset === 0 ? thinking : null;
  const visibleItems = selectVisibleItems(
    items,
    scrollOffset,
    Math.max(2, rowBudget - (visibleThinking ? 2 : 0)),
    width,
  );
  const grouped: Array<{ turn: number; ts: number; items: TranscriptItem[] }> = [];
  for (const it of visibleItems) {
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
            <Row key={it.id} item={it} width={width} />
          ))}
        </Box>
      ))}
      {/* Live thinking indicator: appears INSIDE the transcript stream,
          appended as the last item. With justifyContent="flex-end" on
          the parent, this sits directly under the most recent message
          — exactly where chat apps show the "typing…" indicator. */}
      {visibleThinking && (
        <ThinkLine text={visibleThinking} startedAt={thinkingStartedAt} spinnerId={spinnerId} />
      )}
    </Box>
  );
}

function selectVisibleItems(
  items: TranscriptItem[],
  scrollOffset: number,
  rowBudget: number,
  width: number,
): TranscriptItem[] {
  if (items.length === 0) return [];
  const safeOffset = Math.max(0, Math.min(scrollOffset, items.length - 1));
  const end = Math.max(1, items.length - safeOffset);
  let start = end - 1;
  for (let nextStart = end - 1; nextStart >= 0; nextStart--) {
    const nextItems = items.slice(nextStart, end);
    const nextRows = estimateRenderedRows(nextItems, width);
    if (nextRows > rowBudget && nextItems.length > 1) break;
    start = nextStart;
  }
  return items.slice(start, end);
}

function estimateRenderedRows(items: TranscriptItem[], width: number): number {
  let rows = 0;
  let previousTurn: number | null = null;
  for (const item of items) {
    if (item.turn > 0 && item.turn !== previousTurn) rows += 2;
    rows += estimateItemRows(item, width);
    previousTurn = item.turn;
  }
  return rows;
}

function estimateItemRows(item: TranscriptItem, width: number): number {
  switch (item.kind) {
    case 'user':
      return estimateWrappedRows(item.text ?? '', Math.max(8, width - 2));
    case 'assistant':
      return 1 + estimateWrappedRows(item.text ?? '', Math.max(8, width - 3));
    case 'tool':
      return item.tool ? estimateToolRows(item.tool) : 0;
    case 'diff':
      return item.diff && item.diff.before !== item.diff.after ? 41 : 0;
    case 'rule':
    case 'info':
    case 'warn':
    case 'error':
    case 'thinking':
    case 'compact':
    case 'turn_end':
      return estimateWrappedRows(item.text ?? '', width);
  }
}

function estimateToolRows(tool: ToolEntry): number {
  const bodyLines = tool.body ? splitDisplayLines(tool.body, 18).length : 0;
  const diffLines = tool.diff ? Math.min(tool.diff.length, 24) + (tool.diff.length > 24 ? 1 : 0) : 0;
  const detailRows = bodyLines + diffLines;
  return 1 + 3 + (detailRows > 0 ? 1 + detailRows : 0);
}

function estimateWrappedRows(text: string, width: number): number {
  const safeWidth = Math.max(1, width);
  const lines = text.length > 0 ? text.split(/\r?\n/) : [''];
  return lines.reduce((total, line) => total + Math.max(1, Math.ceil(line.length / safeWidth)), 0);
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

function Row({ item, width }: { item: TranscriptItem; width: number }): React.JSX.Element {
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
      return item.tool ? <ToolCard tool={item.tool} width={Math.max(24, width - 3)} /> : <></>;
    case 'diff':
      return item.diff ? <StandaloneDiff label={item.diff.label} before={item.diff.before} after={item.diff.after} /> : <></>;
    case 'thinking':
      // Live thinkline is rendered separately; transcript thinking items
      // are kept around as a record but rendered dim.
      return (
        <Box>
          <Text color={BR.inkDim}>
            {item.text ?? (item.durationMs !== undefined ? `✻ Thought for ${formatDuration(item.durationMs)}` : '')}
          </Text>
        </Box>
      );
    case 'turn_end':
      return (
        <Box>
          <Text color={BR.inkDim}>✻ Worked for {formatDuration(item.durationMs ?? 0)}</Text>
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
        <Text color={BR.ink} wrap="hard">{text}</Text>
      </Box>
    </Box>
  );
}

function AcMsg({ text }: { text: string }): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text color={BR.violet} bold>{'ac '}</Text>
      <Box flexGrow={1}>
        <Markdown text={text} />
      </Box>
    </Box>
  );
}

// ── tool card (bordered, status icon, optional body + diff) ───────────

function ToolCard({ tool, width }: { tool: ToolEntry; width: number }): React.JSX.Element {
  const statusColor =
    tool.status === 'ok' ? BR.add : tool.status === 'err' ? BR.rose : BR.amber;
  const statusGlyph = tool.status === 'ok' ? '✓' : tool.status === 'err' ? '✗' : '⠿';
  const duration =
    tool.endedAt && tool.startedAt
      ? formatDuration(tool.endedAt - tool.startedAt)
      : '';
  const cardWidth = Math.max(24, width);
  const headerWidth = Math.max(8, cardWidth - 4);
  const durationWidth = duration.length > 0 ? duration.length + 3 : 0;
  const nameWidth = Math.min(tool.name.length, Math.max(6, headerWidth - durationWidth - 3));
  const meta = [tool.target, tool.detail ? `· ${tool.detail}` : null].filter(Boolean).join('  ');
  const metaWidth = Math.max(0, headerWidth - 2 - nameWidth - durationWidth);
  const bodyWidth = Math.max(8, cardWidth - 4);
  const bodyLines = tool.body ? splitDisplayLines(tool.body, 18) : [];

  return (
    <Box
      width={cardWidth}
      minHeight={3}
      flexShrink={0}
      marginLeft={3}
      marginTop={1}
      flexDirection="column"
      borderStyle="single"
      borderColor={BR.rule}
    >
      <Box paddingX={1} height={1} flexShrink={0}>
        <Text color={statusColor}>{statusGlyph} </Text>
        <Box width={nameWidth}>
          <Text color={BR.teal} bold wrap="truncate-end">{tool.name}</Text>
        </Box>
        {meta && metaWidth > 0 && (
          <Box width={metaWidth}>
            <Text color={BR.inkDim} wrap="truncate-end">  {meta}</Text>
          </Box>
        )}
        <Box flexGrow={1}>
          <Text> </Text>
        </Box>
        {duration && <Text color={BR.inkFaint}> {duration} </Text>}
      </Box>
      {(bodyLines.length > 0 || (tool.diff && tool.diff.length > 0)) && (
        <Box paddingX={1} flexDirection="column" borderStyle="single" borderColor={BR.rule} borderBottom={false} borderLeft={false} borderRight={false}>
          {bodyLines.map((line, i) => (
            <Box key={`b${i}`} width={bodyWidth}>
              <Text color={BR.inkDim} wrap="truncate-end">{line}</Text>
            </Box>
          ))}
          {tool.diff && tool.diff.length > 0 && (
            <Box flexDirection="column">
              {tool.diff.slice(0, 24).map((d, i) => (
                <Box key={i} width={bodyWidth}>
                  <Text
                    color={d.kind === 'add' ? BR.add : d.kind === 'del' ? BR.del : d.kind === 'hunk' ? BR.teal : BR.inkDim}
                    wrap="truncate-end"
                  >
                    {d.text}
                  </Text>
                </Box>
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

function Footer({
  input,
  cursor,
  state,
  exitArmed,
  width,
  scrollOffset,
  maxScrollOffset,
}: {
  input: string;
  cursor: number;
  state: BridgeState;
  exitArmed: boolean;
  width: number;
  scrollOffset: number;
  maxScrollOffset: number;
}): React.JSX.Element {
  const modeColor =
    state.mode === 'planning' ? BR.yellow :
    state.mode === 'autocode' ? BR.add :
    state.mode === 'admin' ? BR.violet :
    BR.teal;

  // Render the input with a cursor block at `cursor`. Cursor is shown as
  // a teal block on the character it points at (or after the text).
  const visible = visibleInput(input, cursor, Math.max(8, width - 7));
  const before = visible.text.slice(0, visible.cursor);
  const at = visible.text.slice(visible.cursor, visible.cursor + 1) || ' ';
  const after = visible.text.slice(visible.cursor + 1);

  return (
    <Box flexDirection="column" flexShrink={0} height={5} borderStyle="single" borderColor={BR.rule} borderLeft={false} borderRight={false} borderBottom={false} paddingX={2}>
      <Box height={1} flexShrink={0}>
        <Text color={BR.teal} bold>{'=> '}</Text>
        <Text color={BR.ink} wrap="truncate-end">{before}</Text>
        <Text backgroundColor={BR.teal} color={BR.bg}>{at}</Text>
        <Text color={BR.ink} wrap="truncate-end">{after}</Text>
      </Box>
      <Box flexGrow={1}><Text> </Text></Box>
      <Box height={1} flexShrink={0}>
        <Text color={modeColor}>▸ {state.mode}</Text>
        {scrollOffset > 0 && <Text color={BR.amber}>  ·  history {Math.min(scrollOffset, maxScrollOffset)}/{maxScrollOffset}</Text>}
        {state.queueDepth > 0 && <Text color={BR.inkDim}>  ·  {state.queueDepth} queued</Text>}
        {state.busy && <Text color={BR.amber}>  ·  busy</Text>}
        {exitArmed && <Text color={BR.amber} bold>  ·  press ^C again to exit</Text>}
        <Box flexGrow={1}><Text> </Text></Box>
        <Text color={BR.inkFaint} wrap="truncate-start">
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

function splitDisplayLines(text: string, maxLines: number): string[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length <= maxLines) return lines;
  return [
    ...lines.slice(0, maxLines),
    `... +${lines.length - maxLines} more line${lines.length - maxLines === 1 ? '' : 's'}`,
  ];
}

function visibleInput(input: string, cursor: number, maxWidth: number): { text: string; cursor: number } {
  const safeCursor = Math.max(0, Math.min(cursor, input.length));
  if (input.length <= maxWidth) return { text: input, cursor: safeCursor };

  const marker = '...';
  const sliceWidth = Math.max(1, maxWidth - marker.length * 2);
  let start = Math.max(0, safeCursor - Math.floor(sliceWidth / 2));
  start = Math.min(start, Math.max(0, input.length - sliceWidth));
  const end = Math.min(input.length, start + sliceWidth);
  const prefix = start > 0 ? marker : '';
  const suffix = end < input.length ? marker : '';
  const text = prefix + input.slice(start, end) + suffix;
  const visibleCursor = prefix.length + Math.max(0, Math.min(safeCursor - start, end - start));
  return { text, cursor: Math.min(visibleCursor, text.length) };
}
