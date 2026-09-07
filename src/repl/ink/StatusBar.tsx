// StatusBar — Claude Code's footer under the composer: a mode badge
// ("⏸ manual mode on", "⏵⏵ auto mode on"), the shortcut hint ("? for
// shortcuts" / "esc to interrupt"), then an optional dim status-line row with
// model · branch · context · cost. Fields drop right-to-left as the terminal
// narrows; glyphs fall back to ASCII on plain terminals.

import React from 'react';
import { Box, Text } from 'ink';
import type { BridgeState } from './store.js';
import { useTheme, type Theme } from './theme.js';
import { glyphs } from './glyphs.js';
import { modeBadge } from './grammar.js';

function badgeColor(t: Theme, mode: BridgeState['mode']): string {
  switch (mode) {
    case 'planning':
      return t.borderPlan;
    case 'autocode':
    case 'admin':
    case 'sights':
      return t.borderAuto;
    default:
      return t.inkDim;
  }
}

export function StatusBar({ state, columns, exitArmed }: { state: BridgeState; columns: number; exitArmed?: boolean }): React.JSX.Element {
  const t = useTheme();
  const g = glyphs();
  const badge = modeBadge(state.mode);
  const glyph = badge.kind === 'pause' ? g.pause : g.play;

  const hint = exitArmed
    ? 'ctrl+c again to exit'
    : state.busy
      ? 'esc to interrupt'
      : state.queueDepth > 0
        ? `${state.queueDepth} queued · esc to interrupt`
        : '? for shortcuts';

  const provider = state.model.provider;
  const model = state.model.name || '(no model)';
  const branch = state.project.branch;
  const window = state.usage.contextWindow > 0 ? state.usage.contextWindow : 200_000;
  const pct = Math.round((state.usage.currentContextTokens / window) * 100);
  const cost = state.usage.costUsd;
  const ctxColor = pct >= 95 ? t.rose : pct >= 80 ? t.warn : t.inkDim;

  const showModel = columns >= 60;
  const showBranch = columns >= 80 && branch !== null;
  const showCtx = columns >= 50 && state.usage.currentContextTokens > 0;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={badgeColor(t, state.mode)}>{glyph} {badge.text}</Text>
        <Text color={t.inkDim}>{'  ·  '}{hint}</Text>
        {columns >= 100 && <Text color={t.inkDim}>{'  ·  shift+tab to cycle'}</Text>}
        {state.verbose && <Text color={t.inkDim}>{'  ·  verbose on'}</Text>}
      </Box>
      <Box>
        {showModel && <Text color={t.inkDim}>{provider ? `${provider}/` : ''}{model}</Text>}
        {showBranch && <Text color={t.inkDim}>{'  ·  '}{g.branch}{branch}{state.project.dirty > 0 ? `${g.dirty}${state.project.dirty}` : ''}</Text>}
        {showCtx && (
          <Text color={ctxColor}>
            {'  ·  '}{pct}% context
          </Text>
        )}
        <Box flexGrow={1} />
        {cost > 0 && <Text color={t.inkDim}>${cost.toFixed(2)}</Text>}
      </Box>
    </Box>
  );
}
