import React from 'react';
import { Box, Text } from 'ink';
import { ACCENT, DIM } from './theme';

const SECTIONS: [string, [string, string][]][] = [
  [
    'Search',
    [
      ['/  i', 'search · ↑↓ history'],
      ['← →  tab  1…8', 'category'],
      ['s', 'cycle sort'],
      ['f', 'filters'],
      ['I', 'manage sources'],
    ],
  ],
  [
    'Navigation',
    [
      ['↓ ↑  j / k', 'move'],
      ['home end  gg G', 'top / bottom'],
      ['pgdn pgup  ^d ^u', 'page down / up'],
    ],
  ],
  [
    'Results',
    [
      ['⏎', 'send to dl'],
      ['D', 'send, choose folder'],
      ['space', 'mark · ⏎ sends all'],
      ['u', 'clear marks'],
      ['o', 'open web page'],
      ['y', 'copy the magnet'],
    ],
  ],
  [
    'App',
    [
      ['?', 'this help'],
      ['q  ctrl-c', 'quit'],
    ],
  ],
];

function Section({ title, rows, last }: { title: string; rows: [string, string][]; last?: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={last ? 0 : 1} flexShrink={0}>
      <Text bold>{title}</Text>
      {rows.map(([k, v]) => (
        <Box key={k} flexShrink={0}>
          <Box width={18} flexShrink={0}>
            <Text color={ACCENT}>{k}</Text>
          </Box>
          <Text color={DIM} wrap="truncate">
            {v}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export function Help({ width, height }: { width: number; height: number }) {
  const wide = width >= 80;
  const [search, nav, results, app] = SECTIONS;
  return (
    <Box width={width} height={height} justifyContent="center" alignItems="flex-start" overflow="hidden">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={ACCENT}
        paddingX={2}
        flexShrink={0}
        width={Math.min(width, wide ? 96 : 60)}
      >
        <Box justifyContent="space-between" flexShrink={0}>
          <Text bold color={ACCENT}>
            Keys
          </Text>
          <Text color={DIM}>any key to close</Text>
        </Box>
        {wide ? (
          <Box>
            <Box flexDirection="column" width="50%" paddingRight={2}>
              <Section title={search[0]} rows={search[1]} />
              <Section title={nav[0]} rows={nav[1]} last />
            </Box>
            <Box flexDirection="column" width="50%" paddingRight={2}>
              <Section title={results[0]} rows={results[1]} />
              <Section title={app[0]} rows={app[1]} last />
            </Box>
          </Box>
        ) : (
          SECTIONS.map(([t, r], i) => <Section key={t} title={t} rows={r} last={i === SECTIONS.length - 1} />)
        )}
      </Box>
    </Box>
  );
}
