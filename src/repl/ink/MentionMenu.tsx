// `@` picker — appears under the transcript while the token at the cursor
// starts with `@`. Files from the project walk and, once the code index is
// built, symbols (functions, classes, methods). Filters as the user types;
// ↑↓ pick; Tab or Enter completes the path or symbol into the composer; Esc
// closes it for that token. Presentational only; InkApp owns the keys and
// the candidate list.

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import { glyphs } from './glyphs.js';
import type { MentionEntry } from '../../util/symbolMentions.js';

export interface MentionMenuProps {
  query: string;
  matches: MentionEntry[];
  selectedIdx: number;
}

export function MentionMenu({ query, matches, selectedIdx }: MentionMenuProps): React.JSX.Element {
  const t = useTheme();
  const g = glyphs();
  if (matches.length === 0) {
    return (
      <Box borderStyle="round" borderColor={t.border} paddingX={1} marginTop={1}>
        <Text color={t.inkDim}>{query.length > 0 ? `no file or symbol matches "${query}"` : 'no files found'}</Text>
      </Box>
    );
  }
  const selected = Math.max(0, Math.min(selectedIdx, matches.length - 1));
  const hasSymbols = matches.some((m) => m.kind === 'symbol');
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.border} paddingX={1} marginTop={1}>
      <Box>
        <Text color={t.accent} bold>
          {hasSymbols ? 'Files & symbols' : 'Files'}
        </Text>
        <Text color={t.inkDim}>{'  ↑↓ pick · tab or enter complete · esc close'}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {matches.map((entry, i) => (
          <Box key={`${entry.kind}:${entry.insert}`}>
            <Text color={i === selected ? t.accent : t.inkDim}>{i === selected ? `${g.pointer} ` : '  '}</Text>
            <Text color={i === selected ? t.accent : t.ink} bold={i === selected}>
              {entry.label}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
