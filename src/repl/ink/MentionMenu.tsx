// `@` file picker — appears under the transcript while the token at the
// cursor starts with `@`. Filters as the user types; ↑↓ pick; Tab or Enter
// completes the path into the composer; Esc closes it for that token.
// Presentational only; InkApp owns the keys and the file list.

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import { glyphs } from './glyphs.js';

export interface MentionMenuProps {
  query: string;
  matches: string[];
  selectedIdx: number;
}

export function MentionMenu({ query, matches, selectedIdx }: MentionMenuProps): React.JSX.Element {
  const t = useTheme();
  const g = glyphs();
  if (matches.length === 0) {
    return (
      <Box borderStyle="round" borderColor={t.border} paddingX={1} marginTop={1}>
        <Text color={t.inkDim}>{query.length > 0 ? `no file matches "${query}"` : 'no files found'}</Text>
      </Box>
    );
  }
  const selected = Math.max(0, Math.min(selectedIdx, matches.length - 1));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.border} paddingX={1} marginTop={1}>
      <Box>
        <Text color={t.accent} bold>
          Files
        </Text>
        <Text color={t.inkDim}>{'  ↑↓ pick · tab or enter complete · esc close'}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {matches.map((path, i) => (
          <Box key={path}>
            <Text color={i === selected ? t.accent : t.inkDim}>{i === selected ? `${g.pointer} ` : '  '}</Text>
            <Text color={i === selected ? t.accent : t.ink} bold={i === selected}>
              {path}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
