#!/usr/bin/env node
/**
 * myelin messages watcher — deployed to ~/.myelin/messages/watcher.mjs
 *
 * Uses Node.js fs.watch() (kqueue on macOS, inotify on Linux) to detect
 * changes to messages.md and write the new mtime to .new-message so that
 * check-messages.sh needs only a cheap marker-file comparison.
 *
 * PID file: .watcher-pid  (read by check-messages.sh to detect if alive)
 * Marker:   .new-message  (holds mtime string of last detected change)
 * Log:      watcher.log
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MSG_DIR  = path.join(os.homedir(), '.myelin', 'messages');
const MSG_FILE = path.join(MSG_DIR, 'messages.md');
const MARKER   = path.join(MSG_DIR, '.new-message');
const PID_FILE = path.join(MSG_DIR, '.watcher-pid');
const LOG_FILE = path.join(MSG_DIR, 'watcher.log');

function currentMtime() {
  try { return String(Math.floor(fs.statSync(MSG_FILE).mtimeMs / 1000)); }
  catch { return '0'; }
}

let logStream;
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  try { logStream?.write(line); } catch {}
}

function setup() {
  fs.mkdirSync(MSG_DIR, { recursive: true });
  if (!fs.existsSync(MSG_FILE)) fs.writeFileSync(MSG_FILE, '');

  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  fs.writeFileSync(PID_FILE, String(process.pid));
  fs.writeFileSync(MARKER, currentMtime());
  log(`started pid=${process.pid} node=${process.version}`);
}

let watcher = null;

function startWatch() {
  // Guard: do not double-watch
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }

  try {
    watcher = fs.watch(MSG_FILE, { persistent: true }, (event) => {
      if (event === 'change' || event === 'rename') {
        const m = currentMtime();
        try { fs.writeFileSync(MARKER, m); } catch {}
        log(`change event=${event} mtime=${m}`);

        // 'rename' events on some platforms mean the file was replaced.
        // Re-attach the watcher so we don't miss future changes.
        if (event === 'rename') {
          setTimeout(startWatch, 200);
        }
      }
    });

    watcher.on('error', (err) => {
      log(`watch error: ${err.message} — restarting in 2s`);
      watcher = null;
      setTimeout(startWatch, 2000);
    });

    log('fs.watch active');
  } catch (err) {
    log(`failed to start fs.watch: ${err.message} — retrying in 5s`);
    setTimeout(startWatch, 5000);
  }
}

function shutdown() {
  log('shutting down');
  try { watcher?.close(); } catch {}
  try { logStream?.end(); } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => log(`uncaughtException: ${err.message}`));

setup();
startWatch();
