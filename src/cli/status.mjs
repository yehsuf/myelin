/**
 * myelin status — compact one-liner for shell prompt / statusline integration.
 *
 * Outputs a summary of proxy health and compression savings without reading
 * the full stats log.  Designed to be called from shell prompts (Starship,
 * oh-my-zsh RPROMPT, etc.) with minimal latency.
 *
 * Savings data comes from the status-cache.json written by `myelin stats`.
 * If the cache doesn't exist yet, health and engine are still shown.
 *
 * Formats:
 *   plain   (default) — human-readable one-liner, no ANSI codes
 *   json    — machine-readable JSON object
 *   prompt  — minimal ANSI-colored string for shell prompt embedding
 */

import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { loadConfig } from '../config/reader.mjs';
import { managedPaths, joinManaged } from '../shared/myelin-paths.mjs';
import { STATUS_CACHE_FILENAME } from './stats.mjs';

// ─── health probe ─────────────────────────────────────────────────────────────

/** @param {number} port @param {number} ms */
function probeAlive(port, ms = 800, exec = execSync) {
  // Use -s (silent) without -f so we treat any HTTP response as "alive".
  // Only ECONNREFUSED (curl exit 7) means the service is truly down.
  try {
    exec(`curl -s --max-time 0.8 -o /dev/null http://127.0.0.1:${port}/`, { timeout: ms + 200 });
    return true;
  } catch (e) {
    return e.status !== 7 && e.status !== undefined;
  }
}

// ─── status cache (written by `myelin stats`, read here for instant response) ─

/**
 * Read the status cache written by `myelin stats`.
 * Returns null if the cache doesn't exist or can't be parsed.
 * @param {string} cachePath
 * @param {typeof readFileSync} readFn
 */
function readStatusCache(cachePath, readFn = readFileSync) {
  try {
    return JSON.parse(readFn(cachePath, 'utf8'));
  } catch { return null; }
}

// ─── engine label ─────────────────────────────────────────────────────────────

function engineLabel(cfg) {
  const engine = cfg?.proxy?.engine ?? 'headroom_lite';
  return engine === 'headroom' ? 'headroom' : 'hlite';
}

// ─── ANSI helpers (prompt format only) ───────────────────────────────────────

const C = {
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  dim: '\x1b[2m', reset: '\x1b[0m',
};

// ─── main ─────────────────────────────────────────────────────────────────────

/**
 * @param {{ format?: 'plain'|'json'|'prompt', home?: string, env?: NodeJS.ProcessEnv,
 *           platform?: string, _exec?: typeof execSync, _readFile?: typeof readFileSync,
 *           _probeAlive?: typeof probeAlive, _existsSync?: typeof existsSync,
 *           _loadConfig?: typeof loadConfig }} opts
 */
export async function runStatus({
  format = 'plain',
  home = homedir(),
  env = process.env,
  platform = process.platform,
  _exec = execSync,
  _readFile = readFileSync,
  _probeAlive = probeAlive,
  _existsSync = existsSync,
  _loadConfig = loadConfig,
} = {}) {
  const paths = managedPaths({ home, env, platform });
  const cfg = await _loadConfig(paths.configPath);
  const engine = engineLabel(cfg);

  const hlitePort = cfg?.proxy?.headroom_lite?.port ?? 8790;
  const mitmPort  = cfg?.proxy?.mitm?.port ?? 8888;
  const mitmEnabled = cfg?.proxy?.mitm?.enabled ?? false;

  const hliteOk = _probeAlive(hlitePort, 800, _exec);
  const mitmOk  = mitmEnabled ? _probeAlive(mitmPort, 800, _exec) : null;

  // Read savings from the status-cache written by `myelin stats` (fast, no log parsing).
  const cachePath = joinManaged(paths.root, STATUS_CACHE_FILENAME);
  const cacheExists = _existsSync(cachePath);
  const cache = cacheExists ? readStatusCache(cachePath, _readFile) : null;

  const data = {
    engine,
    hlite: hliteOk,
    mitm: mitmOk,
    mitmEnabled,
    avgCompressionPct: cache?.avgCompressionPct ?? null,
    reqCount: cache?.reqCount ?? 0,
    topModel: cache?.topModel ?? null,
  };

  if (format === 'json') {
    process.stdout.write(JSON.stringify(data) + '\n');
    return;
  }

  const proxyOk = hliteOk && (mitmEnabled ? mitmOk : true);
  const healthMark = proxyOk ? '✓' : '✗';
  const savingsPart = data.avgCompressionPct !== null
    ? `${data.avgCompressionPct.toFixed(1)}% saved`
    : null;
  const modelPart = data.topModel ? `[${data.topModel}]` : null;

  if (format === 'prompt') {
    const color = proxyOk ? C.green : C.red;
    const parts = [
      `${color}⚡${C.reset}`,
      `myelin`,
      `${color}${healthMark}${C.reset} ${engine}`,
      savingsPart ? `${C.dim}${savingsPart}${C.reset}` : null,
      modelPart ? `${C.dim}${modelPart}${C.reset}` : null,
    ].filter(Boolean);
    process.stdout.write(parts.join('  ') + '\n');
    return;
  }

  // plain (default)
  const parts = [
    `myelin ${healthMark} ${engine}`,
    savingsPart,
    modelPart,
  ].filter(Boolean);
  process.stdout.write(parts.join('  ') + '\n');
}
