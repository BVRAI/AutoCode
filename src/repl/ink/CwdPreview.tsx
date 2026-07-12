import React from 'react';
import { Box, Text } from 'ink';
import { cwdStatus, resolveCwdTarget } from '../cwd.js';
import { useTheme } from './theme.js';

export interface CwdPreviewProps {
  currentRoot: string;
  rawArg: string;
}

export function CwdPreview({ currentRoot, rawArg }: CwdPreviewProps): React.JSX.Element {
  const t = useTheme();
  const target = resolveCwdTarget(rawArg, currentRoot);
  const status = cwdStatus(target);
  const hasArg = rawArg.trim().length > 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={status.ok ? t.accent : t.warn}
      paddingX={1}
      marginX={2}
    >
      <Box>
        <Text color={t.accent} bold>Change project root</Text>
        <Text color={t.inkFaint}>  enter apply · esc clear</Text>
      </Box>
      <Box marginTop={1}>
        <Box width={10}><Text color={t.inkFaint}>current</Text></Box>
        <Text color={t.inkDim}>{compactPath(currentRoot)}</Text>
      </Box>
      <Box>
        <Box width={10}><Text color={t.inkFaint}>target</Text></Box>
        <Text color={status.ok ? t.ink : t.warn}>{compactPath(target)}</Text>
      </Box>
      <Box>
        <Box width={10}><Text color={t.inkFaint}>status</Text></Box>
        <Text color={status.ok ? t.add : t.warn}>{hasArg ? status.label : 'type a path, .., ., or ~'}</Text>
      </Box>
    </Box>
  );
}

function compactPath(path: string): string {
  const max = 96;
  if (path.length <= max) return path;
  const keep = Math.floor((max - 3) / 2);
  return `${path.slice(0, keep)}...${path.slice(path.length - keep)}`;
}
