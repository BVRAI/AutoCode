// StatusBar — the one-line status row in the inline live region (replaces the
// cockpit rail). Responsive: fields drop right-to-left as the terminal narrows
// (cost / mode / ctx% / model never drop). Glyphs fall back to ASCII on plain
// terminals. Per the Claude Design spec (tui/inline-mode.jsx + catalogue.jsx).

import React from 'react';
import { Box, Text } from 'ink';
import type { BridgeState } from './store.js';
import { useTheme, type Theme } from './theme.js';
import { glyphs } from './glyphs.js';

function modeColor(t: Theme, mode: BridgeState['mode']): string {
  switch (mode) {
    case 'planning':
      return t.warn;
    case 'autocode':
      return t.add;
    case 'admin':
      return t.agent;
    default:
      return t.accent;
  }
}

function Sep({ t }: { t: Theme }): React.JSX.Element {
  return <Text color={t.inkFaint}>{'  ·  '}</Text>;
}

function CtxBar({ t, pct, cells, showGlyphs }: { t: Theme; pct: number; cells: number; showGlyphs: boolean }): React.JSX.Element {
  const g = glyphs();
  const clamped = Math.max(0, Math.min(1, pct));
  const filled = Math.round(cells * clamped);
  const color = clamped >= 0.95 ? t.rose : clamped >= 0.8 ? t.warn : t.accent;
  const pctText = `${Math.round(clamped * 100)}%`;
  if (!showGlyphs) return <Text color={color}>{pctText}</Text>;
  return (
    <Text>
      <Text color={color}>{g.barFull.repeat(filled)}</Text>
      <Text color={t.ruleStrong}>{g.barEmpty.repeat(cells - filled)}</Text>
      <Text color={clamped >= 0.8 ? color : t.inkDim}> {pctText}</Text>
    </Text>
  );
}

export function StatusBar({ state, columns }: { state: BridgeState; columns: number }): React.JSX.Element {
  const t = useTheme();
  const g = glyphs();
  const mode = state.mode;
  const provider = state.model.provider;
  const model = state.model.name || '(no model)';
  const branch = state.project.branch;
  const dirty = state.project.dirty;
  const edits = state.editsThisTurn.length;
  const mcpUp = state.mcpStatus.filter((m) => m.connected).length;
  const window = state.usage.contextWindow > 0 ? state.usage.contextWindow : 200_000;
  const pct = state.usage.currentContextTokens / window;
  const cost = state.usage.costUsd;

  const showProvider = columns > 100 && provider.length > 0;
  const showEdits = columns > 90 && edits > 0;
  const showMcp = columns > 90 && state.mcpStatus.length > 0;
  const ctxGlyphs = columns > 70;
  const ctxCells = columns >= 110 ? 6 : 4;
  const modePrefix = g.mode ? `${g.mode}` : '';

  return (
    <Box>
      <Text color={modeColor(t, mode)} bold>
        {modePrefix}{mode}
      </Text>
      <Sep t={t} />
      {showProvider && <Text color={t.inkDim}>{provider}/</Text>}
      <Text color={t.ink}>{model}</Text>
      <Sep t={t} />
      {branch === null ? (
        <Text color={t.inkFaint}>no git</Text>
      ) : (
        <Text>
          <Text color={t.inkDim}>{g.branch}</Text>
          <Text color={t.accent}>{branch}</Text>
          {dirty > 0 && <Text color={t.del}>{g.dirty}{dirty}</Text>}
        </Text>
      )}
      {showEdits && (
        <>
          <Sep t={t} />
          <Text color={t.inkDim}>{g.edits}</Text>
          <Text color={t.ink}>{edits}</Text>
        </>
      )}
      <Sep t={t} />
      <CtxBar t={t} pct={pct} cells={ctxCells} showGlyphs={ctxGlyphs} />
      {showMcp && (
        <>
          <Sep t={t} />
          <Text color={t.add}>{g.mcp}</Text>
          <Text color={t.inkDim}> {mcpUp}</Text>
        </>
      )}
      <Box flexGrow={1} />
      <Text color={t.accent} bold>${cost.toFixed(2)}</Text>
    </Box>
  );
}
