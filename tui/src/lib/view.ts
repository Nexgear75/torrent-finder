import fs from 'node:fs';
import path from 'node:path';
import type { Kind, Result } from './types';

export interface Tab {
  key: 'all' | Kind;
  label: string;
}

export const TABS: Tab[] = [
  { key: 'all', label: 'ALL' },
  { key: 'games', label: 'GAMES' },
  { key: 'movies', label: 'MOVIES' },
  { key: 'tv', label: 'TV' },
  { key: 'music', label: 'MUSIC' },
  { key: 'apps', label: 'APPS' },
  { key: 'books', label: 'BOOKS' },
  { key: 'anime', label: 'ANIME' },
];

export type SortKey = 'seeders' | 'size' | 'date' | 'name';
export const SORTS: SortKey[] = ['seeders', 'size', 'date', 'name'];

export function nextSort(s: SortKey): SortKey {
  return SORTS[(SORTS.indexOf(s) + 1) % SORTS.length];
}

export interface Filters {
  minSeeders: number;
  minSize: number;
  maxSize: number; // 0 = no limit
  /** Indexer names to keep; null = all. */
  sources: string[] | null;
}

export const NO_FILTERS: Filters = { minSeeders: 0, minSize: 0, maxSize: 0, sources: null };

export function activeFilters(f: Filters): number {
  return (f.minSeeders > 0 ? 1 : 0) + (f.minSize > 0 ? 1 : 0) + (f.maxSize > 0 ? 1 : 0) + (f.sources ? 1 : 0);
}

function time(d: string | null): number {
  if (!d) return -Infinity;
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : -Infinity;
}

/** Filters by tab and filters, then sorts (descending, except name). */
export function applyView(results: Result[], tab: Tab['key'], sort: SortKey, f: Filters): Result[] {
  const out = results.filter(
    (r) =>
      (tab === 'all' || r.kind === tab) &&
      r.seeders >= f.minSeeders &&
      r.size >= f.minSize &&
      (f.maxSize === 0 || r.size <= f.maxSize) &&
      (!f.sources || r.indexers.some((s) => f.sources!.includes(s))),
  );
  const cmp: Record<SortKey, (a: Result, b: Result) => number> = {
    seeders: (a, b) => b.seeders - a.seeders || b.leechers - a.leechers,
    size: (a, b) => b.size - a.size,
    date: (a, b) => time(b.date) - time(a.date),
    name: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }),
  };
  return out.sort((a, b) => cmp[sort](a, b) || b.seeders - a.seeders || a.title.localeCompare(b.title));
}

/** "2025-06-21" from an ISO date, '' if unknown. */
export function shortDate(d: string | null): string {
  if (!d) return '';
  const t = Date.parse(d);
  if (!Number.isFinite(t)) return '';
  const x = new Date(t);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** 1204 → "1 204". */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Short indexer names for the result row. */
export function shortSource(name: string): string {
  const map: Record<string, string> = {
    'The Pirate Bay': 'TPB',
    'kickasstorrents.to': 'KAT',
    'kickasstorrents.ws': 'KAT',
    TorrentGalaxyClone: 'TGx',
    LimeTorrents: 'Lime',
    'RuTracker.RU': 'RuTracker',
    'Nyaa.si': 'Nyaa',
  };
  return map[name] ?? name;
}

// ---------------------------------------------------------------- search history

const MAX_HISTORY = 100;

export function pushHistory(list: string[], q: string): string[] {
  const t = q.trim();
  if (!t) return list;
  return [t, ...list.filter((x) => x !== t)].slice(0, MAX_HISTORY);
}

export function loadHistory(dir: string): string[] {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'));
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

export function saveHistory(dir: string, list: string[]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(list, null, 1));
  } catch {}
}
