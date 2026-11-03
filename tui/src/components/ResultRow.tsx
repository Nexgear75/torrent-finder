import React from 'react';
import { Box, Text } from 'ink';
import type { Result } from '../lib/types';
import { formatBytes, padEnd, truncate, width as strWidth } from '../lib/format';
import { formatCount, shortDate, shortSource } from '../lib/view';
import { ACCENT, DIM, MARK, seedColor } from './theme';

export const ROW_HEIGHT = 2;

interface Props {
  r: Result;
  selected: boolean;
  marked: boolean;
  sent: boolean;
  width: number;
}

export function ResultRow({ r, selected, marked, sent, width }: Props) {
  const bar = selected ? <Text color={ACCENT}>▌ </Text> : <Text>{'  '}</Text>;
  const size = formatBytes(r.size).padStart(10);
  const cat = truncate(r.category || r.kind, 14);
  const catW = 14;
  const mark = marked ? '● ' : sent ? '✓ ' : '  ';
  const titleW = Math.max(10, width - 2 - 2 - catW - 2 - 10 - 2);
  const seeds = `▲ ${formatCount(r.seeders)}`;
  const leech = `▼ ${formatCount(r.leechers)}`;
  const sources = r.indexers.map(shortSource).join(' · ');
  const date = shortDate(r.date);
  const hint = selected ? (sent ? 'sent ✓ ' : '→ dl ⏎ ') : sent ? 'sent ' : '';
  const fixed = 4 + 10 + 2 + 9 + 3 + 10 + 2 + strWidth(hint);
  const srcW = Math.max(6, width - fixed);
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Box flexShrink={0}>
        {bar}
        <Text color={marked ? MARK : 'green'}>{mark}</Text>
        <Text bold={selected} color={selected ? 'whiteBright' : undefined}>
          {padEnd(truncate(r.title, titleW), titleW)}
        </Text>
        <Text color={DIM}>
          {'  '}
          {padEnd(cat, catW)}
        </Text>
        <Text color={selected ? ACCENT : undefined}>{size} </Text>
      </Box>
      <Box flexShrink={0}>
        {bar}
        <Text>{'  '}</Text>
        <Text color={seedColor(r.seeders)}>{padEnd(seeds, 10)}</Text>
        <Text color={DIM}>{padEnd(leech, 9)}</Text>
        <Text color={DIM}>{'   '}</Text>
        <Text color={selected ? undefined : DIM}>{padEnd(truncate(sources, srcW), srcW)}</Text>
        <Text color={DIM}>{padEnd(date, 10)}  </Text>
        <Text color={sent ? 'green' : ACCENT}>{hint}</Text>
      </Box>
    </Box>
  );
}
