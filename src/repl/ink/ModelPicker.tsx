// Stage-2 picker overlay — opens after the user picks a provider in
// ProviderPicker. Shows only models for that provider, otherwise mirrors the
// look of stage 1 (teal border, faint hint line, ▸ marker, ← current tag).
//
// Esc here goes BACK to the provider stage (the bridge transitions
// overlay to {kind:'model-provider'}) rather than closing the whole flow,
// so the user can browse providers without losing the picker. Closing
// is one more Esc away.

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { BR } from './theme.js';
import { getKnownModels, modelCatalogSource, type ModelInfo } from '../../llm/models.js';

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
  const source = useMemo(() => modelCatalogSource(), []);

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

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.return) {
      const m = models[selectedIdx];
      if (m) onPick(m);
      return;
    }
    if (key.upArrow) {
      setSelectedIdx((i) => (i - 1 + Math.max(1, models.length)) % Math.max(1, models.length));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((i) => (i + 1) % Math.max(1, models.length));
      return;
    }
  });

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
        <Text color={BR.teal} bold>{provider.toUpperCase()} models</Text>
        <Text color={BR.inkFaint}>
          {source === 'proxy'
            ? `  from Automax catalog · ${models.length} · ↑↓ pick · enter confirm · esc back`
            : `  ${models.length} · ↑↓ pick · enter confirm · esc back`}
        </Text>
      </Box>
      {models.length === 0 ? (
        <Box marginTop={1}>
          <Text color={BR.inkFaint}>(no models available for {provider})</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {models.map((m, i) => {
            const selected = i === selectedIdx;
            const isCurrent =
              m.provider === currentProvider && currentModel.startsWith(m.model);
            const marker = selected ? '▸' : ' ';
            const labelColor = selected ? BR.teal : isCurrent ? BR.add : BR.ink;
            return (
              <Box key={`m-${m.provider}-${m.model}`}>
                <Text color={selected ? BR.teal : BR.inkFaint}>{marker} </Text>
                <Box width={32}>
                  <Text color={labelColor} bold={selected}>
                    {m.label}
                  </Text>
                  {isCurrent && <Text color={BR.add}>  ← current</Text>}
                </Box>
                <Text color={BR.inkDim}>
                  ${m.inputPerM}/M in · ${m.outputPerM}/M out
                </Text>
                {m.notes && <Text color={BR.inkFaint}>  · {m.notes}</Text>}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
