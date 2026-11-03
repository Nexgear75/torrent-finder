import React from 'react';
import { render } from 'ink';
import { App } from './App';
import { Backend } from './lib/backend';
import { VERSION, autoUpdateWorker, maybeAutoUpdate, takeUpdateNotice, updateCommand } from './lib/update';

const HELP = `tf ${VERSION} — search every torrent site at once, send results to dl

Usage:
  tf                 open the interface
  tf <words…>        open and search right away
  tf update          update now (tf, dl and Jackett)
  tf --version

Inside: press ? for keys. Sources are managed with I.
Data (search engine, history, logs): ~/.local/share/torrent-finder
Updates install themselves in the background (TF_NO_AUTOUPDATE=1 to disable).`;

async function main() {
  const args = process.argv.slice(2);
  // hidden commands used by the background updater
  if (args[0] === '__auto-update') return autoUpdateWorker();
  if (args[0] === '__maybe-update') return maybeAutoUpdate();
  if (args[0] === 'update' && args.length <= 2) return updateCommand();
  if (args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return;
  }
  if (args.includes('-V') || args.includes('--version')) {
    console.log(`tf ${VERSION}`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('tf needs an interactive terminal');
    process.exit(1);
  }

  maybeAutoUpdate();
  // starts the search engine right away, while the user types
  const backend = new Backend();
  const stop = async () => {
    await backend.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGHUP', () => void stop());

  const initial = args.filter((a) => !a.startsWith('--')).join(' ');
  const app = render(<App backend={backend} initialQuery={initial || undefined} startNotice={takeUpdateNotice() ?? undefined} />, {
    alternateScreen: true,
    exitOnCtrlC: false,
    maxFps: 30,
  });
  await app.waitUntilExit();
  await stop();
}

void main();
