import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { execFile, spawn } from 'node:child_process';
import type { Backend } from './lib/backend';
import { dataDir } from './lib/backend';
import type {
  CatalogEntry,
  DlConfig,
  EngineStatus,
  IndexerInfo,
  Result,
  SendResult,
  SourceStatus,
} from './lib/types';
import { formatBytes, parseSize, tildify, truncate } from './lib/format';
import { isPathLike, pathExists, suggest, type Suggestion } from './lib/complete';
import { splitBurst } from './lib/keys';
import {
  NO_FILTERS,
  TABS,
  applyView,
  loadHistory,
  nextSort,
  pushHistory,
  saveHistory,
  type Filters,
  type SortKey,
  type Tab,
} from './lib/view';
import { Header, SPINNER, Tabs } from './components/Header';
import { ResultRow, ROW_HEIGHT } from './components/ResultRow';
import { Picker, pickerHeight, type PickerItem } from './components/Picker';
import { Help } from './components/Help';
import { Indexers } from './components/Indexers';
import { InputLine, Suggestions, suggestionsHeight } from './components/InputBar';
import { ACCENT, DIM } from './components/theme';

// ---------------------------------------------------------------- modes

type Purpose = 'search' | 'dir' | 'value';

interface InputMode {
  t: 'input';
  purpose: Purpose;
  label: string;
  color: string;
  placeholder?: string;
  value: string;
  cursor: number;
  sel: number;
  /** user navigated the completion list explicitly */
  nav: boolean;
  /** position in search history (-1 = editing) */
  hist: number;
  draft: string;
  resolve: (v: string | null) => void;
}

interface PickerMode {
  t: 'picker';
  title: string;
  subtitle?: string;
  items: PickerItem[];
  multi: boolean;
  cursor: number;
  checked: boolean[];
  resolve: (v: number[] | null) => void;
}

type Mode =
  | { t: 'normal' }
  | InputMode
  | PickerMode
  | { t: 'help' }
  | { t: 'indexers'; cursor: number }
  | { t: 'confirm'; message: string; resolve: (b: boolean) => void }
  | { t: 'busy'; message: string };

interface Notice {
  text: string;
  level: 'info' | 'ok' | 'error';
}

type SearchEvent = { name: 'search_start' | 'results' | 'search_done'; data: any };

function copy(text: string) {
  const p = spawn('pbcopy');
  p.on('error', () => {});
  p.stdin.end(text);
}

// ---------------------------------------------------------------- text editing

function editInput(m: InputMode, input: string, key: any): InputMode | null {
  const chars = Array.from(m.value);
  const c = m.cursor;
  const set = (arr: string[], cursor: number): InputMode => ({
    ...m,
    value: arr.join(''),
    cursor,
    sel: 0,
    nav: false,
    hist: -1,
  });
  if (key.backspace || key.delete) {
    if (c === 0) return m;
    chars.splice(c - 1, 1);
    return set(chars, c - 1);
  }
  if (key.leftArrow || (key.ctrl && input === 'b')) return { ...m, cursor: Math.max(0, c - 1) };
  if (key.rightArrow || (key.ctrl && input === 'f')) return { ...m, cursor: Math.min(chars.length, c + 1) };
  if (key.home || (key.ctrl && input === 'a')) return { ...m, cursor: 0 };
  if (key.end || (key.ctrl && input === 'e')) return { ...m, cursor: chars.length };
  if (key.ctrl && input === 'u') return set(chars.slice(c), 0);
  if (key.ctrl && input === 'k') return set(chars.slice(0, c), c);
  if (key.ctrl && input === 'w') {
    let i = c;
    const sep = (ch: string) => ch === '/' || ch === ' ';
    while (i > 0 && sep(chars[i - 1])) i--;
    while (i > 0 && !sep(chars[i - 1])) i--;
    chars.splice(i, c - i);
    return set(chars, i);
  }
  if (input && !key.ctrl && !key.meta && !key.return && !key.tab && !key.escape) {
    // never insert control characters into the text
    const ins = Array.from(input.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, ''));
    if (ins.length === 0) return m;
    chars.splice(c, 0, ...ins);
    return set(chars, c + ins.length);
  }
  return null;
}

function suggestionsFor(mode: Mode): Suggestion[] {
  if (mode.t !== 'input' || mode.purpose !== 'dir') return [];
  const list = suggest(mode.value, 'dir');
  if (list.length === 1 && list[0].value === mode.value) return [];
  return list;
}

const slim = (r: Result) => ({ id: r.id, title: r.title, magnet: r.magnet, link: r.link });

// ---------------------------------------------------------------- app

interface Props {
  backend: Backend;
  initialQuery?: string;
  /** shown once at startup (e.g. "tf updated to v0.2.0") */
  startNotice?: string;
}

