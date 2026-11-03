import React from 'react';
import { Box, Text } from 'ink';
import type { EngineStatus, SourceStatus } from '../lib/types';
import { TABS, type Filters, type SortKey, type Tab, activeFilters } from '../lib/view';
import { truncate, width as strWidth } from '../lib/format';
import { ACCENT, DIM } from './theme';

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface Props {
  width: number;
  query: string;
  engine: EngineStatus;
  sources: SourceStatus[];
  count: number;
  total: number;
  searching: boolean;
  elapsed: number | null;
  spin: number;
  progress: string;
}

function engineLabel(e: EngineStatus, progress: string): { text: string; color: string; busy: boolean } | null {
  switch (e.state) {
    case 'checking':
    case 'starting':
      return { text: 'Starting search engine…', color: ACCENT, busy: true };
    case 'configuring':
      return { text: 'Setting up sources…', color: ACCENT, busy: true };
    case 'installing':
      return { text: `Installing Jackett… ${progress}`, color: 'yellow', busy: true };
    case 'missing':
      return { text: 'Search engine not installed', color: 'yellow', busy: false };
    case 'error':
      return { text: `Engine error: ${e.message ?? ''}`, color: 'red', busy: false };
    case 'stopped':
      return { text: 'Search engine stopped', color: 'red', busy: false };
    default:
      return null;
  }
}

export function Header(p: Props) {
  const eng = engineLabel(p.engine, p.progress);
  let right: React.ReactNode;
  let rightText = '';
  if (eng && (p.engine.state !== 'ready')) {
    rightText = (eng.busy ? SPINNER[p.spin % SPINNER.length] + ' ' : '') + eng.text;
    right = <Text color={eng.color}>{truncate(rightText, Math.max(10, p.width - 30))} </Text>;
  } else if (p.sources.length > 0) {
    const done = p.sources.filter((s) => s.state !== 'pending').length;
    const ok = p.sources.filter((s) => s.state === 'ok').length;
    const failed = p.sources.some((s) => s.state === 'error');
    const results =
      p.count === p.total ? `${p.total} results` : `${p.count}/${p.total} results`;
    const time = p.elapsed !== null ? ` · ${(p.elapsed / 1000).toFixed(1)}s` : '';
    rightText = p.searching
      ? `${SPINNER[p.spin % SPINNER.length]} ${done}/${p.sources.length} sources · ${results}`
      : `${ok}/${p.sources.length} sources · ${results}${time}`;
    right = (
      <Text>
        {p.searching ? <Text color={ACCENT}>{SPINNER[p.spin % SPINNER.length]} </Text> : null}
        <Text color={failed && !p.searching ? 'yellow' : DIM}>
          {p.searching ? `${done}/${p.sources.length}` : `${ok}/${p.sources.length}`} sources
        </Text>
        <Text color={DIM}>
          {' · '}
          {results}
          {time}{' '}
        </Text>
      </Text>
    );
  } else {
    right = <Text color={DIM}>ready </Text>;
    rightText = 'ready';
  }
  const queryRoom = Math.max(0, p.width - 6 - strWidth(rightText) - 4);
  return (
    <Box flexDirection="column" width={p.width} flexShrink={0}>
      <Box justifyContent="space-between" width={p.width}>
        <Box>
          <Text backgroundColor={ACCENT} color="black" bold>
            {' tf '}
          </Text>
          <Text color={ACCENT} bold>
            {'  ⌕ '}
            {truncate(p.query, queryRoom)}
          </Text>
        </Box>
        {right}
      </Box>
      <Text color={DIM}>{'─'.repeat(Math.max(0, p.width))}</Text>
    </Box>
  );
}

export function Tabs({
  width,
  tab,
  sort,
  filters,
  marked,
}: {
  width: number;
  tab: Tab['key'];
  sort: SortKey;
  filters: Filters;
  marked: number;
}) {
  const nf = activeFilters(filters);
  const arrow = sort === 'name' ? '↑' : '↓';
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Box justifyContent="space-between" width={width}>
        <Box>
          <Text> </Text>
          {TABS.map((t) =>
            t.key === tab ? (
              <Text key={t.key} backgroundColor={ACCENT} color="black" bold>
                {` ${t.label} `}
              </Text>
            ) : (
              <Text key={t.key} color={DIM}>{` ${t.label} `}</Text>
            ),
          )}
        </Box>
        <Text>
          {marked > 0 ? <Text color="magenta">{marked} marked · </Text> : null}
          {nf > 0 ? <Text color="yellow">{nf} filter{nf > 1 ? 's' : ''} · </Text> : null}
          <Text color={DIM}>sort: </Text>
          <Text color={ACCENT}>
            {sort} {arrow}
          </Text>{' '}
        </Text>
      </Box>
      <Text color={DIM}>{'─'.repeat(Math.max(0, width))}</Text>
    </Box>
  );
}
