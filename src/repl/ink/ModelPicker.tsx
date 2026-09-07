// Stage-2 picker overlay — opens after the user picks a provider in
// ProviderPicker. Shows only models for that provider, otherwise mirrors the
// look of stage 1 (teal border, faint hint line, ▸ marker, ← current tag).
//
// Esc here goes BACK to the provider stage (the bridge transitions
// overlay to {kind:'model-provider'}) rather than closing the whole flow,
// so the user can browse providers without losing the picker. Closing
// is one more Esc away.
//
// Live provider lists run to dozens of rows (OpenAI publishes ~50 chat
// models) and OpenRouter's public list to hundreds, so the list is a window
// of WINDOW rows around the selection with "… N more" markers, PgUp/PgDn
// jump a window at a time, and typing filters rows by id or label (Esc
// clears the filter before it leaves the stage).

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { BR } from './theme.js';
import { getKnownModels, modelBadges, modelCatalogDetail, type ModelInfo } from '../../llm/models.js';

const WINDOW = 14;

export interface ModelPickerProps {
  // The provider this picker is scoped to. Picked in stage 1.
  provider: string;
  // Highlight the row matching the currently-active model.
  currentProvider: string;
  currentModel: string;
  onPick: (m: ModelInfo) => void;
  onBack: () => void;    // Esc — pops back to ProviderPicker.
  onCancel: () => void;  // Reserved; not currently bound. Kept on the
                         // interface so a future "double-Esc to close"
                         // shortcut can wire to it without a contract change.
}

export function ModelPicker({
  provider,
  currentProvider,
  currentModel,
  onPick,
  onBack,
}: ModelPickerProps): React.JSX.Element {
  const models = useMemo<ModelInfo[]>(
    () => getKnownModels().filter((m) => m.provider.toLowerCase() === provider.toLowerCase()),
    [provider],
  );
  const detail = useMemo(() => modelCatalogDetail(), []);

  const [query, setQuery] = useState('');
  const visibleModels = useMemo<ModelInfo[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return models;
    return models.filter((m) => `${m.model} ${m.label}`.toLowerCase().includes(q));
  }, [models, query]);

  // Pre-select the active model if it matches one in this provider's list;
  // else the first row.
  const initialIdx = useMemo(() => {
    for (let i = 0; i < models.length; i++) {
      const m = models[i]!;
      if (m.provider === currentProvider && currentModel.startsWith(m.model)) return i;
    }
    return 0;
  }, [models, currentProvider, currentModel]);

  const [selectedIdx, setSelectedIdx] = useState<number>(initialIdx);
  const count = Math.max(1, visibleModels.length);

  useInput((input, key) => {
    if (key.escape) {
      if (query.length > 0) {
        setQuery('');
        setSelectedIdx(0);
      } else {
        onBack();
      }
      return;
    }
    if (key.return) {
      const m = visibleModels[selectedIdx];
      if (m) onPick(m);
      return;
    }
    if (key.upArrow) {
      setSelectedIdx((i) => (i - 1 + count) % count);
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((i) => (i + 1) % count);
      return;
    }
    if (key.pageUp) {
      setSelectedIdx((i) => Math.max(0, i - WINDOW));
      return;
    }
    if (key.pageDown) {
      setSelectedIdx((i) => Math.min(count - 1, i + WINDOW));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setSelectedIdx(0);
      return;
    }
    if (input.length === 1 && input >= ' ' && !key.ctrl && !key.meta && !key.tab) {
      setQuery((q) => q + input);
      setSelectedIdx(0);
    }
  });

  // Window of rows around the selection.
  const start = visibleModels.length <= WINDOW ? 0 : Math.min(Math.max(0, selectedIdx - Math.floor(WINDOW / 2)), visibleModels.length - WINDOW);
  const visible = visibleModels.slice(start, start + WINDOW);
  const above = start;
  const below = Math.max(0, visibleModels.length - (start + visible.length));
  const countText = query.length > 0 ? `${visibleModels.length} of ${models.length}` : `${models.length}`;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={BR.teal}
      paddingX={1}
      paddingY={0}
      marginX={2}
    >
      <Box>
        <Box flexShrink={0}>
          <Text color={BR.teal} bold>{provider.toUpperCase()} models</Text>
        </Box>
        <Text color={BR.inkFaint} wrap="truncate-end">
          {`  ${countText} · type to filter · ↑↓ pick · pgup/pgdn page · enter confirm · esc back`}
        </Text>
      </Box>
      <Text color={BR.inkFaint} wrap="truncate-end">
        {query.length > 0 ? `${detail} · filter: ${query}` : detail}
      </Text>
      {visibleModels.length === 0 ? (
        <Box marginTop={1}>
          <Text color={BR.inkFaint}>
            {query.length > 0 ? `(no ${provider} model matches "${query}")` : `(no models available for ${provider})`}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {above > 0 && <Text color={BR.inkFaint}>  … {above} more above</Text>}
          {visible.map((m, offset) => {
            const i = start + offset;
            const selected = i === selectedIdx;
            const isCurrent =
              m.provider === currentProvider && currentModel.startsWith(m.model);
            const marker = selected ? '▸' : ' ';
            const labelColor = selected ? BR.teal : isCurrent ? BR.add : BR.ink;
            const price = m.priceUnknown ? 'price unknown' : `$${m.inputPerM}/M in · $${m.outputPerM}/M out`;
            return (
              <Box key={`m-${m.provider}-${m.model}`}>
                <Text color={selected ? BR.teal : BR.inkFaint}>{marker} </Text>
                <Box width={32} flexShrink={0}>
                  <Text color={labelColor} bold={selected} wrap="truncate-end">
                    {m.label}
                  </Text>
                  {isCurrent && <Text color={BR.add}>  ← current</Text>}
                </Box>
                <Box flexShrink={0}>
                  <Text color={BR.inkDim}>{price}</Text>
                  {modelBadges(m).length > 0 && <Text color={BR.inkDim}>  · {modelBadges(m).join(' · ')}</Text>}
                </Box>
                {m.notes && <Text color={BR.inkFaint} wrap="truncate-end">  · {m.notes}</Text>}
              </Box>
            );
          })}
          {below > 0 && <Text color={BR.inkFaint}>  … {below} more below</Text>}
        </Box>
      )}
    </Box>
  );
}
