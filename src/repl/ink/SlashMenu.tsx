// Slash-command popup menu — appears between the chat region and the
// footer the moment the user types `/`. Filters as they type; up/down
// arrows pick; Enter selects (completes the command name); Esc closes.
//
// Keyboard handling lives in InkApp (it owns the input state); this
// component is presentational and just renders the filtered command list
// with a highlighted row.

import React from 'react';
import { Box, Text } from 'ink';
import { BR } from './theme.js';
import type { CommandDef } from '../commands.js';

export interface SlashMenuProps {
  commands: CommandDef[];
  selectedIdx: number;
}

export function SlashMenu({ commands, selectedIdx }: SlashMenuProps): React.JSX.Element {
  if (commands.length === 0) {
    return (
      <Box borderStyle="single" borderColor={BR.rule} paddingX={1} marginX={2}>
        <Text color={BR.inkDim}>no matching command</Text>
      </Box>
    );
  }
  // Cap the rendered list so a very long match list (rare) doesn't push
  // the chat region off-screen. Keeps the selected row visible.
  const MAX_ROWS = 10;
  const clampedSelected = Math.max(0, Math.min(selectedIdx, commands.length - 1));
  const start = Math.max(0, Math.min(clampedSelected - 5, commands.length - MAX_ROWS));
  const visible = commands.slice(start, start + MAX_ROWS);
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={BR.teal}
      paddingX={1}
      marginX={2}
    >
      <Box>
        <Text color={BR.teal} bold>Slash commands</Text>
        <Text color={BR.inkFaint}>  ↑↓ pick · enter complete · esc close</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((c, i) => {
          const absIdx = start + i;
          const selected = absIdx === clampedSelected;
          return (
            <Box key={c.name}>
              <Text color={selected ? BR.teal : BR.inkFaint}>{selected ? '▸ ' : '  '}</Text>
              <Box width={36}>
                <Text color={selected ? BR.teal : BR.ink} bold={selected}>
                  {c.signature}
                </Text>
              </Box>
              <Text color={BR.inkDim}>{c.summary}</Text>
            </Box>
          );
        })}
      </Box>
      {commands.length > MAX_ROWS && (
        <Box>
          <Text color={BR.inkFaint}>… {commands.length - MAX_ROWS} more (keep typing to narrow)</Text>
        </Box>
      )}
    </Box>
  );
}
