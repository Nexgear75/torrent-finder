import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitBurst } from './keys';
import { formatBytes, parseSize, truncate, width } from './format';
import {
  NO_FILTERS,
  activeFilters,
  applyView,
  formatCount,
  loadHistory,
  nextSort,
  pushHistory,
  saveHistory,
  shortDate,
  shortSource,
} from './view';
import type { Result } from './types';

const r = (o: Partial<Result>): Result => ({
  id: o.title ?? 'x',
  title: 'x',
  indexers: ['The Pirate Bay'],
  category: '',
  kind: 'other',
  size: 0,
  seeders: 0,
  leechers: 0,
  date: null,
  magnet: null,
  link: null,
  details: null,
  ...o,
});

const sample = [
  r({ title: 'Elden Ring', kind: 'games', seeders: 120, size: 50e9, date: '2022-02-25T00:00:00Z', indexers: ['1337x', 'The Pirate Bay'] }),
  r({ title: 'Dune', kind: 'movies', seeders: 900, size: 4e9, date: '2024-05-01T00:00:00Z' }),
  r({ title: 'alpha', kind: 'apps', seeders: 3, size: 1e6, date: null, indexers: ['LimeTorrents'] }),
];

describe('view', () => {
  test('tab filter', () => {
    expect(applyView(sample, 'all', 'seeders', NO_FILTERS).map((x) => x.title)).toEqual(['Dune', 'Elden Ring', 'alpha']);
    expect(applyView(sample, 'games', 'seeders', NO_FILTERS).map((x) => x.title)).toEqual(['Elden Ring']);
    expect(applyView(sample, 'anime', 'seeders', NO_FILTERS)).toEqual([]);
  });
  test('sorts', () => {
    expect(applyView(sample, 'all', 'size', NO_FILTERS)[0].title).toBe('Elden Ring');
    expect(applyView(sample, 'all', 'date', NO_FILTERS).map((x) => x.title)).toEqual(['Dune', 'Elden Ring', 'alpha']);
    expect(applyView(sample, 'all', 'name', NO_FILTERS).map((x) => x.title)).toEqual(['alpha', 'Dune', 'Elden Ring']);
    expect(nextSort('seeders')).toBe('size');
    expect(nextSort('name')).toBe('seeders');
  });
  test('filters', () => {
    const f = { ...NO_FILTERS, minSeeders: 10, maxSize: 10e9 };
    expect(applyView(sample, 'all', 'seeders', f).map((x) => x.title)).toEqual(['Dune']);
    expect(activeFilters(f)).toBe(2);
    const s = { ...NO_FILTERS, sources: ['1337x'] };
    expect(applyView(sample, 'all', 'seeders', s).map((x) => x.title)).toEqual(['Elden Ring']);
    expect(applyView(sample, 'all', 'seeders', { ...NO_FILTERS, minSize: 2e9 }).length).toBe(2);
  });
  test('formatting', () => {
    expect(formatCount(1204)).toBe('1 204');
    expect(formatCount(12)).toBe('12');
    expect(formatCount(1234567)).toBe('1 234 567');
    expect(shortDate('2025-06-21T12:00:00Z')).toBe('2025-06-21');
    expect(shortDate(null)).toBe('');
    expect(shortDate('garbage')).toBe('');
    expect(shortSource('The Pirate Bay')).toBe('TPB');
    expect(shortSource('1337x')).toBe('1337x');
    expect(formatBytes(54.2 * 1024 ** 3)).toBe('54.2 GB');
    expect(parseSize('4G')).toBe(4 * 1024 ** 3);
    expect(width(truncate('ELDEN RING Shadow of the Erdtree – v1.12 [FitGirl Repack]', 20))).toBeLessThanOrEqual(20);
  });
  test('history', () => {
    let h = pushHistory([], 'elden ring');
    h = pushHistory(h, 'dune');
    h = pushHistory(h, ' elden ring ');
    expect(h).toEqual(['elden ring', 'dune']);
    expect(pushHistory(h, '  ')).toBe(h);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-hist-'));
    saveHistory(dir, h);
    expect(loadHistory(dir)).toEqual(h);
    expect(loadHistory(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('keys', () => {
  test('bursts are split', () => {
    expect(splitBurst('j\r', {}).map(([i, k]) => (k.return ? '⏎' : i))).toEqual(['j', '⏎']);
    expect(splitBurst('\r\x15/tmp', {}).map(([i, k]) => (k.return ? '⏎' : k.ctrl ? `^${i}` : i))).toEqual(['⏎', '^u', '/tmp']);
    expect(splitBurst('dd', {})).toEqual([['dd', {}]]);
  });
});
