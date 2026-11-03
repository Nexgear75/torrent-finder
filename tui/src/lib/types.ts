export type Kind = 'games' | 'movies' | 'tv' | 'music' | 'apps' | 'books' | 'anime' | 'other';

export interface Result {
  id: string;
  title: string;
  /** Every indexer that returned it, best first. */
  indexers: string[];
  category: string;
  kind: Kind;
  size: number;
  seeders: number;
  leechers: number;
  date: string | null;
  magnet: string | null;
  link: string | null;
  details: string | null;
}

export type EngineStateName =
  | 'checking'
  | 'missing'
  | 'installing'
  | 'starting'
  | 'configuring'
  | 'ready'
  | 'error'
  | 'stopped';

export interface EngineStatus {
  state: EngineStateName;
  brew?: boolean;
  message?: string;
}

export interface IndexerInfo {
  id: string;
  name: string;
  enabled: boolean;
  language: string;
  site: string;
  error: string | null;
}

export interface CatalogEntry {
  id: string;
  name: string;
  language: string;
  description: string;
}

export interface SourceStatus {
  id: string;
  name: string;
  state: 'pending' | 'ok' | 'error';
  count?: number;
  error?: string;
  ms?: number;
}

export interface SendResult {
  sent: string[];
  errors: { title: string; error: string }[];
}

export interface DlConfig {
  download_dir: string;
  max_concurrent: number;
}
