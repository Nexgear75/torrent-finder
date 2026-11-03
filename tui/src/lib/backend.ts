import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export function dataDir(): string {
  return process.env.TF_DATA_DIR || path.join(os.homedir(), '.local/share/torrent-finder');
}

/** Finds tf-backend: env override, next to this binary, dev builds, then PATH. */
export function backendBinary(): string {
  if (process.env.TF_BACKEND) return process.env.TF_BACKEND;
  const candidates = [
    path.join(path.dirname(process.execPath), 'tf-backend'),
    path.resolve(import.meta.dir, '../../../backend/target/release/tf-backend'),
    path.resolve(import.meta.dir, '../../../backend/target/debug/tf-backend'),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {}
  }
  return 'tf-backend';
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/**
 * The Rust backend runs as our child and speaks JSON lines on stdin/stdout.
 * Closing its stdin makes it stop Jackett and exit, so nothing outlives tf.
 * Emits every backend event by name ('status', 'progress', 'search_start',
 * 'results', 'search_done') and 'exit' if the process dies.
 */
export class Backend extends EventEmitter {
  private child: ChildProcess;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private exited: Promise<void>;
  alive = true;

  constructor() {
    super();
    fs.mkdirSync(dataDir(), { recursive: true });
    const log = fs.openSync(path.join(dataDir(), 'backend.log'), 'w');
    this.child = spawn(backendBinary(), [], { stdio: ['pipe', 'pipe', log] });
    fs.closeSync(log);
    this.exited = new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.once('error', () => resolve());
    });
    this.child.once('error', (e) => this.onExit(`cannot start tf-backend: ${e.message}`));
    this.child.once('exit', (code) => this.onExit(`tf-backend exited (code ${code})`));
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => this.onData(chunk));
    this.child.stdin!.on('error', () => {});
  }

  private onExit(message: string) {
    if (!this.alive) return;
    this.alive = false;
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
    this.emit('exit', message);
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.event === 'string') {
        this.emit(msg.event, msg.data);
      } else if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error ?? 'error'));
      }
    }
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.alive) return Promise.reject(new Error('tf-backend is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  /** Closes stdin (backend stops Jackett and exits); kills it after `ms`. */
  async close(ms = 5000): Promise<void> {
    this.alive = false;
    try {
      this.child.stdin!.end();
    } catch {}
    const timer = setTimeout(() => this.child.kill('SIGTERM'), ms);
    await this.exited;
    clearTimeout(timer);
  }
}