export function App({ backend, initialQuery, startNotice }: Props) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const width = Math.max(50, columns);

  const [mode, setModeState] = useState<Mode>({ t: 'normal' });
  // the key handler reads the mode from this ref so that several keys
  // delivered in one chunk each see the result of the previous one
  const modeRef = useRef<Mode>(mode);
  const setMode = useCallback((m: Mode) => {
    modeRef.current = m;
    setModeState(m);
  }, []);

  const [engine, setEngine] = useState<EngineStatus>({ state: 'checking' });
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const [progress, setProgress] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [spin, setSpin] = useState(0);

  const [query, setQuery] = useState('');
  const [tab, setTabState] = useState<Tab['key']>('all');
  const [sort, setSortState] = useState<SortKey>('seeders');
  const sortRef = useRef(sort);
  const setSort = (s: SortKey) => {
    sortRef.current = s;
    setSortState(s);
  };
  const [filters, setFiltersState] = useState<Filters>(NO_FILTERS);
  const filtersRef = useRef(filters);
  const setFilters = (f: Filters) => {
    filtersRef.current = f;
    setFiltersState(f);
  };
  const [results, setResultsState] = useState<Result[]>([]);
  const resultsRef = useRef<Result[]>([]);
  const setResults = (r: Result[]) => {
    resultsRef.current = r;
    setResultsState(r);
  };
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [searching, setSearching] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  // selection and marks are read by the key handler through refs, updated
  // synchronously, so that a burst of keys ("jjj", "  ") sees every change
  const [selId, setSelIdState] = useState<string | null>(null);
  const selIdRef = useRef<string | null>(null);
  const setSelId = useCallback((id: string | null) => {
    selIdRef.current = id;
    setSelIdState(id);
  }, []);
  const [marks, setMarksState] = useState<Set<string>>(new Set());
  const marksRef = useRef(marks);
  const setMarks = useCallback((m: Set<string>) => {
    marksRef.current = m;
    setMarksState(m);
  }, []);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [ixList, setIxListState] = useState<IndexerInfo[] | null>(null);
  const ixListRef = useRef(ixList);
  const setIxList = useCallback((l: IndexerInfo[] | null) => {
    ixListRef.current = l;
    setIxListState(l);
  }, []);

  const history = useRef<string[]>(loadHistory(dataDir()));
  const latestSid = useRef(0);
  const blocked = useRef(false);
  const buffered = useRef<SearchEvent[]>([]);
  const lastIdx = useRef(0);
  const scroll = useRef(0);
  const pendingKey = useRef<{ k: string; at: number } | null>(null);
  const flowToken = useRef(0);
  const askedInstall = useRef(false);
  const ixChanged = useRef(false);
  const queryRef = useRef(query);
  queryRef.current = query;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const say = useCallback((text: string, level: Notice['level'] = 'info') => setNotice({ text, level }), []);
  useEffect(() => {
    if (startNotice) say(startNotice, 'ok');
  }, []);

  // notices fade out
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.level === 'error' ? 10000 : 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // spinner while something is in progress
  const animating =
    mode.t === 'busy' || searching || ['checking', 'starting', 'configuring', 'installing'].includes(engine.state);
  useEffect(() => {
    if (!animating) return;
    const t = setInterval(() => setSpin((s) => s + 1), 90);
    return () => clearInterval(t);
  }, [animating]);

  // ------------------------------------------------ promise-based dialogs
  const ask = useCallback(
    (opts: { purpose: Purpose; label: string; color: string; initial?: string; placeholder?: string }) =>
      new Promise<string | null>((resolve) => {
        const value = opts.initial ?? '';
        setMode({
          t: 'input',
          purpose: opts.purpose,
          label: opts.label,
          color: opts.color,
          placeholder: opts.placeholder,
          value,
          cursor: Array.from(value).length,
          sel: 0,
          nav: false,
          hist: -1,
          draft: value,
          resolve,
        });
      }),
    [setMode],
  );

  const pick = useCallback(
    (opts: {
      title: string;
      subtitle?: string;
      items: PickerItem[];
      multi?: boolean;
      checked?: boolean[];
      cursor?: number;
    }) =>
      new Promise<number[] | null>((resolve) => {
        setMode({
          t: 'picker',
          title: opts.title,
          subtitle: opts.subtitle,
          items: opts.items,
          multi: !!opts.multi,
          cursor: Math.min(opts.cursor ?? 0, Math.max(0, opts.items.length - 1)),
          checked: opts.checked ?? opts.items.map(() => !!opts.multi),
          resolve,
        });
      }),
    [setMode],
  );

  const confirm = useCallback(
    (message: string) => new Promise<boolean>((resolve) => setMode({ t: 'confirm', message, resolve })),
    [setMode],
  );

  const backToNormal = useCallback(() => setMode({ t: 'normal' }), [setMode]);

  // ------------------------------------------------ search
  const applySearchEvent = useCallback((ev: SearchEvent) => {
    const d = ev.data;
    if (d.searchId !== latestSid.current) return;
    if (ev.name === 'search_start') {
      setSources(d.indexers.map((i: { id: string; name: string }) => ({ ...i, state: 'pending' })));
    } else if (ev.name === 'results') {
      setResults(d.results);
      setSources((prev) =>
        prev.map((s) =>
          s.id === d.indexer
            ? { ...s, state: d.ok ? 'ok' : 'error', count: d.count, error: d.error, ms: d.ms }
            : s,
        ),
      );
    } else {
      setSearching(false);
      setElapsed(d.ms ?? null);
      if (d.error) say(d.error, 'error');
    }
  }, [say]);

  const runSearch = useCallback(
    async (q: string, tabKey: Tab['key'], keep = false) => {
      const text = q.trim();
      if (!text) return;
      setQuery(text);
      history.current = pushHistory(history.current, text);
      saveHistory(dataDir(), history.current);
      if (!keep) {
        setResults([]);
        setSelId(null);
        lastIdx.current = 0;
        scroll.current = 0;
        setMarks(new Set());
      }
      setSources([]);
      setSearching(true);
      setElapsed(null);
      blocked.current = true;
      buffered.current = [];
      try {
        const r = await backend.call<{ searchId: number }>('search', { query: text, category: tabKey });
        latestSid.current = r.searchId;
        blocked.current = false;
        const evs = buffered.current;
        buffered.current = [];
        evs.forEach(applySearchEvent);
      } catch (e) {
        blocked.current = false;
        setSearching(false);
        say((e as Error).message, 'error');
      }
    },
    [applySearchEvent, backend, say, setMarks, setSelId],
  );

  const setTab = useCallback(
    (k: Tab['key']) => {
      setTabState(k);
      tabRef.current = k;
      lastIdx.current = 0;
      scroll.current = 0;
      setSelId(null);
      if (queryRef.current) void runSearch(queryRef.current, k, true);
    },
    [runSearch, setSelId],
  );

  // ------------------------------------------------ backend events
  useEffect(() => {
    const onStatus = (s: EngineStatus) => {
      setEngine(s);
      if (s.state === 'ready') setProgress('');
      if (s.state === 'error') say(`Search engine: ${s.message ?? 'failed'}`, 'error');
    };
    const onProgress = (p: { line: string }) => setProgress(p.line);
    const searchHandler = (name: SearchEvent['name']) => (data: any) => {
      if (blocked.current) buffered.current.push({ name, data });
      else applySearchEvent({ name, data });
    };
    const onStart = searchHandler('search_start');
    const onResults = searchHandler('results');
    const onDone = searchHandler('search_done');
    const onExit = (msg: string) => {
      setEngine({ state: 'stopped' });
      setSearching(false);
      say(msg, 'error');
    };
    backend.on('status', onStatus);
    backend.on('progress', onProgress);
    backend.on('search_start', onStart);
    backend.on('results', onResults);
    backend.on('search_done', onDone);
    backend.on('exit', onExit);
    // catch up in case the first status was emitted before we subscribed
    backend
      .call<EngineStatus>('status')
      .then((s) => setEngine((cur) => (cur.state === 'checking' ? s : cur)))
      .catch(() => {});
    return () => {
      backend.off('status', onStatus);
      backend.off('progress', onProgress);
      backend.off('search_start', onStart);
      backend.off('results', onResults);
      backend.off('search_done', onDone);
      backend.off('exit', onExit);
    };
  }, [applySearchEvent, backend, say]);

  // ------------------------------------------------ flows
  const installFlow = useCallback(async () => {
    askedInstall.current = true;
    const s = engineRef.current;
    if (!s.brew) {
      say('Jackett is not installed and Homebrew was not found (see https://brew.sh)', 'error');
      return;
    }
    const yes = await confirm('Install Jackett (free, via Homebrew)?');
    backToNormal();
    if (!yes) {
      say('tf needs Jackett to search. Press ⏎ to install it later.', 'info');
      return;
    }
    try {
      await backend.call('install_engine');
    } catch (e) {
      say((e as Error).message, 'error');
    }
  }, [backToNormal, backend, confirm, say]);

  // ask once, as soon as we know Jackett is missing
  useEffect(() => {
    if (engine.state === 'missing' && !askedInstall.current && mode.t === 'normal') {
      askedInstall.current = true;
      void installFlow();
    }
  }, [engine.state, installFlow, mode.t]);

  const openSearch = useCallback(
    async (initial?: string) => {
      const v = await ask({
        purpose: 'search',
        label: 'SEARCH',
        color: ACCENT,
        initial: initial ?? queryRef.current,
        placeholder: 'what are you looking for?',
      });
      backToNormal();
      if (v === null || !v.trim()) return;
      if (engineRef.current.state === 'missing') {
        setQuery(v.trim());
        return void installFlow();
      }
      void runSearch(v, tabRef.current);
    },
    [ask, backToNormal, installFlow, runSearch],
  );

  // initial query from the command line
  useEffect(() => {
    if (initialQuery) void runSearch(initialQuery, 'all');
    else void openSearch('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendFlow = useCallback(
    async (items: Result[], chooseDir: boolean) => {
      if (items.length === 0) return;
      const token = ++flowToken.current;
      const alive = () => token === flowToken.current;
      let dir: string | undefined;
      try {
        if (chooseDir) {
          setMode({ t: 'busy', message: 'Asking dl for its download folder…' });
          let initial = '~/Downloads/';
          try {
            const cfg = await backend.call<DlConfig>('dl_config');
            initial = tildify(cfg.download_dir).replace(/\/?$/, '/');
          } catch {}
          if (!alive()) return;
          const v = await ask({ purpose: 'dir', label: 'SAVE TO', color: 'magenta', initial });
          if (v === null || !alive()) return backToNormal();
          dir = v;
        }
        const what = items.length === 1 ? `“${truncate(items[0].title, 50)}”` : `${items.length} torrents`;
        setMode({ t: 'busy', message: `Sending ${what} to dl…` });
        const res = await backend.call<SendResult>('send', { items: items.map(slim), dir });
        if (!alive()) return;
        backToNormal();
        const failedTitles = new Set(res.errors.map((e) => e.title));
        setSent((prev) => {
          const ok = new Set(prev);
          for (const it of items) if (!failedTitles.has(it.title)) ok.add(it.id);
          return ok;
        });
        setMarks(new Set());
        if (res.errors.length > 0) {
          const e = res.errors[0];
          say(
            `${res.sent.length ? `Sent ${res.sent.length}, ` : ''}${res.errors.length} failed: ${truncate(e.title, 30)}: ${e.error}`,
            'error',
          );
        } else {
          say(`Sent ${what} to dl${dir ? ` → ${tildify(dir)}` : ''} · open dl to follow the download`, 'ok');
        }
      } catch (e) {
        if (!alive()) return;
        backToNormal();
        say((e as Error).message, 'error');
      }
    },
    [ask, backToNormal, backend, say, setMarks, setMode],
  );

  const filtersFlow = useCallback(
    async (allSources: string[]) => {
      let cursor = 0;
      for (;;) {
        const f = filtersRef.current;
        const r = await pick({
          title: 'Filters',
          subtitle: '⏎ change · esc done',
          cursor,
          items: [
            { label: 'Minimum seeders', hint: f.minSeeders ? String(f.minSeeders) : 'any' },
            { label: 'Minimum size', hint: f.minSize ? formatBytes(f.minSize) : 'any' },
            { label: 'Maximum size', hint: f.maxSize ? formatBytes(f.maxSize) : 'any' },
            { label: 'Sources', hint: f.sources ? `${f.sources.length}/${allSources.length}` : 'all' },
            { label: 'Reset all filters', hint: '' },
          ],
        });
        if (!r) return backToNormal();
        cursor = r[0];
        if (cursor === 0) {
          const v = await ask({
            purpose: 'value',
            label: 'MIN SEEDERS',
            color: 'yellow',
            initial: f.minSeeders ? String(f.minSeeders) : '',
            placeholder: 'e.g. 10 (empty = any)',
          });
          if (v === null) continue;
          const n = v.trim() === '' ? 0 : Number.parseInt(v, 10);
          if (!Number.isFinite(n) || n < 0) say(`Invalid number “${v}”`, 'error');
          else setFilters({ ...filtersRef.current, minSeeders: n });
        } else if (cursor === 1 || cursor === 2) {
          const key = cursor === 1 ? 'minSize' : 'maxSize';
          const cur = filtersRef.current[key];
          const v = await ask({
            purpose: 'value',
            label: cursor === 1 ? 'MIN SIZE' : 'MAX SIZE',
            color: 'yellow',
            initial: cur ? formatBytes(cur).replace(/\s|B$/g, '') : '',
            placeholder: 'e.g. 700M, 4G, 50G (empty = any)',
          });
          if (v === null) continue;
          const n = parseSize(v);
          if (n === null) say(`Invalid size “${v}” (try 700M or 4G)`, 'error');
          else setFilters({ ...filtersRef.current, [key]: n });
        } else if (cursor === 3) {
          if (allSources.length === 0) {
            say('Search first to filter by source', 'info');
            continue;
          }
          const sel = await pick({
            title: 'Sources to show',
            multi: true,
            items: allSources.map((s) => ({ label: s })),
            checked: allSources.map((s) => !f.sources || f.sources.includes(s)),
          });
          if (sel === null) continue;
          const chosen = sel.map((i) => allSources[i]);
          setFilters({
            ...filtersRef.current,
            sources: chosen.length === allSources.length || chosen.length === 0 ? null : chosen,
          });
        } else {
          setFilters(NO_FILTERS);
        }
      }
    },
    [ask, backToNormal, pick, say],
  );

  // ------------------------------------------------ sources screen
  const loadIndexers = useCallback(async () => {
    try {
      setIxList(await backend.call<IndexerInfo[]>('indexers'));
    } catch (e) {
      say((e as Error).message, 'error');
    }
  }, [backend, say]);

  const openIndexers = useCallback(() => {
    ixChanged.current = false;
    setMode({ t: 'indexers', cursor: 0 });
    void loadIndexers();
  }, [loadIndexers, setMode]);

  const closeIndexers = useCallback(() => {
    backToNormal();
    if (ixChanged.current && queryRef.current) void runSearch(queryRef.current, tabRef.current, true);
  }, [backToNormal, runSearch]);

  const addSourceFlow = useCallback(
    async (cursor: number) => {
      const back = (c = cursor) => setMode({ t: 'indexers', cursor: c });
      const q = await ask({
        purpose: 'value',
        label: 'FIND SOURCE',
        color: ACCENT,
        placeholder: 'name of a public tracker, e.g. torlock (empty = list all)',
      });
      if (q === null) return back();
      setMode({ t: 'busy', message: 'Loading public sources…' });
      let cat: CatalogEntry[];
      try {
        cat = await backend.call<CatalogEntry[]>('catalog');
      } catch (e) {
        say((e as Error).message, 'error');
        return back();
      }
      const needle = q.trim().toLowerCase();
      const matches = cat.filter(
        (c) => !needle || c.name.toLowerCase().includes(needle) || c.id.includes(needle),
      );
      if (matches.length === 0) {
        say(`No public source matches “${q}”`, 'info');
        return back();
      }
      const r = await pick({
        title: 'Add a public source',
        subtitle: `${matches.length} available`,
        items: matches.map((c) => ({ label: c.name, hint: c.language })),
      });
      if (!r) return back();
      const c = matches[r[0]];
      setMode({ t: 'busy', message: `Adding ${c.name}…` });
      try {
        await backend.call('add_indexer', { id: c.id });
        ixChanged.current = true;
        const list = await backend.call<IndexerInfo[]>('indexers');
        setIxList(list);
        say(`Added ${c.name}`, 'ok');
        back(Math.max(0, list.findIndex((x) => x.id === c.id)));
      } catch (e) {
        say((e as Error).message, 'error');
        back();
      }
    },
    [ask, backend, pick, say, setMode],
  );

  const removeSourceFlow = useCallback(
    async (ix: IndexerInfo, cursor: number) => {
      const yes = await confirm(`Remove ${ix.name} from your sources?`);
      setMode({ t: 'indexers', cursor });
      if (!yes) return;
      try {
        await backend.call('remove_indexer', { id: ix.id });
        ixChanged.current = true;
        const list = await backend.call<IndexerInfo[]>('indexers');
        setIxList(list);
        setMode({ t: 'indexers', cursor: Math.min(cursor, Math.max(0, list.length - 1)) });
        say(`Removed ${ix.name}`, 'ok');
      } catch (e) {
        say((e as Error).message, 'error');
      }
    },
    [backend, confirm, say, setMode],
  );

  // ------------------------------------------------ list geometry
  const view = useMemo(() => applyView(results, tab, sort, filters), [results, tab, sort, filters]);
  const allSources = useMemo(() => {
    const s = new Set<string>();
    for (const r of results) for (const i of r.indexers) s.add(i);
    return [...s].sort();
  }, [results]);
  const suggestions: Suggestion[] = useMemo(() => suggestionsFor(mode), [mode]);

  let idx = selId ? view.findIndex((r) => r.id === selId) : -1;
  if (idx < 0) idx = Math.min(lastIdx.current, Math.max(0, view.length - 1));
  lastIdx.current = idx;
  const selected: Result | undefined = view[idx];

  const headerH = 4;
  const footerH = mode.t === 'input' ? 1 + suggestionsHeight(suggestions.length) + 1 + 1 : 3;
  const areaH = Math.max(2, rows - headerH - footerH);
  const pickerH =
    mode.t === 'picker'
      ? pickerHeight(mode.items.length, !!mode.subtitle, mode.multi, areaH - 4 >= 9 ? areaH - 4 : areaH)
      : 0;
  const listH = mode.t === 'help' || mode.t === 'indexers' ? areaH : areaH - pickerH;
  const perPage = Math.max(1, Math.floor(listH / ROW_HEIGHT));
  if (idx < scroll.current) scroll.current = idx;
  if (idx >= scroll.current + perPage) scroll.current = idx - perPage + 1;
  if (scroll.current > Math.max(0, view.length - perPage)) scroll.current = Math.max(0, view.length - perPage);
  const visibleRows = view.slice(scroll.current, scroll.current + perPage);


  const lastSearch = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

  // ------------------------------------------------ keys
  const quit = () => {
    flowToken.current++;
    exit();
  };

  const normalKey = (input: string, key: any) => {
    const now = Date.now();
    const pend = pendingKey.current && now - pendingKey.current.at < 600 ? pendingKey.current.k : null;
    pendingKey.current = null;
    const half = Math.max(1, Math.floor(perPage / 2));
    // recomputed from refs: a key earlier in the same burst may have changed the sort or tab
    const view = applyView(resultsRef.current, tabRef.current, sortRef.current, filtersRef.current);
    const moveTo = (i: number) => {
      if (view.length === 0) return;
      const c = Math.max(0, Math.min(view.length - 1, i));
      setSelId(view[c].id);
      lastIdx.current = c;
    };
    const fresh = selIdRef.current ? view.findIndex((x) => x.id === selIdRef.current) : -1;
    const idx = fresh >= 0 ? fresh : lastIdx.current;
    const marks = marksRef.current;
    const tab = tabRef.current;

    if (key.ctrl && input === 'c') return quit();
    if (key.ctrl && input === 'd') return moveTo(idx + half);
    if (key.ctrl && input === 'u') return moveTo(idx - half);
    if (input === 'j' || key.downArrow) return moveTo(idx + 1);
    if (input === 'k' || key.upArrow) return moveTo(idx - 1);
    if (key.pageDown) return moveTo(idx + perPage);
    if (key.pageUp) return moveTo(idx - perPage);
    if (input === 'G' || key.end) return moveTo(view.length - 1);
    if (input === 'g' || key.home) {
      if (pend === 'g' || key.home) return moveTo(0);
      pendingKey.current = { k: 'g', at: now };
      return;
    }
    if (input === '/' || input === 'i') return void openSearch();
    if (input === '?') return setMode({ t: 'help' });
    if (input === 'q') return quit();
    if (input === 'I') return openIndexers();
    if (key.tab || key.leftArrow || key.rightArrow) {
      const i = TABS.findIndex((t) => t.key === tab);
      const n = (i + (key.shift || key.leftArrow ? TABS.length - 1 : 1)) % TABS.length;
      return setTab(TABS[n].key);
    }
    if (/^[1-8]$/.test(input)) return setTab(TABS[Number(input) - 1].key);
    if (input === 's') return setSort(nextSort(sortRef.current));
    if (input === 'f') return void filtersFlow(allSources);
    if (input === 'u') {
      setMarks(new Set());
      return;
    }
    if (input === 'R' && (engine.state === 'error' || engine.state === 'stopped')) {
      void backend.call('retry_engine').catch((e) => say((e as Error).message, 'error'));
      return;
    }
    if (key.return && engine.state === 'missing') return void installFlow();
    const r = view[idx];
    if (!r) return;
    if (input === ' ') {
      const m = new Set(marks);
      if (m.has(r.id)) m.delete(r.id);
      else m.add(r.id);
      setMarks(m);
      return moveTo(idx + 1);
    }
    if (key.return || input === 'D') {
      const items = marks.size > 0 ? view.filter((x) => marks.has(x.id)) : [r];
      // marked results hidden by the current tab/filters are still sent
      const hidden = marks.size > 0 ? results.filter((x) => marks.has(x.id) && !items.includes(x)) : [];
      return void sendFlow([...items, ...hidden], input === 'D');
    }
    if (input === 'o') {
      if (!r.details) return say('No web page for this result', 'info');
      execFile('open', [r.details], () => {});
      return say(`Opened ${truncate(r.details, 60)}`, 'ok');
    }
    if (input === 'y') {
      if (r.magnet) {
        copy(r.magnet);
        return say('Magnet copied', 'ok');
      }
      setMode({ t: 'busy', message: 'Fetching the magnet…' });
      const token = ++flowToken.current;
      void backend
        .call<string>('resolve', { item: slim(r) })
        .then((v) => {
          if (token !== flowToken.current) return;
          backToNormal();
          copy(v);
          say(v.startsWith('magnet:') ? 'Magnet copied' : `No magnet: copied the .torrent path ${tildify(v)}`, 'ok');
        })
        .catch((e) => {
          if (token !== flowToken.current) return;
          backToNormal();
          say((e as Error).message, 'error');
        });
      return;
    }
  };

  const indexersKey = (m: { t: 'indexers'; cursor: number }, input: string, key: any) => {
    const list = ixListRef.current ?? [];
    const n = list.length;
    const now = Date.now();
    const pend = pendingKey.current && now - pendingKey.current.at < 600 ? pendingKey.current.k : null;
    pendingKey.current = null;
    if (key.ctrl && input === 'c') return quit();
    if (key.escape || input === 'q' || input === 'I') return closeIndexers();
    if (input === 'j' || key.downArrow) return setMode({ ...m, cursor: Math.min(Math.max(0, n - 1), m.cursor + 1) });
    if (input === 'k' || key.upArrow) return setMode({ ...m, cursor: Math.max(0, m.cursor - 1) });
    if (key.pageDown) return setMode({ ...m, cursor: Math.min(Math.max(0, n - 1), m.cursor + 10) });
    if (key.pageUp) return setMode({ ...m, cursor: Math.max(0, m.cursor - 10) });
    if (input === 'G' || key.end) return setMode({ ...m, cursor: Math.max(0, n - 1) });
    if (input === 'g' || key.home) {
      if (pend === 'g' || key.home) return setMode({ ...m, cursor: 0 });
      pendingKey.current = { k: 'g', at: now };
      return;
    }
    if (input === 'a') return void addSourceFlow(m.cursor);
    if (input === 'r') return void loadIndexers();
    const ix = list[m.cursor];
    if (!ix) return;
    if (input === ' ' || key.return) {
      const enabled = !ix.enabled;
      setIxList(list.map((x) => (x.id === ix.id ? { ...x, enabled } : x)));
      ixChanged.current = true;
      void backend.call('set_indexer', { id: ix.id, enabled }).catch((e) => say((e as Error).message, 'error'));
      return;
    }
    if (input === 'x' || key.delete || key.backspace) return void removeSourceFlow(ix, m.cursor);
    if (input === 'd') {
      if (pend === 'd') return void removeSourceFlow(ix, m.cursor);
      pendingKey.current = { k: 'd', at: now };
      return;
    }
    if (input === 'o' && ix.site) {
      execFile('open', [ix.site], () => {});
      return;
    }
  };

  usePaste((text) => {
    const clean = text.replace(/[\r\n]+/g, ' ').trim();
    const m = modeRef.current;
    if (m.t === 'normal') {
      void openSearch(clean);
    } else if (m.t === 'input') {
      const r = editInput(m, clean, {});
      if (r) setMode(r);
    }
  });

  const handleKey = (input: string, key: any): void => {
    const m = modeRef.current;
    // a burst of plain keys outside text input: handle them one by one
    if (input.length > 1 && !key.ctrl && !key.meta && m.t !== 'input') {
      for (const ch of input) handleKey(ch, {});
      return;
    }

    // ---------- input
    if (m.t === 'input') {
      if (key.escape || (key.ctrl && input === 'c')) {
        flowToken.current++;
        m.resolve(null);
        return;
      }
      const sugg = suggestionsFor(m);
      const hasSugg = sugg.length > 0;
      const accept = (s: Suggestion): InputMode => ({
        ...m,
        value: s.value,
        cursor: Array.from(s.value).length,
        sel: 0,
        nav: false,
      });
      if (key.return) {
        if (m.purpose === 'dir' && hasSugg && isPathLike(m.value) && (m.nav || pathExists(m.value) === null)) {
          return setMode(accept(sugg[Math.min(m.sel, sugg.length - 1)]));
        }
        m.resolve(m.value);
        return;
      }
      if (m.purpose === 'search') {
        const hist = history.current;
        if (key.tab) {
          const i = TABS.findIndex((t) => t.key === tabRef.current);
          const k = TABS[(i + (key.shift ? TABS.length - 1 : 1)) % TABS.length].key;
          setTabState(k);
          tabRef.current = k;
          return;
        }
        if ((key.upArrow || (key.ctrl && input === 'p')) && hist.length > 0) {
          const h = Math.min(hist.length - 1, m.hist + 1);
          const value = hist[h];
          return setMode({ ...m, hist: h, draft: m.hist === -1 ? m.value : m.draft, value, cursor: Array.from(value).length });
        }
        if ((key.downArrow || (key.ctrl && input === 'n')) && m.hist >= 0) {
          const h = m.hist - 1;
          const value = h < 0 ? m.draft : hist[h];
          return setMode({ ...m, hist: h, value, cursor: Array.from(value).length });
        }
      }
      if (key.tab && !key.shift && m.purpose === 'dir') {
        if (hasSugg) return setMode(accept(sugg[Math.min(m.sel, sugg.length - 1)]));
        if (pathExists(m.value) === 'dir' && !m.value.endsWith('/'))
          return setMode({ ...m, value: m.value + '/', cursor: Array.from(m.value).length + 1 });
        return;
      }
      if (hasSugg && key.rightArrow && m.cursor === Array.from(m.value).length) {
        return setMode(accept(sugg[Math.min(m.sel, sugg.length - 1)]));
      }
      if (hasSugg && (key.downArrow || (key.ctrl && input === 'n'))) {
        return setMode({ ...m, sel: (m.sel + 1) % sugg.length, nav: true });
      }
      if (hasSugg && (key.upArrow || (key.ctrl && input === 'p') || (key.tab && key.shift))) {
        return setMode({ ...m, sel: (m.sel - 1 + sugg.length) % sugg.length, nav: true });
      }
      const r = editInput(m, input, key);
      if (r) setMode(r);
      return;
    }

    // ---------- picker
    if (m.t === 'picker') {
      const n = m.items.length;
      if (key.escape || input === 'q' || (key.ctrl && input === 'c')) return m.resolve(null);
      if (input === 'j' || key.downArrow) return setMode({ ...m, cursor: Math.min(n - 1, m.cursor + 1) });
      if (input === 'k' || key.upArrow) return setMode({ ...m, cursor: Math.max(0, m.cursor - 1) });
      if (input === 'g' || key.home) return setMode({ ...m, cursor: 0 });
      if (input === 'G' || key.end) return setMode({ ...m, cursor: n - 1 });
      if ((key.ctrl && input === 'd') || key.pageDown) return setMode({ ...m, cursor: Math.min(n - 1, m.cursor + 10) });
      if ((key.ctrl && input === 'u') || key.pageUp) return setMode({ ...m, cursor: Math.max(0, m.cursor - 10) });
      if (m.multi && input === ' ') {
        const checked = [...m.checked];
        checked[m.cursor] = !checked[m.cursor];
        return setMode({ ...m, checked, cursor: Math.min(n - 1, m.cursor + 1) });
      }
      if (m.multi && input === 'a') {
        const all = m.checked.every(Boolean);
        return setMode({ ...m, checked: m.checked.map(() => !all) });
      }
      if (!m.multi && /^[1-9]$/.test(input) && Number(input) <= n) return m.resolve([Number(input) - 1]);
      if (key.return) {
        if (m.multi) return m.resolve(m.checked.flatMap((c, i) => (c ? [i] : [])));
        return m.resolve([m.cursor]);
      }
      return;
    }

    // ---------- confirm ([Y/n]: Enter means yes)
    if (m.t === 'confirm') {
      if (input === 'y' || input === 'Y' || key.return) return m.resolve(true);
      if (input === 'n' || input === 'N' || key.escape || input === 'q') return m.resolve(false);
      return;
    }

    if (m.t === 'help') return backToNormal();
    if (m.t === 'indexers') return indexersKey(m, input, key);

    // ---------- busy
    if (m.t === 'busy') {
      if (key.escape || (key.ctrl && input === 'c')) {
        flowToken.current++;
        backToNormal();
        say('Cancelled', 'info');
      }
      return;
    }

    normalKey(input, key);
  };
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;
  const keyQueue = useRef<[string, any][]>([]);
  const pumping = useRef(false);

  useInput((input, key) => {
    keyQueue.current.push(...splitBurst(input, key));
    if (pumping.current) return;
    pumping.current = true;
    // one event per macrotask so that flows resumed by a resolved dialog
    // (microtasks) can open the next dialog before the following key
    const step = () => {
      const ev = keyQueue.current.shift();
      if (!ev) {
        pumping.current = false;
        return;
      }
      handleKeyRef.current(ev[0], ev[1]);
      setTimeout(step, 0);
    };
    step();
  });

  // ------------------------------------------------ render
  const center = (lines: React.ReactNode) => (
    <Box height={listH} flexDirection="column" alignItems="center" justifyContent="center" flexShrink={0}>
      {lines}
    </Box>
  );

  let body: React.ReactNode;
  if (mode.t === 'help') {
    body = <Help width={width} height={listH} />;
  } else if (mode.t === 'indexers') {
    body = <Indexers list={ixList} cursor={mode.cursor} last={lastSearch} width={width} height={listH} />;
  } else if (listH <= 0) {
    body = null;
  } else if (engine.state === 'missing' && view.length === 0) {
    body = center(
      <>
        <Text bold>Jackett is needed to search torrent sites</Text>
        <Text color={DIM}> </Text>
        <Text color={DIM}>
          Press <Text color={ACCENT}>⏎</Text> to install it (free, open source, via Homebrew).
        </Text>
      </>,
    );
  } else if (engine.state === 'installing' && view.length === 0) {
    body = center(
      <>
        <Text color="yellow">
          {SPINNER[spin % SPINNER.length]} Installing Jackett with Homebrew…
        </Text>
        <Text color={DIM}>{truncate(progress, width - 4)}</Text>
      </>,
    );
  } else if (view.length === 0) {
    if (!query) {
      body = center(
        <>
          <Text bold>Search every torrent site at once</Text>
          <Text color={DIM}> </Text>
          <Text color={DIM}>
            Press <Text color={ACCENT}>/</Text> and type what you are looking for.
          </Text>
          <Text color={DIM}>
            <Text color={ACCENT}>⏎</Text> on a result sends it to dl.
          </Text>
        </>,
      );
    } else if (searching) {
      const waiting = engine.state !== 'ready' && engine.state !== 'error';
      body = center(
        <Text color={ACCENT}>
          {SPINNER[spin % SPINNER.length]}{' '}
          {waiting
            ? 'Starting search engine…'
            : `Searching ${sources.length || ''} sources for “${truncate(query, 40)}”…`}
        </Text>,
      );
    } else {
      const hidden = results.length - view.length;
      body = center(
        <>
          <Text bold>No results for “{truncate(query, 50)}”</Text>
          {hidden > 0 ? (
            <Text color={DIM}>
              {hidden} hidden by the category or filters (<Text color={ACCENT}>1</Text> = ALL,{' '}
              <Text color={ACCENT}>f</Text> = filters)
            </Text>
          ) : (
            <Text color={DIM}>
              Try other words, or check the sources with <Text color={ACCENT}>I</Text>.
            </Text>
          )}
        </>,
      );
    }
  } else {
    body = (
      <Box flexDirection="column" height={listH} overflow="hidden" flexShrink={0}>
        {visibleRows.map((r) => (
          <ResultRow
            key={r.id}
            r={r}
            selected={r.id === selected?.id}
            marked={marks.has(r.id)}
            sent={sent.has(r.id)}
            width={width}
          />
        ))}
      </Box>
    );
  }

  const overlay =
    mode.t === 'picker' ? (
      <Picker
        title={mode.title}
        subtitle={mode.subtitle}
        items={mode.items}
        multi={mode.multi}
        cursor={mode.cursor}
        checked={mode.checked}
        width={width}
        height={pickerH}
      />
    ) : null;

  let footer: React.ReactNode;
  if (mode.t === 'input') {
    const keys =
      mode.purpose === 'search'
        ? `⏎ search · tab category (${TABS.find((t) => t.key === tab)?.label}) · ↑↓ history · esc cancel`
        : mode.purpose === 'dir'
          ? 'tab/→ complete · ↑↓ browse · ⏎ save here · esc cancel'
          : '⏎ apply · esc cancel';
    footer = (
      <>
        <Suggestions items={suggestions} sel={Math.min(mode.sel, Math.max(0, suggestions.length - 1))} width={width} />
        <InputLine
          label={mode.label}
          color={mode.color}
          value={mode.value}
          cursor={mode.cursor}
          width={width}
          placeholder={mode.placeholder}
        />
        <Text color={DIM} wrap="truncate">
          {keys}
        </Text>
      </>
    );
  } else {
    let status: React.ReactNode;
    if (mode.t === 'confirm') {
      status = (
        <Text color="yellow" wrap="truncate">
          {mode.message} <Text bold>[Y/n]</Text>
        </Text>
      );
    } else if (mode.t === 'busy') {
      status = (
        <Text color={ACCENT} wrap="truncate">
          {SPINNER[spin % SPINNER.length]} {mode.message} <Text color={DIM}>(esc to cancel)</Text>
        </Text>
      );
    } else if (notice) {
      const color = notice.level === 'error' ? 'red' : notice.level === 'ok' ? 'green' : ACCENT;
      status = (
        <Text color={color} wrap="truncate">
          {notice.level === 'error' ? '✗ ' : notice.level === 'ok' ? '✓ ' : '› '}
          {notice.text}
        </Text>
      );
    } else if (mode.t === 'indexers') {
      const ix = ixList?.[mode.cursor];
      status = (
        <Text color={DIM} wrap="truncate">
          {ix ? `${ix.id} · ${ix.site}${ix.language ? ` · ${ix.language}` : ''}` : ' '}
        </Text>
      );
    } else if (selected && mode.t === 'normal') {
      status = (
        <Text color={DIM} wrap="truncate">
          {selected.title}
          {selected.magnet ? '' : '  (.torrent)'}
        </Text>
      );
    } else {
      status = <Text> </Text>;
    }
    const keys =
      mode.t === 'picker'
        ? ''
        : mode.t === 'confirm'
          ? '⏎ y yes · n no'
          : mode.t === 'indexers'
          ? '↑↓ move · space on/off · a add · ⌫ remove · o website · r refresh · esc back'
          : engine.state === 'error' || engine.state === 'stopped'
            ? 'R restart engine · / search · ? help · q quit'
            : '/ search · ⏎ → dl · D folder · space mark · ←→ category · s sort · f filter · I sources · ? help · q quit';
    footer = (
      <>
        {status}
        <Text color={DIM} wrap="truncate">
          {keys}
        </Text>
      </>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={rows}>
      <Header
        width={width}
        query={mode.t === 'input' && mode.purpose === 'search' ? mode.value : query}
        engine={engine}
        sources={sources}
        count={view.length}
        total={results.length}
        searching={searching}
        elapsed={elapsed}
        spin={spin}
        progress={progress}
      />
      <Tabs width={width} tab={tab} sort={sort} filters={filters} marked={marks.size} />
      {body}
      {overlay}
      <Box flexDirection="column" width={width} flexShrink={0}>
        <Text color={DIM}>{'─'.repeat(width)}</Text>
        {footer}
      </Box>
    </Box>
  );
}
