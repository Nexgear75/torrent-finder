import React from 'react';
import { Box, Text } from 'ink';
import type { IndexerInfo, SourceStatus } from '../lib/types';
import { padEnd, truncate } from '../lib/format';
import { ACCENT, DIM } from './theme';

interface Props {
  list: IndexerInfo[] | null;
  cursor: number;
  last: Map<string, SourceStatus>;
  width: number;
  height: number;
}

/** Full-height screen listing the configured sources and how they did last search. */
export function Indexers({ list, cursor, last, width, height }: Props) {
  const title = (
    <Box justifyContent="space-between" width={width} flexShrink={0}>
      <Text bold color={ACCENT}>
        {' '}Sources
      </Text>
      <Text color={DIM}>
        {list ? `${list.filter((i) => i.enabled).length}/${list.length} enabled ` : ''}
      </Text>
    </Box>
  );
  if (!list) {
    return (
      <Box flexDirection="column" height={height} width={width}>
        {title}
        <Text color={DIM}> Loading…</Text>
      </Box>
    );
  }
  const visible = Math.max(1, height - 2);
  const start = Math.min(Math.max(0, cursor - Math.floor(visible / 2)), Math.max(0, list.length - visible));
  const nameW = 24;
  return (
    <Box flexDirection="column" height={height} width={width} overflow="hidden">
      {title}
      <Text> </Text>
      {list.slice(start, start + visible).map((ix, i) => {
        const idx = start + i;
        const active = idx === cursor;
        const s = last.get(ix.id);
        let status: React.ReactNode;
        if (!ix.enabled) status = <Text color={DIM}>disabled</Text>;
        else if (s?.state === 'pending') status = <Text color={ACCENT}>searching…</Text>;
        else if (s?.state === 'ok')
          status = (
            <Text color="green">
              ✓ {s.count} results · {((s.ms ?? 0) / 1000).toFixed(1)}s
            </Text>
          );
        else if (s?.state === 'error') status = <Text color="red">✗ {truncate(s.error ?? 'failed', width - nameW - 20)}</Text>;
        else if (ix.error) status = <Text color="yellow">! {truncate(ix.error, width - nameW - 20)}</Text>;
        else status = <Text color={DIM}>not used yet</Text>;
        return (
          <Box key={ix.id} flexShrink={0}>
            <Text color={active ? ACCENT : DIM}>{active ? ' › ' : '   '}</Text>
            <Text color={ix.enabled ? 'green' : DIM}>{ix.enabled ? '[x] ' : '[ ] '}</Text>
            <Text bold={active} color={active ? 'whiteBright' : ix.enabled ? undefined : DIM}>
              {padEnd(truncate(ix.name, nameW), nameW)}
            </Text>
            {status}
          </Box>
        );
      })}
    </Box>
  );
}
