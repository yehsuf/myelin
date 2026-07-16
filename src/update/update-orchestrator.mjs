import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { load as loadYaml, dump as dumpYaml } from 'js-yaml';

import {
  buildCompressionRuntimes,
  migrateLegacyCompressionConfig,
  probeCompressionHealth,
  resolveCompressionConfig,
} from './engine-selection.mjs';
import { detectOS } from '../detect/os.mjs';
import { COMPONENTS, validateComponentManifest } from './component-manifest.mjs';
import {
  detectManagedComponent,
  isStageComplete,
  stageComponent,
} from './component-installers.mjs';
import { resolveReleaseTarget } from './release-channels.mjs';
import {
  DEFAULT_HEARTBEAT_MAX_CONSECUTIVE_FAILURES,
  classifyHeartbeatFailure,
  evaluateHeartbeatFailure,
} from './heartbeat-failure-budget.mjs';
import {
  installStableLauncher,
  readReleasePointers,
  restoreRelease,
  stageRelease,
} from './release-store.mjs';
import { writeCurrentRelease } from '../runtime/release-store.mjs';
import {
  componentVersionDir,
  readPointersReadOnly,
  restoreComponent,
} from './version-store.mjs';

export const UPDATE_LOCK_SCHEMA_VERSION = 1;
export const UPDATE_JOURNAL_SCHEMA_VERSION = 1;
export const UPDATE_LOCK_FILENAME = 'update.lock';
export const UPDATE_JOURNAL_FILENAME = 'update-journal.json';

const DEFAULT_STALE_LOCK_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_HEALTH_RETRY_MS = 1_000;
const DEFAULT_SERVICE_HEALTH_DEADLINE_MS = 30_000;
const DEFAULT_TOTAL_HEALTH_DEADLINE_MS = 120_000;
const STAGED_ABORT_TERM_GRACE_MS = 5_000;
const STAGED_ABORT_KILL_GRACE_MS = 5_000;
const BACKEND_COMPONENT_NAMES = new Set(['headroomLite', 'headroomOriginal']);
const SAFE_LOCK_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function updateError(message, code, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

function stagedChild(directory, ...parts) {
  const root = resolve(directory);
  const child = resolve(root, ...parts);
  const fromRoot = relative(root, child);
  if (
    fromRoot.length === 0
    || fromRoot === '..'
    || fromRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRoot)
  ) {
    throw updateError('Staged source path is unsafe.', 'ERR_UPDATE_STAGED_SOURCE');
  }
  return child;
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function isAlreadyExists(error) {
  return error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY';
}

function isLinkUnsupported(error) {
  return (
    error?.code === 'ENOSYS'
    || error?.code === 'EPERM'
    || error?.code === 'EXDEV'
    || error?.code === 'EOPNOTSUPP'
    || error?.code === 'EMLINK'
  );
}

function isWindows(platform = process.platform) {
  return platform === 'win32' || platform === 'windows';
}

function safeNow(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('now must return a non-negative safe integer.');
  }
  return value;
}

function ensureString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${label} must be a non-empty path string.`);
  }
  return value;
}

function validateLockToken(value, label = 'lock token') {
  if (typeof value !== 'string' || !SAFE_LOCK_TOKEN.test(value)) {
    throw new TypeError(`${label} must be a safe non-empty token.`);
  }
  return value;
}

function regularFile(fs, path, { allowMissing = false, label = 'file' } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(path);
  } catch (error) {
    if (allowMissing && isMissing(error)) return null;
    throw error;
  }
  if (
    typeof stat?.isFile !== 'function'
    || !stat.isFile()
    || (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink())
  ) {
    throw updateError(`${label} must be a regular file: ${path}`, 'ERR_UPDATE_UNSAFE_PATH');
  }
  return stat;
}

function fsyncPath(fs, path) {
  if (
    typeof fs.openSync !== 'function'
    || typeof fs.fsyncSync !== 'function'
    || typeof fs.closeSync !== 'function'
  ) {
    return;
  }
  const descriptor = fs.openSync(path, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(fs, path, platform) {
  try {
    fsyncPath(fs, path);
  } catch (error) {
    if (isWindows(platform) && ['EACCES', 'EISDIR', 'EPERM'].includes(error?.code)) return;
    throw error;
  }
}

function fsyncFile(fs, path, platform) {
  try {
    fsyncPath(fs, path);
  } catch (error) {
    // Windows: fsync on a read-only file descriptor (opened with 'r') returns
    // EPERM because Windows does not allow fsync on non-write-mode handles.
    // Skip silently — the OS write cache is flushed at a coarser granularity.
    if (isWindows(platform) && ['EACCES', 'EPERM'].includes(error?.code)) return;
    throw error;
  }
}

function defaultDurability(fs, platform) {
  return {
    fsyncFile: path => fsyncFile(fs, path, platform),
    fsyncDirectory: path => fsyncDirectory(fs, path, platform),
  };
}

function normalizeDurability(fs, durability, platform) {
  const fallback = defaultDurability(fs, platform);
  return {
    fsyncFile: durability?.fsyncFile ?? fallback.fsyncFile,
    fsyncDirectory: durability?.fsyncDirectory ?? fallback.fsyncDirectory,
  };
}

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function validateLockRecord(record, path) {
  if (
    typeof record !== 'object'
    || record === null
    || record.schemaVersion !== UPDATE_LOCK_SCHEMA_VERSION
    || typeof record.token !== 'string'
    || !SAFE_LOCK_TOKEN.test(record.token)
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || !Number.isSafeInteger(record.startedAt)
    || record.startedAt < 0
    || !Number.isSafeInteger(record.heartbeatAt)
    || record.heartbeatAt < record.startedAt
  ) {
    throw updateError(`Update lock is malformed: ${path}`, 'ERR_UPDATE_LOCK_INVALID');
  }
  return record;
}

function writeDescriptor(fs, descriptor, bytes) {
  if (typeof fs.writeSync === 'function') {
    fs.writeSync(descriptor, bytes);
    return;
  }
  throw new TypeError('fs.writeSync is required for durable lock writes.');
}

/**
 * A global lock uses a fencing token rather than PID ownership alone. PID is
 * advisory: an expired heartbeat is reclaimable even when a PID was reused.
 */
export function createUpdateLock({
  fs = nodeFs,
  now = Date.now,
  pid = process.pid,
  isPidAlive = defaultIsPidAlive,
  randomToken = randomUUID,
  staleAfterMs = DEFAULT_STALE_LOCK_MS,
  platform = process.platform,
  durability,
  useWorkerHeartbeat = true,
} = {}) {
  if (!fs || typeof fs !== 'object') throw new TypeError('fs must be an object.');
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('pid must be a positive integer.');
  if (typeof isPidAlive !== 'function') throw new TypeError('isPidAlive must be a function.');
  if (typeof randomToken !== 'function') throw new TypeError('randomToken must be a function.');
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
    throw new TypeError('staleAfterMs must be a positive safe integer.');
  }

  const durable = normalizeDurability(fs, durability, platform);

  function read(path, { allowMissing = false } = {}) {
    const stat = regularFile(fs, path, { allowMissing, label: 'Update lock' });
    if (stat === null) return null;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch (error) {
      if (allowMissing && isMissing(error)) return null;
      throw updateError(`Update lock is malformed: ${path}`, 'ERR_UPDATE_LOCK_INVALID', error);
    }
    return validateLockRecord(parsed, path);
  }

  function writeExclusive(path, record) {
    fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify(record);
    if (typeof fs.openSync === 'function') {
      const descriptor = fs.openSync(path, 'wx', 0o600);
      try {
        writeDescriptor(fs, descriptor, bytes);
        if (typeof fs.fsyncSync === 'function') fs.fsyncSync(descriptor);
      } finally {
        if (typeof fs.closeSync === 'function') fs.closeSync(descriptor);
      }
    } else {
      fs.writeFileSync(path, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      durable.fsyncFile(path);
    }
    durable.fsyncDirectory(dirname(path));
  }

  function writeInPlace(path, record) {
    const temporaryPath = `${path}.heartbeat-${record.token}`;
    if (regularFile(fs, temporaryPath, {
      allowMissing: true,
      label: 'Update lock heartbeat temporary',
    }) !== null) {
      fs.unlinkSync(temporaryPath);
      durable.fsyncDirectory(dirname(path));
    }
    writeExclusive(temporaryPath, record);
    fs.renameSync(temporaryPath, path);
    durable.fsyncFile(path);
    durable.fsyncDirectory(dirname(path));
  }

  function heartbeatFilePath(path, owner) {
    return `${path}.heartbeat-${owner.token}`;
  }

  function readHeartbeat(path, owner) {
    const heartbeatPath = heartbeatFilePath(path, owner);
    const stat = regularFile(fs, heartbeatPath, {
      allowMissing: true,
      label: 'Update lock heartbeat',
    });
    if (stat === null) return null;
    try {
      const heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
      if (
        typeof heartbeat !== 'object'
        || heartbeat === null
        || heartbeat.schemaVersion !== UPDATE_LOCK_SCHEMA_VERSION
        || heartbeat.token !== owner.token
        || heartbeat.pid !== owner.pid
        || !Number.isSafeInteger(heartbeat.heartbeatAt)
        || heartbeat.heartbeatAt < owner.startedAt
      ) {
        return null;
      }
      return heartbeat;
    } catch (error) {
      if (isMissing(error)) return null;
      throw updateError(
        `Update lock heartbeat is malformed: ${heartbeatPath}`,
        'ERR_UPDATE_LOCK_INVALID',
        error,
      );
    }
  }

  function writeHeartbeat(path, owner, heartbeatAt) {
    const record = {
      schemaVersion: UPDATE_LOCK_SCHEMA_VERSION,
      token: owner.token,
      pid: owner.pid,
      heartbeatAt,
    };
    writeInPlace(heartbeatFilePath(path, owner), record);
    return record;
  }

  function removeHeartbeat(path, owner) {
    const heartbeatPath = heartbeatFilePath(path, owner);
    if (regularFile(fs, heartbeatPath, {
      allowMissing: true,
      label: 'Update lock heartbeat',
    }) === null) {
      return;
    }
    fs.unlinkSync(heartbeatPath);
    durable.fsyncDirectory(dirname(path));
  }

  function lockHeld(path, owner) {
    const details = owner
      ? ` (PID ${owner.pid}, started ${owner.startedAt})`
      : '';
    return updateError(
      `Global update lock is already held${details}: ${path}`,
      'ERR_UPDATE_LOCKED',
    );
  }

  function lockFenced(path) {
    return updateError(
      `Global update lock owner was fenced or replaced: ${path}`,
      'ERR_UPDATE_FENCED',
    );
  }

  function stale(record, path) {
    const heartbeat = readHeartbeat(path, record);
    const heartbeatAt = heartbeat?.heartbeatAt ?? record.heartbeatAt;
    const age = safeNow(now) - heartbeatAt;
    return age > staleAfterMs || !isPidAlive(record.pid);
  }

  // A reclaim marker never receives heartbeats, so its liveness is judged by
  // the marker owner being alive and the marker being newer than the stale
  // window. A process that dies after writing the marker leaves it orphaned;
  // that orphan must be recoverable rather than an unconditional conflict.
  function reclaimMarkerStale(marker) {
    if (!isPidAlive(marker.pid)) return true;
    return safeNow(now) - marker.heartbeatAt > staleAfterMs;
  }

  function reclaim(path, owner) {
    if (!stale(owner, path)) throw lockHeld(path, owner);

    const claimPath = `${path}.reclaim`;

    // Recover an orphaned reclaim marker whose owner died mid-reclaim. A live
    // reclaimer's marker is preserved so concurrent reclaims stay mutually
    // exclusive (mirrors version-store.mjs claimStaleLock recovery).
    const existingClaim = read(claimPath, { allowMissing: true });
    if (existingClaim !== null) {
      if (!reclaimMarkerStale(existingClaim)) throw lockHeld(path, owner);
      fs.unlinkSync(claimPath);
      durable.fsyncDirectory(dirname(path));
    }

    const claim = {
      schemaVersion: UPDATE_LOCK_SCHEMA_VERSION,
      token: validateLockToken(randomToken(), 'randomToken result'),
      pid,
      startedAt: safeNow(now),
      heartbeatAt: safeNow(now),
    };
    try {
      writeExclusive(claimPath, claim);
    } catch (error) {
      if (isAlreadyExists(error)) throw lockHeld(path, owner);
      throw error;
    }

    try {
      const current = read(path, { allowMissing: true });
      if (
        current === null
        || current.token !== owner.token
        || current.pid !== owner.pid
        || !stale(current, path)
      ) {
        throw lockHeld(path, current ?? owner);
      }

      const stalePath = `${path}.stale-${claim.token}`;
      fs.renameSync(path, stalePath);
      durable.fsyncDirectory(dirname(path));
      fs.rmSync(stalePath, { recursive: false, force: false });
      removeHeartbeat(path, owner);
      durable.fsyncDirectory(dirname(path));
    } finally {
      try {
        const currentClaim = read(claimPath, { allowMissing: true });
        if (
          currentClaim !== null
          && currentClaim.pid === claim.pid
          && currentClaim.token === claim.token
        ) {
          fs.unlinkSync(claimPath);
          durable.fsyncDirectory(dirname(path));
        }
      } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') throw cleanupError;
      }
    }
  }

  function acquire(path) {
    ensureString(path, 'lock path');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = safeNow(now);
      const token = validateLockToken(randomToken(), 'randomToken result');
      const owner = {
        schemaVersion: UPDATE_LOCK_SCHEMA_VERSION,
        token,
        pid,
        startedAt,
        heartbeatAt: startedAt,
      };
      try {
        writeExclusive(path, owner);
        return owner;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }

      const existing = read(path, { allowMissing: true });
      if (existing === null) continue;
      if (!stale(existing, path)) throw lockHeld(path, existing);
      reclaim(path, existing);
    }
    throw lockHeld(path);
  }

  function assertHeld(token, path) {
    ensureString(path, 'lock path');
    const owner = read(path, { allowMissing: true });
    if (
      owner === null
      || !token
      || owner.token !== token.token
      || (token.pid !== undefined && owner.pid !== token.pid)
    ) {
      throw lockFenced(path);
    }
    return owner;
  }

  function heartbeat(token, path) {
    const owner = assertHeld(token, path);
    const heartbeatAt = safeNow(now);
    writeHeartbeat(path, owner, heartbeatAt);
    return { ...owner, heartbeatAt };
  }

  function release(token, path) {
    const owner = assertHeld(token, path);
    // Ownership-preserving release: atomically move the lock aside under a
    // token-scoped name, then re-verify the moved record still identifies us.
    // If a concurrent reclaim replaced the lock in the race window between the
    // ownership check above and this rename, the moved record will not match
    // our token/pid; in that case we must restore it WITHOUT overwriting a lock
    // a third process may have acquired while the path was momentarily free.
    const releasePath = `${path}.release-${owner.token}`;
    try {
      fs.renameSync(path, releasePath);
    } catch (error) {
      if (isMissing(error)) throw lockFenced(path);
      throw error;
    }
    durable.fsyncDirectory(dirname(path));

    let moved;
    try {
      moved = read(releasePath, { allowMissing: true });
    } catch {
      moved = null;
    }
    if (moved === null || moved.token !== owner.token || moved.pid !== owner.pid) {
      // The record we moved aside is not ours — a concurrent reclaim replaced
      // our lock. Restore it only if the path is still free; never clobber an
      // intervening acquisition by a third process.
      restorePreservingIntervening(releasePath, path);
      throw lockFenced(path);
    }

    fs.unlinkSync(releasePath);
    removeHeartbeat(path, owner);
    durable.fsyncDirectory(dirname(path));
  }

  // Move `fromPath` back to `toPath`, but only if `toPath` is still free. Uses a
  // hard link (fails with EEXIST when a third process has acquired the lock in
  // the interim) so a restore can never overwrite an intervening acquisition. On
  // filesystems without hard-link support, falls back to a read-guarded rename.
  // The moved-aside copy is always cleaned up so it is never left as a live lock.
  function restorePreservingIntervening(fromPath, toPath) {
    const discardAside = () => {
      try {
        fs.unlinkSync(fromPath);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      durable.fsyncDirectory(dirname(toPath));
    };

    try {
      fs.linkSync(fromPath, toPath);
    } catch (error) {
      if (isAlreadyExists(error)) {
        // A third process holds `toPath` — preserve it and drop our aside copy.
        discardAside();
        return false;
      }
      if (isMissing(error)) {
        // Nothing to restore (source vanished); leave any intervening lock intact.
        return false;
      }
      if (isLinkUnsupported(error)) {
        // Hard links are unavailable on this filesystem. Restore via an
        // exclusive create (`wx`) so the write lands only while `toPath` remains
        // absent: an intervening acquisition surfaces as EEXIST and is treated
        // as an intervening lock (never overwritten). This closes the
        // read-then-rename TOCTOU window a plain rename fallback would leave.
        let record;
        try {
          record = read(fromPath, { allowMissing: true });
        } catch {
          record = null;
        }
        if (record === null) {
          // Nothing valid to restore; drop the aside copy and leave `toPath`.
          discardAside();
          return false;
        }
        try {
          writeExclusive(toPath, record);
        } catch (writeError) {
          if (isAlreadyExists(writeError)) {
            // A third process acquired `toPath` in the interim — preserve it.
            discardAside();
            return false;
          }
          throw writeError;
        }
        // `toPath` now holds the restored record; remove the aside copy.
        discardAside();
        return true;
      }
      throw error;
    }

    // Link succeeded: `toPath` now references our aside record. Drop the source.
    try {
      fs.unlinkSync(fromPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    durable.fsyncDirectory(dirname(toPath));
    return true;
  }

  function inspect(path) {
    const owner = read(path, { allowMissing: true });
    return owner === null
      ? { held: false, owner: null }
      : { held: true, owner, stale: stale(owner, path) };
  }

  function startHeartbeat(token, path, intervalMs = DEFAULT_HEARTBEAT_MS, options = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new TypeError('heartbeat interval must be a positive safe integer.');
    }
    assertHeld(token, path);
    const {
      onTerminalFailure,
      scheduler,
      maxConsecutiveFailures = DEFAULT_HEARTBEAT_MAX_CONSECUTIVE_FAILURES,
    } = options;
    const canUseWorker = !scheduler && useWorkerHeartbeat && fs === nodeFs && now === Date.now;
    if (canUseWorker) {
      const worker = new Worker(
        new URL('./update-lock-heartbeat.mjs', import.meta.url),
        {
          workerData: {
            path,
            heartbeatPath: heartbeatFilePath(path, token),
            token: token?.token,
            intervalMs,
            maxConsecutiveFailures,
          },
        },
      );
      worker.unref?.();
      worker.on('error', () => {});
      worker.on('message', message => {
        if (message?.type === 'heartbeat-terminated') {
          try {
            onTerminalFailure?.({ reason: message.reason });
          } catch {
            // A failing terminal callback must not crash the worker owner.
          }
        }
      });
      return async () => {
        worker.postMessage('stop');
        await worker.terminate();
      };
    }

    const timers = scheduler ?? { setInterval, clearInterval };
    let consecutiveFailures = 0;
    let stopped = false;
    const timer = timers.setInterval(() => {
      if (stopped) return;
      try {
        heartbeat(token, path);
        consecutiveFailures = 0;
      } catch (error) {
        const outcome = evaluateHeartbeatFailure({
          classification: classifyHeartbeatFailure(error),
          consecutiveFailures,
          maxConsecutiveFailures,
        });
        consecutiveFailures = outcome.consecutiveFailures;
        if (outcome.stop) {
          stopped = true;
          timers.clearInterval(timer);
          try {
            onTerminalFailure?.({ reason: outcome.reason, error });
          } catch {
            // A failing terminal callback must not mask the heartbeat outcome.
          }
        }
      }
    }, intervalMs);
    timer.unref?.();
    return () => {
      stopped = true;
      timers.clearInterval(timer);
    };
  }

  return {
    acquire,
    assertHeld,
    heartbeat,
    release,
    inspect,
    startHeartbeat,
  };
}

function encodeJournalValue(value) {
  if (Buffer.isBuffer(value)) {
    return {
      __myelinJournalType: 'buffer',
      base64: value.toString('base64'),
    };
  }
  if (Array.isArray(value)) return value.map(encodeJournalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, encodeJournalValue(child)]),
    );
  }
  return value;
}

function decodeJournalValue(value) {
  if (Array.isArray(value)) return value.map(decodeJournalValue);
  if (value && typeof value === 'object') {
    if (value.__myelinJournalType === 'buffer' && typeof value.base64 === 'string') {
      return Buffer.from(value.base64, 'base64');
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, decodeJournalValue(child)]),
    );
  }
  return value;
}

function cloneJournalValue(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(cloneJournalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJournalValue(child)]),
    );
  }
  return value;
}

function validatePointerPair(pair, label) {
  if (typeof pair !== 'object' || pair === null || Array.isArray(pair)) {
    throw updateError(`${label} must be an object.`, 'ERR_UPDATE_JOURNAL_INVALID');
  }
  const normalized = {};
  for (const key of ['current', 'previous']) {
    if (!Object.hasOwn(pair, key) || (pair[key] !== null && typeof pair[key] !== 'string')) {
      throw updateError(`${label}.${key} must be a string or null.`, 'ERR_UPDATE_JOURNAL_INVALID');
    }
    normalized[key] = pair[key];
  }
  return normalized;
}

function normalizeConfigSnapshot(config, label = 'config') {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw updateError(`${label} must be an object.`, 'ERR_UPDATE_JOURNAL_INVALID');
  }
  if (typeof config.exists !== 'boolean') {
    throw updateError(`${label}.exists must be a boolean.`, 'ERR_UPDATE_JOURNAL_INVALID');
  }
  if (config.exists && !Buffer.isBuffer(config.bytes)) {
    throw updateError(`${label}.bytes must be a Buffer.`, 'ERR_UPDATE_JOURNAL_INVALID');
  }
  if (config.mode !== null && config.mode !== undefined && !Number.isSafeInteger(config.mode)) {
    throw updateError(`${label}.mode must be a safe integer.`, 'ERR_UPDATE_JOURNAL_INVALID');
  }
  return {
    exists: config.exists,
    bytes: config.exists ? Buffer.from(config.bytes) : null,
    mode: config.mode ?? null,
    metadata: cloneJournalValue(config.metadata ?? {}),
  };
}

function normalizeTransactionState(state, label) {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    throw updateError(`${label} must be an object.`, 'ERR_UPDATE_JOURNAL_INVALID');
  }
  return {
    config: normalizeConfigSnapshot(state.config, `${label}.config`),
    release: validatePointerPair(state.release, `${label}.release`),
    components: Object.fromEntries(
      Object.entries(state.components ?? {}).map(([name, pair]) => [
        name,
        validatePointerPair(pair, `${label}.components.${name}`),
      ]),
    ),
    services: cloneJournalValue(state.services ?? {}),
    supervisors: cloneJournalValue(state.supervisors ?? {}),
  };
}

function validateJournal(journal) {
  if (typeof journal !== 'object' || journal === null || Array.isArray(journal)) {
    throw updateError('Update journal must be an object.', 'ERR_UPDATE_JOURNAL_INVALID');
  }
  if (journal.schemaVersion !== UPDATE_JOURNAL_SCHEMA_VERSION) {
    throw updateError('Update journal schema version is unsupported.', 'ERR_UPDATE_JOURNAL_INVALID');
  }
  if (typeof journal.transactionId !== 'string' || journal.transactionId.length === 0) {
    throw updateError('Update journal transactionId is required.', 'ERR_UPDATE_JOURNAL_INVALID');
  }
  if (!['prepared', 'committed'].includes(journal.phase)) {
    throw updateError('Update journal phase is invalid.', 'ERR_UPDATE_JOURNAL_INVALID');
  }
  if (!['pending', 'complete'].includes(journal.cleanupState)) {
    throw updateError('Update journal cleanup state is invalid.', 'ERR_UPDATE_JOURNAL_INVALID');
  }
  return {
    ...journal,
    snapshot: normalizeTransactionState(journal.snapshot, 'journal.snapshot'),
    desired: normalizeTransactionState(journal.desired, 'journal.desired'),
  };
}

export function createUpdateJournalStore({
  path,
  fs = nodeFs,
  platform = process.platform,
  durability,
} = {}) {
  ensureString(path, 'journal path');
  if (!fs || typeof fs !== 'object') throw new TypeError('fs must be an object.');
  const durable = normalizeDurability(fs, durability, platform);
  const temporaryPath = `${path}.new`;

  function read() {
    const stat = regularFile(fs, path, { allowMissing: true, label: 'Update journal' });
    if (stat === null) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
      return validateJournal(decodeJournalValue(parsed));
    } catch (error) {
      if (error?.code === 'ERR_UPDATE_JOURNAL_INVALID') throw error;
      throw updateError(`Update journal is malformed: ${path}`, 'ERR_UPDATE_JOURNAL_INVALID', error);
    }
  }

  function write(journal) {
    const valid = validateJournal(journal);
    fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    regularFile(fs, temporaryPath, { allowMissing: true, label: 'Update journal temporary' });
    let published = false;
    try {
      if (regularFile(fs, temporaryPath, { allowMissing: true, label: 'Update journal temporary' })) {
        fs.unlinkSync(temporaryPath);
      }
      fs.writeFileSync(temporaryPath, JSON.stringify(encodeJournalValue(valid)), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      durable.fsyncFile(temporaryPath);
      fs.renameSync(temporaryPath, path);
      published = true;
      durable.fsyncFile(path);
      durable.fsyncDirectory(dirname(path));
      return valid;
    } catch (error) {
      error.journalWrite = {
        path,
        temporaryPath,
        phase: valid.phase,
        published,
      };
      throw error;
    }
  }

  function cleanup() {
    if (regularFile(fs, path, { allowMissing: true, label: 'Update journal' }) === null) return false;
    fs.unlinkSync(path);
    durable.fsyncDirectory(dirname(path));
    return true;
  }

  return {
    path,
    read,
    write,
    cleanup,
  };
}

export const createUpdateJournal = createUpdateJournalStore;

export function updatePaths(home = homedir()) {
  const managedRoot = join(home, '.myelin');
  return {
    home,
    managedRoot,
    componentsRoot: join(managedRoot, 'components'),
    releasesRoot: join(managedRoot, 'releases'),
    configPath: join(managedRoot, 'config.yaml'),
    lockPath: join(managedRoot, UPDATE_LOCK_FILENAME),
    journalPath: join(managedRoot, UPDATE_JOURNAL_FILENAME),
  };
}

function selectedComponentEntries(manifest, backend, platform = process.platform) {
  return Object.entries(manifest)
    .filter(([name, component]) => {
      if (backend === 'headroom-lite' && name === 'headroomOriginal') return false;
      if (backend === 'headroom-original' && name === 'headroomLite') return false;
      if (backend !== 'headroom-lite' && backend !== 'headroom-original' && BACKEND_COMPONENT_NAMES.has(name)) return false;
      // Skip platform-restricted components when they don't apply to the current platform
      if (Array.isArray(component?.platforms) && !component.platforms.includes(platform)) return false;
      return true;
    })
    .sort(([left], [right]) => left.localeCompare(right));
}

function installedPair(installed, name) {
  const entry = installed?.components?.[name] ?? installed?.[name] ?? {};
  return {
    current: entry.current ?? null,
    previous: entry.previous ?? null,
  };
}

function installedReleasePair(installed) {
  const release = installed?.release ?? installed?.releases ?? {};
  return {
    current: release.current ?? null,
    previous: release.previous ?? null,
  };
}

function validateChannel(channel) {
  if (!['stable', 'main'].includes(channel)) {
    throw new TypeError('invalid update channel; choose stable or main.');
  }
  return channel;
}

/**
 * Plans only manifest-pinned components. The unselected compression backend is
 * deliberately absent, so a backend selection cannot stage both sidecars.
 */
export function planUpdate({
  channel = 'stable',
  config = {},
  manifest = COMPONENTS,
  installed = {},
  target,
  platform = process.platform,
} = {}) {
  validateChannel(channel);
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new TypeError('manifest must be an object.');
  }
  if (!target || typeof target.version !== 'string' || target.version.length === 0) {
    throw new TypeError('target.version is required.');
  }
  const selected = resolveCompressionConfig(config);
  const releaseBefore = installedReleasePair(installed);
  const components = selectedComponentEntries(manifest, selected.backend, platform).map(([name, component]) => {
    const before = installedPair(installed, name);
    return {
      name,
      component,
      current: component.version,
      previous: before.current,
      snapshot: before,
    };
  });

  return {
    channel,
    target,
    config,
    backend: selected.backend,
    components,
    release: {
      current: target.version,
      previous: releaseBefore.current,
    },
    releaseSnapshot: releaseBefore,
  };
}

function cloneConfigState(config) {
  return {
    exists: config.exists,
    bytes: config.exists ? Buffer.from(config.bytes) : null,
    mode: config.mode,
    metadata: cloneJournalValue(config.metadata ?? {}),
  };
}

export function readRawConfigSnapshot({
  path,
  fs = nodeFs,
  metadataAdapter,
} = {}) {
  ensureString(path, 'config path');
  const stat = regularFile(fs, path, { allowMissing: true, label: 'Configuration' });
  if (stat === null) {
    return {
      exists: false,
      bytes: null,
      mode: null,
      metadata: metadataAdapter?.captureMissing?.(path) ?? {},
    };
  }
  const metadata = metadataAdapter?.capture
    ? metadataAdapter.capture(path, stat)
    : {
        uid: stat.uid,
        gid: stat.gid,
      };
  return {
    exists: true,
    bytes: Buffer.from(fs.readFileSync(path)),
    mode: stat.mode & 0o7777,
    metadata: metadata ?? {},
  };
}

export async function writeRawConfigSnapshot(snapshot, {
  path,
  fs = nodeFs,
  platform = process.platform,
  durability,
  metadataAdapter,
} = {}) {
  ensureString(path, 'config path');
  const state = normalizeConfigSnapshot(snapshot);
  const durable = normalizeDurability(fs, durability, platform);
  if (!state.exists) {
    if (regularFile(fs, path, { allowMissing: true, label: 'Configuration' }) !== null) {
      fs.unlinkSync(path);
      durable.fsyncDirectory(dirname(path));
    }
    return;
  }

  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.new`;
  if (regularFile(fs, temporary, { allowMissing: true, label: 'Configuration temporary' }) !== null) {
    fs.unlinkSync(temporary);
  }
  fs.writeFileSync(temporary, state.bytes, { mode: state.mode ?? 0o600, flag: 'wx' });
  if (state.mode !== null && state.mode !== undefined) fs.chmodSync?.(temporary, state.mode);
  if (metadataAdapter?.restore) await metadataAdapter.restore(temporary, state.metadata);
  durable.fsyncFile(temporary);
  fs.renameSync(temporary, path);
  durable.fsyncFile(path);
  durable.fsyncDirectory(dirname(path));
}

function parseRawConfig(raw, parseConfig) {
  if (!raw?.exists) return {};
  const parsed = parseConfig(raw.bytes.toString('utf8'));
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw updateError('Configuration must contain a mapping.', 'ERR_UPDATE_CONFIG_INVALID');
  }
  return parsed;
}

function prepareDesiredConfig(raw, parsed) {
  const migration = migrateLegacyCompressionConfig(parsed);
  if (!migration.changed) {
    return {
      config: cloneConfigState(raw),
      migration,
      effectiveConfig: migration.config,
    };
  }
  return {
    config: {
      exists: true,
      bytes: Buffer.from(dumpYaml(migration.config, { lineWidth: 120 }), 'utf8'),
      mode: raw.mode ?? 0o600,
      metadata: cloneJournalValue(raw.metadata ?? {}),
    },
    migration,
    effectiveConfig: migration.config,
  };
}

function defaultSleep(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

function probeTcpService(port, timeoutMs = 3_000) {
  return new Promise(resolvePromise => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise({ ok, backend: 'mitmproxy' });
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function maybeInvoke(callback, ...args) {
  if (typeof callback !== 'function') return undefined;
  return callback(...args);
}

/**
 * Resolves whether a staged-apply child recorded in the journal may still be
 * alive. A concrete, confirmed-gone pid is required to clear the fail-closed
 * gate; an injected checker (tests / alternate platforms) takes precedence, and
 * an unknown pid is conservatively treated as still-live so recovery refuses to
 * race a possibly-running child.
 */
async function resolveStagedChildLiveness(marker, deps) {
  if (typeof deps.isStagedChildAlive === 'function') {
    return await deps.isStagedChildAlive(marker);
  }
  const pid = marker?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return true;
  return defaultIsPidAlive(pid);
}

/**
 * Creates the transactional abort controller that lets a terminal heartbeat
 * failure (e.g. lost lock ownership or an exhausted retry budget) cancel the
 * update before any further mutation. The fence throws `ERR_UPDATE_ABORTED`
 * once aborted so pending mutations stop; `beginRecovery()` re-opens the fence
 * for the journaled rollback, which must be allowed to restore the snapshot.
 */
export function createTransactionAbort({ assertHeld } = {}) {
  const controller = new AbortController();
  let reason = null;
  let recovering = false;

  const trigger = nextReason => {
    if (controller.signal.aborted) return;
    reason = nextReason ?? 'transaction ownership lost';
    controller.abort();
  };

  const beginRecovery = () => {
    recovering = true;
  };

  const fence = async candidate => {
    if (controller.signal.aborted && !recovering) {
      throw updateError(
        `Update aborted before mutation: ${reason ?? 'transaction ownership lost'}.`,
        'ERR_UPDATE_ABORTED',
      );
    }
    if (typeof assertHeld === 'function') {
      await assertHeld(candidate);
    }
  };

  return {
    signal: controller.signal,
    get reason() {
      return reason;
    },
    get aborted() {
      return controller.signal.aborted;
    },
    trigger,
    beginRecovery,
    fence,
  };
}

async function fenceBeforeMutation(deps, context) {
  if (!context?.lockToken) return;
  const fence = deps.fence ?? deps.assertFence;
  if (typeof fence !== 'function') {
    throw updateError('A fenced update mutation is missing its fence.', 'ERR_UPDATE_FENCE_MISSING');
  }
  await fence(context.lockToken);
}

async function mutate(deps, context, operation, ...args) {
  await fenceBeforeMutation(deps, context);
  return operation(...args, context);
}

function journalFor(plan, snapshot, desired, transactionId) {
  return {
    schemaVersion: UPDATE_JOURNAL_SCHEMA_VERSION,
    transactionId,
    phase: 'prepared',
    cleanupState: 'pending',
    snapshot: normalizeTransactionState(snapshot, 'snapshot'),
    desired: normalizeTransactionState(desired, 'desired'),
    target: {
      channel: plan.channel,
      version: plan.target?.version ?? plan.release?.current,
    },
  };
}

async function stageSelectedComponents(plan, deps, context) {
  if (typeof deps.stageComponents === 'function') {
    return mutate(deps, context, deps.stageComponents, plan);
  }
  if (typeof deps.stageComponent !== 'function') return [];
  const staged = [];
  for (const component of [...(plan.components ?? [])].sort((left, right) => (
    left.name.localeCompare(right.name)
  ))) {
    if (
      component.alreadyStaged
      || await maybeInvoke(deps.isComponentStaged, component)
    ) {
      continue;
    }
    const isOptional = component.component?.optional === true;
    try {
      staged.push(await mutate(deps, context, deps.stageComponent, component));
    } catch (error) {
      if (isOptional) {
        // Optional component: log the failure but don't abort the update.
        console.warn(`[myelin] Optional component '${component.name}' failed to stage — skipping: ${error.message}`);
      } else {
        throw error;
      }
    }
  }
  return staged;
}

function componentPairsFromPlan(plan, snapshot) {
  return Object.fromEntries(
    (plan.components ?? []).map(component => [
      component.name,
      {
        current: component.current ?? component.component?.version,
        previous: snapshot.components?.[component.name]?.current ?? component.previous ?? null,
      },
    ]),
  );
}

async function desiredStateFor(plan, snapshot, deps) {
  const base = normalizeTransactionState(snapshot, 'snapshot');
  const desired = {
    ...base,
    config: plan.desiredConfig
      ? normalizeConfigSnapshot(plan.desiredConfig, 'desired.config')
      : cloneConfigState(base.config),
    release: {
      current: validatePointerPair(plan.release, 'desired.release').current,
      previous: base.release.current,
    },
    components: {
      ...base.components,
      ...componentPairsFromPlan(plan, base),
    },
  };
  const described = await maybeInvoke(deps.describeDesiredState, {
    plan,
    snapshot: base,
    desired,
  });
  return normalizeTransactionState(described ?? desired, 'desired');
}

async function strictHealthVerification(plan, deps) {
  const required = await maybeInvoke(deps.requiredServices, plan);
  if (!Array.isArray(required) || required.length === 0) {
    // A supported no-service topology (disabled compression + disabled MITM)
    // has nothing to probe. Only fail when a verify boundary was explicitly
    // injected and reports unhealthy; otherwise the update is healthy.
    if (typeof deps.verify !== 'function') return true;
    const result = await maybeInvoke(deps.verify, plan);
    return result === true || result?.ok === true;
  }

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const retryMs = deps.healthRetryMs ?? DEFAULT_HEALTH_RETRY_MS;
  const perServiceDeadlineMs = deps.perServiceHealthDeadlineMs ?? DEFAULT_SERVICE_HEALTH_DEADLINE_MS;
  const totalDeadlineMs = deps.totalHealthDeadlineMs ?? DEFAULT_TOTAL_HEALTH_DEADLINE_MS;
  const startedAt = Number(now());

  for (const service of required) {
    const serviceStartedAt = Number(now());
    let healthy = false;
    while (
      Number(now()) - startedAt < totalDeadlineMs
      && Number(now()) - serviceStartedAt < perServiceDeadlineMs
    ) {
      const result = await deps.verifyService(service, plan);
      const expectedBackend = service.backend ?? plan.backend;
      const matchesBackend = !expectedBackend || result?.backend === expectedBackend;
      if ((result === true || result?.ok === true) && matchesBackend) {
        healthy = true;
        break;
      }

      const totalRemaining = totalDeadlineMs - (Number(now()) - startedAt);
      const serviceRemaining = perServiceDeadlineMs - (Number(now()) - serviceStartedAt);
      const delay = Math.min(retryMs, totalRemaining, serviceRemaining);
      if (delay <= 0) break;
      await sleep(delay);
    }
    if (!healthy) return false;
  }
  return true;
}

/**
 * Restores every rollback domain. A restore error retains the global journal
 * and prevents the caller from declaring the system recovered.
 */
export async function rollbackUpdate(snapshot, deps = {}, context = {}) {
  const state = normalizeTransactionState(snapshot, 'snapshot');
  const failures = [];
  const restore = async (name, callback, value) => {
    if (typeof callback !== 'function') return;
    try {
      await mutate(deps, context, callback, value, state);
    } catch (error) {
      failures.push({ name, error });
    }
  };

  await restore('stop new services and supervisors', deps.stopNewServicesAndWatchdogs);
  await restore('component pointers', deps.restoreComponentPairs, state.components);
  await restore('release pointers', deps.restoreReleasePair, state.release);
  await restore('configuration', deps.restoreConfig, state.config);
  await restore('service definitions', deps.restoreServiceDefinitions, state.services);
  await restore('supervisors', deps.restoreSupervisors, state.supervisors);
  await restore('service status', deps.restoreServiceStatus, state.services);
  await restore('supervisor status', deps.restoreSupervisorStatus, state.supervisors);

  if (failures.length > 0) {
    try {
      await mutate(deps, context, deps.retainJournal ?? (() => {}), {
        phase: 'prepared',
        snapshot: state,
        failures: failures.map(({ name, error }) => ({
          name,
          message: error?.message ?? String(error),
        })),
      });
    } catch (retainError) {
      failures.push({ name: 'retain journal', error: retainError });
    }
    const error = updateError(
      `Rollback recovery failed: ${failures.map(({ name, error: cause }) => (
        `${name}: ${cause?.message ?? cause}`
      )).join('; ')}`,
      'ERR_UPDATE_ROLLBACK_FAILED',
    );
    error.failures = failures;
    throw error;
  }
  return { ok: true, status: 'restored', snapshot: state };
}

/**
 * Recovers the durable update journal before a new activation begins. Prepared
 * transactions roll back; committed transactions are repaired forward.
 */
export async function recoverUpdateJournal(deps = {}, context = {}) {
  const journal = await maybeInvoke(deps.readJournal);
  if (journal === undefined || journal === null) return { ok: true, status: 'no-journal' };
  const valid = validateJournal(journal);

  // A journal left behind by an unquiesced abort records a staged-apply child
  // that may still be alive across process boundaries. Recovery must refuse any
  // rollback mutation until that child is confirmed gone; otherwise restoration
  // would race a process that can still mutate the same state.
  if (valid.phase === 'prepared' && valid.unresolvedChild && valid.unresolvedChild.resolved !== true) {
    const alive = await resolveStagedChildLiveness(valid.unresolvedChild, deps);
    if (alive) {
      const deferred = updateError(
        'Update recovery deferred: the prior staged apply child could not be confirmed terminated.',
        'ERR_UPDATE_RECOVERY_CHILD_ALIVE',
      );
      deferred.unresolvedChild = valid.unresolvedChild;
      try {
        await mutate(deps, context, deps.retainJournal ?? (() => {}), valid, deferred);
      } catch (retainError) {
        deferred.retainJournalError = retainError;
      }
      throw deferred;
    }
    // The child is confirmed terminated. Persist that resolution durably before
    // any rollback mutation so a crash mid-recovery does not force an indefinite
    // re-check of a now-defunct (and potentially reused) pid.
    const resolvedJournal = {
      ...valid,
      unresolvedChild: { ...valid.unresolvedChild, resolved: true, resolvedAt: Date.now() },
    };
    await mutate(deps, context, deps.writeJournal ?? (() => {}), resolvedJournal);
  }

  try {
    if (valid.phase === 'prepared') {
      await rollbackUpdate(valid.snapshot, deps, context);
      await mutate(deps, context, deps.cleanupJournal ?? (() => {}), valid);
      return { ok: true, status: 'recovered-prepared' };
    }

    if (typeof deps.ensureDesiredState === 'function') {
      await mutate(deps, context, deps.ensureDesiredState, valid.desired, valid);
    } else {
      await mutate(deps, context, deps.applyComponentPairs ?? (() => {}), valid.desired.components, valid);
      await mutate(deps, context, deps.writeConfig ?? (() => {}), valid.desired.config, valid);
      await mutate(deps, context, deps.applyReleasePair ?? (() => {}), valid.desired.release, valid);
      await mutate(deps, context, deps.restoreServiceDefinitions ?? (() => {}), valid.desired.services, valid);
      await mutate(deps, context, deps.restoreSupervisors ?? (() => {}), valid.desired.supervisors, valid);
      await mutate(deps, context, deps.restoreServiceStatus ?? (() => {}), valid.desired.services, valid);
      await mutate(deps, context, deps.restoreSupervisorStatus ?? (() => {}), valid.desired.supervisors, valid);
    }
    await mutate(deps, context, deps.cleanupJournal ?? (() => {}), valid);
    return { ok: true, status: 'recovered-committed' };
  } catch (cause) {
    try {
      await mutate(deps, context, deps.retainJournal ?? (() => {}), valid, cause);
    } catch (retainError) {
      cause.retainJournalError = retainError;
    }
    throw updateError(
      `Update journal recovery failed: ${cause?.message ?? cause}`,
      'ERR_UPDATE_RECOVERY_FAILED',
      cause,
    );
  }
}

/**
 * Activates staged state transactionally. Staging is intentionally included so
 * callers that invoke this directly get the same inactive-state failure path.
 */
export async function activateUpdate(plan, deps = {}, context = {}) {
  let stagedComponents;
  try {
    stagedComponents = await stageSelectedComponents(plan, deps, context);
  } catch (error) {
    try {
      await mutate(deps, context, deps.cleanupStaging ?? (() => {}), plan, error);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    return {
      ok: false,
      status: 'staging-failed',
      error,
    };
  }

  let snapshot;
  let journal;
  let committed = false;
  try {
    snapshot = normalizeTransactionState(
      await deps.captureSnapshot(plan),
      'snapshot',
    );
    const desired = await desiredStateFor(plan, snapshot, deps);
    journal = journalFor(plan, snapshot, desired, context.lockToken?.token ?? randomUUID());

    await mutate(deps, context, deps.writeJournal ?? (() => {}), journal);
    await mutate(deps, context, deps.quiesceSupervisors ?? (() => {}), snapshot.supervisors, snapshot);
    await mutate(deps, context, deps.quiesceServices ?? (() => {}), snapshot.services, snapshot);
    await mutate(deps, context, deps.applyComponentPairs ?? (() => {}), desired.components, plan);
    await mutate(deps, context, deps.writeConfig ?? (() => {}), desired.config, plan);
    await mutate(deps, context, deps.applyReleasePair ?? (() => {}), desired.release, plan);
    await mutate(deps, context, deps.installLauncher ?? (() => {}), desired.release, plan);
    // Durably record that a staged-apply child is about to run BEFORE spawning
    // it. If the parent crashes mid-apply, recovery must find this marker and
    // refuse to roll back until the child is confirmed gone; a fresh lock token
    // does not fence an already-spawned child. The pid is unknown until spawn,
    // so it is filled in via onChildSpawn; an unknown pid is treated as alive.
    journal = {
      ...journal,
      unresolvedChild: {
        pid: null,
        reason: 'staged apply in progress',
        recordedAt: Date.now(),
        resolved: false,
      },
    };
    await mutate(deps, context, deps.writeJournal ?? (() => {}), journal);
    await mutate(deps, context, deps.runStagedApply ?? (() => {}), {
      plan,
      stagedRelease: plan.stagedRelease,
      lockToken: context.lockToken,
      config: desired.config,
      snapshot,
      abortSignal: context.abortSignal,
      onChildSpawn: async ({ pid } = {}) => {
        journal = {
          ...journal,
          unresolvedChild: {
            ...journal.unresolvedChild,
            pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null,
            recordedAt: Date.now(),
          },
        };
        await mutate(deps, context, deps.writeJournal ?? (() => {}), journal);
      },
    });
    // The staged apply resolved (child exited cleanly). Mark the child resolved
    // durably so a later recovery does not block indefinitely on a defunct pid.
    journal = {
      ...journal,
      unresolvedChild: {
        ...journal.unresolvedChild,
        resolved: true,
        resolvedAt: Date.now(),
      },
    };
    await mutate(deps, context, deps.writeJournal ?? (() => {}), journal);
    await mutate(deps, context, deps.startServices ?? (() => {}), desired.services, plan);
    await mutate(deps, context, deps.startSupervisors ?? (() => {}), desired.supervisors, plan);
    if (typeof deps.captureDesiredState === 'function') {
      journal = {
        ...journal,
        desired: normalizeTransactionState(
          await deps.captureDesiredState(plan),
          'desired',
        ),
      };
      await mutate(deps, context, deps.writeJournal ?? (() => {}), journal);
    }

    if (!await strictHealthVerification(plan, deps)) {
      throw updateError('Strict backend and service health verification failed.', 'ERR_UPDATE_HEALTH');
    }

    journal = {
      ...journal,
      phase: 'committed',
      committedAt: Date.now(),
    };
    await mutate(deps, context, deps.writeJournal ?? (() => {}), journal);
    committed = true;
    try {
      await mutate(deps, context, deps.cleanupJournal ?? (() => {}), journal);
    } catch (cleanupError) {
      await mutate(deps, context, deps.retainJournal ?? (() => {}), journal, cleanupError);
      return {
        ok: true,
        status: 'committed-cleanup-pending',
        snapshot,
        desired: journal.desired,
        stagedComponents,
        error: cleanupError,
      };
    }
    return {
      ok: true,
      status: 'activated',
      snapshot,
      desired: journal.desired,
      stagedComponents,
    };
  } catch (error) {
    if (!snapshot) throw error;
    if (error?.code === 'ERR_UPDATE_ABORT_UNQUIESCED') {
      // The staged installer could not be confirmed terminated. Restoring the
      // snapshot now would race a child that may still mutate service
      // definitions, so fail closed: persist a durable unresolved-child marker
      // in the journal and do not roll back. A future recovery must confirm the
      // recorded child is gone before it restores anything — a fresh lock token
      // does not fence the already-spawned child.
      if (journal) {
        journal = {
          ...journal,
          unresolvedChild: {
            pid: error?.unquiescedChild?.pid ?? null,
            reason: error?.message ?? 'staged apply did not quiesce after abort',
            recordedAt: Date.now(),
            resolved: false,
          },
        };
        try {
          await maybeInvoke(deps.writeJournal, journal);
        } catch (markerError) {
          error.markerWriteError = markerError;
        }
      }
      try {
        await maybeInvoke(deps.retainJournal, journal, error);
      } catch (retainError) {
        error.retainJournalError = retainError;
      }
      return {
        ok: false,
        status: 'aborted-unquiesced-journal-retained',
        snapshot,
        error,
      };
    }
    // A terminal transaction abort must still allow the journaled rollback to
    // restore the captured snapshot, so re-open the fence for recovery.
    context.abort?.beginRecovery?.();
    if (committed || (
      journal?.phase === 'committed'
      && error?.journalWrite?.published === true
    )) {
      try {
        await mutate(deps, context, deps.retainJournal ?? (() => {}), journal, error);
      } catch (retainError) {
        error.retainJournalError = retainError;
      }
      return {
        ok: true,
        status: 'committed-cleanup-pending',
        snapshot,
        desired: journal.desired,
        stagedComponents,
        error,
      };
    }
    try {
      await rollbackUpdate(snapshot, deps, context);
      try {
        await mutate(deps, context, deps.cleanupJournal ?? (() => {}), journal);
      } catch (cleanupError) {
        await mutate(deps, context, deps.retainJournal ?? (() => {}), journal, cleanupError);
        return {
          ok: false,
          status: 'rolled-back-journal-retained',
          error,
          cleanupError,
        };
      }
      return {
        ok: false,
        status: 'rolled-back',
        error,
      };
    } catch (rollbackError) {
      rollbackError.activationError = error;
      throw rollbackError;
    }
  }
}

function defaultMetadataAdapter(fs = nodeFs) {
  return {
    capture(_path, stat) {
      return {
        uid: stat.uid,
        gid: stat.gid,
      };
    },
    restore(path, metadata) {
      if (
        Number.isSafeInteger(metadata?.uid)
        && Number.isSafeInteger(metadata?.gid)
      ) {
        try {
          fs.chownSync?.(path, metadata.uid, metadata.gid);
        } catch {}
      }
    },
  };
}

async function importStagedManifest(stagedRelease) {
  const directory = stagedRelease?.directory;
  ensureString(directory, 'staged release directory');
  const manifestPath = stagedChild(directory, 'src', 'update', 'component-manifest.mjs');
  const module = await import(`${pathToFileURL(manifestPath).href}?update=${encodeURIComponent(stagedRelease.version ?? '')}`);
  validateComponentManifest(module.COMPONENTS);
  return module.COMPONENTS;
}

function sourceTargetIsValidated(target) {
  if (!target || typeof target !== 'object' || target.sourceValidated !== true) return false;
  if (target.channel === 'stable') {
    return typeof target.tag === 'string'
      && /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(target.tag)
      && typeof target.source?.url === 'string'
      && target.source.url.startsWith('https://');
  }
  if (target.channel === 'main') {
    return typeof target.version === 'string'
      && /^main-[0-9a-f]{40}$/iu.test(target.version)
      && typeof target.source?.commit === 'string'
      && /^[0-9a-f]{40}$/iu.test(target.source.commit);
  }
  return false;
}

function platformServiceSpecs(home, platform) {
  if (platform === 'darwin') {
    const root = join(home, 'Library', 'LaunchAgents');
    return {
      services: [
        { name: 'primary', id: 'com.myelin.compression', path: join(root, 'com.myelin.compression.plist') },
        { name: 'copilot', id: 'com.myelin.copilot-compression', path: join(root, 'com.myelin.copilot-compression.plist') },
        { name: 'mitm', id: 'com.myelin.mitmproxy', path: join(root, 'com.myelin.mitmproxy.plist') },
      ],
      supervisors: [
        {
          name: 'watchdog',
          id: 'com.myelin.watchdog',
          path: join(root, 'com.myelin.watchdog.plist'),
          definitionPaths: [
            join(root, 'com.myelin.watchdog.plist'),
            join(home, '.myelin', 'bin', 'watchdog.sh'),
          ],
        },
      ],
    };
  }
  if (platform === 'linux') {
    const root = join(home, '.config', 'systemd', 'user');
    return {
      services: [
        { name: 'primary', id: 'myelin-compression.service', path: join(root, 'myelin-compression.service') },
        { name: 'copilot', id: 'myelin-copilot-compression.service', path: join(root, 'myelin-copilot-compression.service') },
        { name: 'mitm', id: 'myelin-mitmproxy.service', path: join(root, 'myelin-mitmproxy.service') },
      ],
      supervisors: [],
    };
  }

  const path = win32;
  const stateRoot = path.join(home, '.myelin', 'state');
  const servicesRoot = path.join(home, '.myelin', 'services');
  return {
    services: [
      {
        name: 'primary',
        id: 'MyelinCompression',
        registry: 'MyelinCompression',
        winswId: 'MyelinCompression',
        path: path.join(stateRoot, 'MyelinCompression-launcher.ps1'),
        pidPath: path.join(stateRoot, 'MyelinCompression.pid'),
        winsw: path.join(servicesRoot, 'MyelinCompression', 'MyelinCompression.exe'),
        winswConfig: path.join(servicesRoot, 'MyelinCompression', 'MyelinCompression.xml'),
        definitionPaths: [
          path.join(stateRoot, 'MyelinCompression-launcher.ps1'),
          path.join(servicesRoot, 'MyelinCompression', 'MyelinCompression.xml'),
        ],
      },
      {
        name: 'copilot',
        id: 'MyelinCopilotCompression',
        registry: 'MyelinCopilotCompression',
        winswId: 'MyelinCopilotCompression',
        path: path.join(stateRoot, 'MyelinCopilotCompression-launcher.ps1'),
        pidPath: path.join(stateRoot, 'MyelinCopilotCompression.pid'),
        winsw: path.join(servicesRoot, 'MyelinCopilotCompression', 'MyelinCopilotCompression.exe'),
        winswConfig: path.join(servicesRoot, 'MyelinCopilotCompression', 'MyelinCopilotCompression.xml'),
        definitionPaths: [
          path.join(stateRoot, 'MyelinCopilotCompression-launcher.ps1'),
          path.join(servicesRoot, 'MyelinCopilotCompression', 'MyelinCopilotCompression.xml'),
        ],
      },
      {
        name: 'mitm',
        id: 'MyelinMitmproxy',
        registry: 'MyelinMitmproxy',
        winswId: 'myelin-mitmproxy',
        path: path.join(stateRoot, 'myelin-mitmproxy-launcher.ps1'),
        pidPath: path.join(stateRoot, 'myelin-mitmproxy.pid'),
        winsw: path.join(servicesRoot, 'myelin-mitmproxy', 'myelin-mitmproxy.exe'),
        winswConfig: path.join(servicesRoot, 'myelin-mitmproxy', 'myelin-mitmproxy.xml'),
        definitionPaths: [
          path.join(stateRoot, 'myelin-mitmproxy-launcher.ps1'),
          path.join(servicesRoot, 'myelin-mitmproxy', 'myelin-mitmproxy.xml'),
        ],
      },
    ],
    supervisors: [
      {
        name: 'primaryWatchdog',
        id: 'MyelinCompression',
        taskName: 'Myelin Compression Watchdog',
        path: path.join(servicesRoot, 'MyelinCompression', 'watchdog.ps1'),
      },
      {
        name: 'copilotWatchdog',
        id: 'MyelinCopilotCompression',
        taskName: 'Myelin Copilot Compression Watchdog',
        path: path.join(servicesRoot, 'MyelinCopilotCompression', 'watchdog.ps1'),
      },
    ],
  };
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function commandSucceeded(exec, file, args) {
  try {
    exec(file, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function captureWindowsRegistry(specs, exec) {
  const names = specs.map(({ registry }) => registry).filter(Boolean);
  if (names.length === 0) return {};
  const script = [
    `$names = @(${names.map(psQuote).join(',')})`,
    "$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'",
    'foreach ($name in $names) {',
    '  $value = Get-ItemPropertyValue -Path $key -Name $name -ErrorAction SilentlyContinue',
    '  if ($null -eq $value) { Write-Output "$name=" }',
    '  else { Write-Output "$name=$([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value)))" }',
    '}',
  ].join('\n');
  let output;
  try {
    output = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (cause) {
    throw updateError(
      'Unable to snapshot managed Windows Run-key entries.',
      'ERR_UPDATE_SERVICE_SNAPSHOT',
      cause,
    );
  }
  const values = Object.fromEntries(names.map(name => [name, null]));
  for (const line of String(output ?? '').split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const name = line.slice(0, separator);
    const encoded = line.slice(separator + 1);
    if (!Object.hasOwn(values, name) || encoded === '') continue;
    values[name] = Buffer.from(encoded, 'base64').toString('utf8');
  }
  return values;
}

function restoreWindowsRegistry(values, exec) {
  const encoded = Buffer.from(JSON.stringify(values), 'utf8').toString('base64');
  const script = [
    "$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'",
    `$values = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`,
    '$values.psobject.Properties | ForEach-Object {',
    '  if ($null -eq $_.Value) { Remove-ItemProperty -Path $key -Name $_.Name -ErrorAction SilentlyContinue }',
    '  else { Set-ItemProperty -Path $key -Name $_.Name -Value ([string]$_.Value) }',
    '}',
  ].join('\n');
  exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
  });
}

function captureWindowsTasks(specs, exec) {
  const tasks = {};
  for (const { taskName } of specs) {
    if (!taskName) continue;
    try {
      const script = [
        `$task = Get-ScheduledTask -TaskName ${psQuote(taskName)} -ErrorAction SilentlyContinue`,
        "if ($null -eq $task) { Write-Output '__MYELIN_TASK_ABSENT__'; exit 0 }",
        `Export-ScheduledTask -TaskName ${psQuote(taskName)}`,
      ].join('\n');
      const xml = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      const text = String(xml ?? '');
      tasks[taskName] = text.trim() === '__MYELIN_TASK_ABSENT__'
        ? { exists: false, xml: null }
        : { exists: true, xml: text };
    } catch (cause) {
      throw updateError(
        `Unable to snapshot managed Windows scheduled task: ${taskName}`,
        'ERR_UPDATE_SERVICE_SNAPSHOT',
        cause,
      );
    }
  }
  return tasks;
}

function restoreWindowsTasks(tasks, exec) {
  const encoded = Buffer.from(JSON.stringify(tasks), 'utf8').toString('base64');
  const script = [
    `$tasks = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`,
    '$tasks.psobject.Properties | ForEach-Object {',
    '  if ($_.Value.exists -eq $true) { Register-ScheduledTask -TaskName $_.Name -Xml ([string]$_.Value.xml) -Force | Out-Null }',
    '  else { Unregister-ScheduledTask -TaskName $_.Name -Confirm:$false -ErrorAction SilentlyContinue }',
    '}',
  ].join('\n');
  exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
  });
}

/**
 * Captures only Myelin-owned service definitions and their supervisors. Every
 * command runner is injectable; the orchestrator remains platform-neutral.
 */
export function createPlatformServiceTransactionAdapter({
  home = homedir(),
  platform = process.platform,
  fs = nodeFs,
  metadataAdapter = defaultMetadataAdapter(fs),
  exec = execFileSync,
  uid = process.getuid?.(),
} = {}) {
  const normalizedPlatform = platform === 'windows' ? 'win32' : platform;
  const specs = platformServiceSpecs(home, normalizedPlatform);
  const snapshotFiles = entries => Object.fromEntries(entries.map(entry => [
    entry.name,
    {
      files: Object.fromEntries((entry.definitionPaths ?? [entry.path]).map(path => [
        path,
        readRawConfigSnapshot({
          path,
          fs,
          metadataAdapter,
        }),
      ])),
    },
  ]));
  const restoreFiles = async files => {
    for (const entry of [...specs.services, ...specs.supervisors]) {
      for (const [path, snapshot] of Object.entries(files?.[entry.name]?.files ?? {})) {
        await writeRawConfigSnapshot(snapshot, {
          path,
          fs,
          platform: normalizedPlatform,
          metadataAdapter,
        });
      }
    }
  };
  const isActive = entry => {
    if (normalizedPlatform === 'darwin') {
      return commandSucceeded(exec, 'launchctl', ['print', `gui/${uid}/${entry.id}`]);
    }
    if (normalizedPlatform === 'linux') {
      return commandSucceeded(exec, 'systemctl', ['--user', 'is-active', '--quiet', entry.id]);
    }
    if (entry.taskName) {
      return commandSucceeded(exec, 'powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$task = Get-ScheduledTask -TaskName ${psQuote(entry.taskName)} -ErrorAction SilentlyContinue; if ($null -eq $task -or $task.State -eq 'Disabled') { exit 1 }`,
      ]);
    }
    return commandSucceeded(exec, 'powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        `$service = Get-Service -Name ${psQuote(entry.winswId)} -ErrorAction SilentlyContinue`,
        "if ($null -ne $service -and $service.Status -eq 'Running') { exit 0 }",
        `if (Test-Path -LiteralPath ${psQuote(entry.pidPath)}) {`,
        `  $pidParts = (Get-Content -LiteralPath ${psQuote(entry.pidPath)} -Raw).Trim().Split('|')`,
        '  $servicePid = $pidParts[0]',
        '  $expectedStart = if ($pidParts.Length -gt 1) { $pidParts[1] } else { $null }',
        '  $process = if ($servicePid -match "^\\d+$") { Get-Process -Id ([int]$servicePid) -ErrorAction SilentlyContinue } else { $null }',
        '  if ($null -ne $process -and $null -ne $expectedStart -and [string]$process.StartTime.ToFileTimeUtc() -eq [string]$expectedStart) { exit 0 }',
        '}',
        'exit 1',
      ].join('\n'),
    ]);
  };
  const statuses = entries => Object.fromEntries(entries.map(entry => [entry.name, isActive(entry)]));
  const assertStopped = entry => {
    if (isActive(entry)) {
      throw updateError(
        `Managed service or supervisor did not stop: ${entry.name}`,
        'ERR_UPDATE_SERVICE_QUIESCE',
      );
    }
  };
  const setActive = (entry, active, { forceStart = false } = {}) => {
    if (active && !forceStart && isActive(entry)) return;
    if (normalizedPlatform === 'darwin') {
      if (active) {
        exec('launchctl', ['bootstrap', `gui/${uid}`, entry.path], { stdio: 'ignore' });
      } else {
        commandSucceeded(exec, 'launchctl', ['bootout', `gui/${uid}`, entry.path]);
        assertStopped(entry);
      }
      return;
    }
    if (normalizedPlatform === 'linux') {
      exec('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
      if (active) {
        exec('systemctl', ['--user', 'enable', '--now', entry.id], { stdio: 'ignore' });
      } else {
        commandSucceeded(exec, 'systemctl', ['--user', 'disable', '--now', entry.id]);
        assertStopped(entry);
      }
      return;
    }
    if (entry.taskName) {
      const script = active
        ? `Enable-ScheduledTask -TaskName ${psQuote(entry.taskName)} -ErrorAction Stop | Out-Null`
        : `Disable-ScheduledTask -TaskName ${psQuote(entry.taskName)} -ErrorAction SilentlyContinue | Out-Null`;
      if (active) {
        exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
      } else {
        commandSucceeded(exec, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
        assertStopped(entry);
      }
      return;
    }
    const script = active
      ? [
          `if (Test-Path -LiteralPath ${psQuote(entry.path)}) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${psQuote(entry.path)} }`,
          `elseif (Test-Path -LiteralPath ${psQuote(entry.winsw ?? '')}) { & ${psQuote(entry.winsw ?? '')} start ${psQuote(entry.winswConfig ?? '')} }`,
        ].join('\n')
      : [
          `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name ${psQuote(entry.registry ?? '')} -ErrorAction SilentlyContinue`,
          `if (Test-Path -LiteralPath ${psQuote(entry.pidPath ?? '')}) {`,
          `  $pidParts = (Get-Content -LiteralPath ${psQuote(entry.pidPath ?? '')} -Raw).Trim().Split('|')`,
          '  $servicePid = $pidParts[0]',
          '  $expectedStart = if ($pidParts.Length -gt 1) { $pidParts[1] } else { $null }',
          '  $process = if ($servicePid -match "^\\d+$") { Get-Process -Id ([int]$servicePid) -ErrorAction SilentlyContinue } else { $null }',
          '  if ($null -ne $process -and $null -ne $expectedStart -and [string]$process.StartTime.ToFileTimeUtc() -eq [string]$expectedStart) { Stop-Process -Id ([int]$servicePid) -Force -ErrorAction SilentlyContinue }',
          '}',
          `if (Test-Path -LiteralPath ${psQuote(entry.winsw ?? '')}) { & ${psQuote(entry.winsw ?? '')} stop ${psQuote(entry.winswConfig ?? '')} }`,
        ].join('\n');
    if (active) {
      exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
    } else {
      commandSucceeded(exec, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
      assertStopped(entry);
    }
  };
  const setStates = (entries, state = {}, options) => {
    for (const entry of entries) {
      setActive(entry, state[entry.name] === true, options);
    }
  };
  const capture = entries => ({
    definitions: snapshotFiles(entries),
    status: statuses(entries),
    ...(normalizedPlatform === 'win32'
      ? {
          registry: captureWindowsRegistry(entries, exec),
          tasks: captureWindowsTasks(entries, exec),
        }
      : {}),
  });

  return {
    async captureServices() {
      return capture(specs.services);
    },
    async captureSupervisors() {
      return capture(specs.supervisors);
    },
    async quiesceServices() {
      setStates(specs.services, {});
    },
    async quiesceSupervisors() {
      setStates(specs.supervisors, {});
    },
    async startServices(state) {
      setStates(specs.services, state?.status);
    },
    async startSupervisors(state) {
      setStates(specs.supervisors, state?.status);
    },
    async stopNewServicesAndWatchdogs() {
      setStates(specs.supervisors, {});
      setStates(specs.services, {});
    },
    async restoreServiceDefinitions(state) {
      await restoreFiles(state?.definitions);
      if (normalizedPlatform === 'win32') restoreWindowsRegistry(state?.registry ?? {}, exec);
    },
    async restoreSupervisors(state) {
      await restoreFiles(state?.definitions);
      if (normalizedPlatform === 'win32') {
        restoreWindowsRegistry(state?.registry ?? {}, exec);
        restoreWindowsTasks(state?.tasks ?? {}, exec);
      }
    },
    async restoreServiceStatus(state) {
      setStates(specs.services, state?.status, { forceStart: true });
    },
    async restoreSupervisorStatus(state) {
      setStates(specs.supervisors, state?.status, { forceStart: true });
    },
    async describeDesiredState({ plan, desired }) {
      const compression = resolveCompressionConfig(plan.config);
      return {
        ...desired,
        services: {
          ...desired.services,
          status: {
            ...(desired.services?.status ?? {}),
            primary: compression.backend !== 'disabled',
            copilot: compression.backend !== 'disabled' && compression.copilotProxy.enabled,
            mitm: plan.config.proxy?.mitm?.enabled !== false,
          },
        },
      };
    },
  };
}

/**
 * Reports whether a captured transaction snapshot declares any Myelin-owned
 * service or supervisor definition that exists on disk. A `mcp`/`minimal`
 * install captures no such definition files, so this distinguishes a real
 * no-service topology from a proxy install.
 */
export function snapshotDeclaresManagedServices(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const domainHasFiles = domain => {
    const definitions = domain?.definitions;
    if (!definitions || typeof definitions !== 'object') return false;
    return Object.values(definitions).some(entry =>
      Object.values(entry?.files ?? {}).some(file => file?.exists === true),
    );
  };
  return domainHasFiles(snapshot.services) || domainHasFiles(snapshot.supervisors);
}

/**
 * Derives the install profile the staged apply must preserve. A prior
 * `mcp`/`minimal` install has no compression or MITM services; defaulting to
 * `proxy` from config alone would wrongly recreate them. When a pre-update
 * snapshot is supplied, the topology is reconstructed authoritatively from the
 * captured service definitions so a no-service install is never upgraded into a
 * proxy install. Without a snapshot the config-derived heuristic is retained
 * for backwards compatibility.
 */
export function deriveInstallProfile(config, snapshot) {
  if (snapshot !== undefined && snapshot !== null) {
    return snapshotDeclaresManagedServices(snapshot) ? 'proxy' : 'mcp';
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'proxy';
  const compressionEnabled = resolveCompressionConfig(config).backend !== 'disabled';
  const mitmEnabled = config.proxy?.mitm?.enabled !== false;
  return compressionEnabled || mitmEnabled ? 'proxy' : 'mcp';
}

/**
 * Builds the staged-apply argv. The transactional apply must only touch the
 * journaled runtime/config/service domains, so it always carries
 * `--update-apply` and the preserved `--profile`.
 */
export function buildStagedApplyArgs({ installer, token, directory, configPath, profile }) {
  return [
    installer,
    '--yes',
    '--update-apply',
    '--update-token',
    token,
    '--staged-release',
    directory,
    '--config',
    configPath,
    '--profile',
    profile,
  ];
}

/**
 * Waits for a staged-apply child to terminate after an abort, escalating from a
 * cooperative `SIGTERM` to a forceful `SIGKILL` within bounded grace windows.
 * Resolves `true` once the child's exit is observed and `false` if quiescence
 * cannot be confirmed, so the caller can fail closed instead of racing rollback
 * against a child that may still mutate service definitions.
 */
function waitForStagedChildQuiescence(child, {
  scheduler = { setTimeout, clearTimeout },
  termGraceMs = STAGED_ABORT_TERM_GRACE_MS,
  killGraceMs = STAGED_ABORT_KILL_GRACE_MS,
} = {}) {
  return new Promise(resolve => {
    if (child.exitCode !== null && child.exitCode !== undefined) {
      resolve(true);
      return;
    }
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      child.removeListener?.('exit', onExit);
      resolve(value);
    };
    function onExit() {
      finish(true);
    }
    child.once('exit', onExit);

    try {
      child.kill?.('SIGTERM');
    } catch {
      // A child that cannot be signalled is treated as unquiesced below.
    }
    const termTimer = scheduler.setTimeout(() => {
      if (done) return;
      try {
        child.kill?.('SIGKILL');
      } catch {
        // Ignore; the kill grace window still governs the outcome.
      }
      const killTimer = scheduler.setTimeout(() => finish(false), killGraceMs);
      killTimer?.unref?.();
    }, termGraceMs);
    termTimer?.unref?.();
  });
}

async function defaultRunStagedApply({
  stagedRelease,
  lockToken,
  configPath,
  config,
  snapshot,
  abortSignal,
  onChildSpawn,
  spawnImpl = spawn,
  scheduler,
  termGraceMs,
  killGraceMs,
}) {
  const directory = stagedRelease?.directory;
  ensureString(directory, 'staged release directory');
  const installer = stagedChild(directory, 'src', 'install.mjs');
  const token = lockToken?.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw updateError('Staged apply requires an update lock token.', 'ERR_UPDATE_FENCED');
  }
  if (abortSignal?.aborted) {
    throw updateError(
      'Staged apply aborted before launch by a terminal transaction failure.',
      'ERR_UPDATE_ABORTED',
    );
  }
  const profile = deriveInstallProfile(config, snapshot);
  const args = buildStagedApplyArgs({ installer, token, directory, configPath, profile });
  await new Promise((resolvePromise, reject) => {
    const child = spawnImpl(process.execPath, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        MYELIN_UPDATE_TRANSACTION_TOKEN: token,
        MYELIN_UPDATE_STAGED_RELEASE: directory,
        MYELIN_UPDATE_CONFIG_PATH: configPath,
        MYELIN_UPDATE_PROFILE: profile,
      },
    });
    let settled = false;
    let aborting = false;
    const detach = () => {
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
    };
    const settle = action => {
      if (settled) return;
      settled = true;
      detach();
      action();
    };

    // Shared by any failure path that must not let the child outlive the
    // settlement: confirms quiescence (SIGTERM->SIGKILL) before rejecting, so
    // the caller never restores a rollback snapshot while this child might
    // still be rewriting the same files. `onQuiesced`/`onUnquiesced` build the
    // rejection error for their respective outcome.
    async function quiesceThenSettle(onQuiesced, onUnquiesced) {
      if (settled || aborting) return;
      // Own the settlement so the child's own exit/error handlers stand down
      // while we confirm quiescence.
      aborting = true;
      const quiesced = await waitForStagedChildQuiescence(child, {
        scheduler,
        termGraceMs,
        killGraceMs,
      });
      settle(() => {
        if (quiesced) {
          reject(onQuiesced());
        } else {
          const unquiesced = onUnquiesced();
          // Carry the child pid so the caller can persist a durable liveness
          // marker; a later recovery must confirm this process is gone before it
          // dares restore the snapshot.
          unquiesced.unquiescedChild = { pid: child?.pid ?? null };
          reject(unquiesced);
        }
      });
    }

    async function onAbort() {
      await quiesceThenSettle(
        () => updateError(
          'Staged apply aborted by a terminal transaction failure.',
          'ERR_UPDATE_ABORTED',
        ),
        () => updateError(
          'Staged apply could not be confirmed terminated after abort; failing closed to avoid racing rollback.',
          'ERR_UPDATE_ABORT_UNQUIESCED',
        ),
      );
    }

    child.once('error', error => {
      if (aborting) return;
      settle(() => reject(error));
    });
    child.once('exit', (code, signal) => {
      if (aborting) return;
      settle(() => {
        if (code === 0) {
          resolvePromise();
          return;
        }
        reject(updateError(
          `Staged apply exited with ${signal ? `signal ${signal}` : `code ${code}`}.`,
          'ERR_UPDATE_STAGED_APPLY',
        ));
      });
    });
    if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });
    // Handlers are wired synchronously above so no exit/error event is lost.
    // Now report the spawned child's identity so the caller can durably record
    // it for crash recovery; a failure to persist that marker fails closed.
    if (typeof onChildSpawn === 'function') {
      Promise.resolve()
        .then(() => onChildSpawn({ pid: child?.pid ?? null }))
        .catch(async journalWriteError => {
          // The durable liveness marker failed to persist while the child is
          // still alive. Rejecting immediately here would let the caller's
          // generic-error rollback path restore snapshot files while this
          // child is still rewriting them -- the exact clobber class this
          // journal exists to prevent. Quiesce (or fence) the child first, as
          // an abort would, before letting any rollback proceed.
          await quiesceThenSettle(
            () => journalWriteError,
            () => updateError(
              'Staged apply child could not be confirmed terminated after a post-spawn '
                + 'journal-write failure; failing closed to avoid racing rollback.',
              'ERR_UPDATE_ABORT_UNQUIESCED',
            ),
          );
        });
    }
  });
}

/**
 * Resolves the platform used for on-disk update storage (components, releases,
 * lock, journal, config snapshots). On WSL, detectOS() reports 'windows' so
 * that service management bridges to the Windows host, but the filesystem is
 * POSIX (ext4). Storage therefore must use POSIX path semantics while service
 * management keeps the Windows platform.
 */
export function resolveStoragePlatform(platform, { wsl = false } = {}) {
  return wsl ? 'linux' : platform;
}

function defaultDependencies({
  home = homedir(),
  platform = detectOS(),
  storagePlatform = resolveStoragePlatform(platform, { wsl: detectOS(true).wsl }),
  fs = nodeFs,
  metadataAdapter = defaultMetadataAdapter(fs),
  serviceAdapter = createPlatformServiceTransactionAdapter({
    home,
    platform,
    fs,
    metadataAdapter,
  }),
  lock = createUpdateLock({ fs, platform: storagePlatform }),
  journal,
  configPath,
  stagedApplySpawn = spawn,
  stagedAbortScheduler,
  stagedAbortTermGraceMs,
  stagedAbortKillGraceMs,
  ...overrides
} = {}) {
  const paths = updatePaths(home);
  const effectiveConfigPath = configPath ?? paths.configPath;
  const journalStore = journal ?? createUpdateJournalStore({
    path: paths.journalPath,
    fs,
    platform: storagePlatform,
  });

  const captureSnapshot = async plan => ({
    config: readRawConfigSnapshot({
      path: effectiveConfigPath,
      fs,
      metadataAdapter,
    }),
    release: readReleasePointers({
      releasesRoot: paths.releasesRoot,
      platform: storagePlatform,
      fs,
    }),
    components: Object.fromEntries((plan.components ?? []).map(({ name }) => [
      name,
      readPointersReadOnly(paths.componentsRoot, name, { platform: storagePlatform, fs }),
    ])),
    services: await serviceAdapter.captureServices({ plan }),
    supervisors: await serviceAdapter.captureSupervisors({ plan }),
  });
  const captureDesiredState = async plan => ({
    config: readRawConfigSnapshot({
      path: effectiveConfigPath,
      fs,
      metadataAdapter,
    }),
    release: readReleasePointers({
      releasesRoot: paths.releasesRoot,
      platform: storagePlatform,
      fs,
    }),
    components: Object.fromEntries((plan.components ?? []).map(({ name }) => [
      name,
      readPointersReadOnly(paths.componentsRoot, name, { platform: storagePlatform, fs }),
    ])),
    services: await serviceAdapter.captureServices({ plan }),
    supervisors: await serviceAdapter.captureSupervisors({ plan }),
  });

  const defaultApplyComponentPairs = async (pairs, _plan, context) => {
    for (const name of Object.keys(pairs).sort()) {
      await fenceBeforeMutation(deps, context);
      const pair = pairs[name];
      restoreComponent({
        root: paths.componentsRoot,
        name,
        pointers: pair,
        platform: storagePlatform,
        fs,
      });
    }
  };

  const defaultRestoreComponentPairs = async (pairs, _state, context) => (
    defaultApplyComponentPairs(pairs, undefined, context)
  );
  const defaultApplyReleasePair = async pair => {
    await restoreRelease({
      releasesRoot: paths.releasesRoot,
      pointers: pair,
      platform: storagePlatform,
      fs,
    });
    // Keep current.json in sync with the current symlink so `myelin verify`
    // stays green after every orchestrated update.
    if (pair.current !== null && pair.current !== undefined) {
      writeCurrentRelease({ home, rootDir, releaseId: pair.current });
    }
  };

  const deps = {
    paths,
    lock,
    readRawConfig: async () => readRawConfigSnapshot({
      path: effectiveConfigPath,
      fs,
      metadataAdapter,
    }),
    parseRawConfig: source => loadYaml(source),
    resolveTarget: options => resolveReleaseTarget(options),
    stageRelease: target => stageRelease({
      target,
      releasesRoot: paths.releasesRoot,
      platform: storagePlatform,
      fs,
    }),
    readStagedManifest: importStagedManifest,
    detectInstalled: async manifest => ({
      release: readReleasePointers({
        releasesRoot: paths.releasesRoot,
        platform: storagePlatform,
        fs,
      }),
      components: Object.fromEntries(Object.entries(manifest).map(([name, component]) => [
        name,
        {
          ...detectManagedComponent({
            name,
            component,
            root: paths.componentsRoot,
            platform: storagePlatform,
          }),
          ...readPointersReadOnly(paths.componentsRoot, name, { platform: storagePlatform, fs }),
        },
      ])),
    }),
    detectInstalledReadOnly: async manifest => ({
      release: readReleasePointers({
        releasesRoot: paths.releasesRoot,
        platform: storagePlatform,
        fs,
      }),
      components: Object.fromEntries(Object.entries(manifest).map(([name, component]) => [
        name,
        {
          ...detectManagedComponent({
            name,
            component,
            root: paths.componentsRoot,
            platform: storagePlatform,
          }),
          ...readPointersReadOnly(paths.componentsRoot, name, { platform: storagePlatform, fs }),
        },
      ])),
    }),
    inspectLock: async () => lock.inspect(paths.lockPath),
    readJournal: async () => journalStore.read(),
    writeJournal: async value => journalStore.write(value),
    cleanupJournal: async () => journalStore.cleanup(),
    retainJournal: async () => {},
    stageComponent: async component => stageComponent({
      name: component.name,
      component: component.component,
      root: paths.componentsRoot,
      platform: storagePlatform,
      fs,
    }),
    isComponentStaged: async component => {
      const destination = componentVersionDir(
        paths.componentsRoot,
        component.name,
        component.component.version,
      );
      return isStageComplete(destination, { fs, platform: storagePlatform });
    },
    captureSnapshot,
    captureDesiredState,
    describeDesiredState: serviceAdapter.describeDesiredState,
    quiesceServices: serviceAdapter.quiesceServices,
    quiesceSupervisors: serviceAdapter.quiesceSupervisors,
    applyComponentPairs: defaultApplyComponentPairs,
    writeConfig: config => writeRawConfigSnapshot(config, {
      path: effectiveConfigPath,
      fs,
      platform: storagePlatform,
      metadataAdapter,
    }),
    applyReleasePair: defaultApplyReleasePair,
    installLauncher: async () => installStableLauncher({
      home,
      platform,
      fs,
    }),
    runStagedApply: async ({ plan, stagedRelease, lockToken, snapshot, abortSignal, onChildSpawn }) => defaultRunStagedApply({
      stagedRelease,
      lockToken,
      configPath: effectiveConfigPath,
      config: plan?.config,
      snapshot,
      abortSignal,
      onChildSpawn,
      spawnImpl: stagedApplySpawn,
      scheduler: stagedAbortScheduler,
      termGraceMs: stagedAbortTermGraceMs,
      killGraceMs: stagedAbortKillGraceMs,
    }),
    startServices: serviceAdapter.startServices,
    startSupervisors: serviceAdapter.startSupervisors,
    stopNewServicesAndWatchdogs: serviceAdapter.stopNewServicesAndWatchdogs,
    restoreComponentPairs: defaultRestoreComponentPairs,
    restoreReleasePair: defaultApplyReleasePair,
    restoreConfig: config => writeRawConfigSnapshot(config, {
      path: effectiveConfigPath,
      fs,
      platform: storagePlatform,
      metadataAdapter,
    }),
    restoreServiceDefinitions: serviceAdapter.restoreServiceDefinitions,
    restoreSupervisors: serviceAdapter.restoreSupervisors,
    restoreServiceStatus: serviceAdapter.restoreServiceStatus,
    restoreSupervisorStatus: serviceAdapter.restoreSupervisorStatus,
    requiredServices: plan => [
      ...Object.values(buildCompressionRuntimes(plan.config))
        .filter(runtime => runtime.enabled)
        .map(runtime => ({
          name: runtime.purpose,
          backend: runtime.backend,
          runtime,
        })),
      ...(plan.config.proxy?.mitm?.enabled !== false
        ? [{
            name: 'mitm',
            backend: 'mitmproxy',
            kind: 'tcp',
            port: plan.config.proxy?.mitm?.port ?? 8888,
          }]
        : []),
    ],
    verifyService: service => service.kind === 'tcp'
      ? probeTcpService(service.port)
      : probeCompressionHealth(service.runtime),
    isStagedChildAlive: async marker => {
      const pid = marker?.pid;
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return true;
      return defaultIsPidAlive(pid);
    },
    ...overrides,
  };
  if (
    Object.hasOwn(overrides, 'detectInstalled')
    && !Object.hasOwn(overrides, 'detectInstalledReadOnly')
  ) {
    deps.detectInstalledReadOnly = overrides.detectInstalled;
  }
  if (
    Object.hasOwn(overrides, 'verify')
    && !Object.hasOwn(overrides, 'requiredServices')
  ) {
    deps.requiredServices = () => [];
  }
  return deps;
}

/**
 * Creates the production dependency set. Callers may inject a platform
 * `serviceAdapter`; checks remain fully read-only regardless of adapter use.
 */
export function createUpdateDependencies(options = {}) {
  return defaultDependencies(options);
}

async function checkUpdate(options, deps) {
  const raw = await deps.readRawConfig();
  const parsed = parseRawConfig(raw, deps.parseRawConfig ?? loadYaml);
  const prepared = prepareDesiredConfig(raw, parsed);
  const target = await deps.resolveTarget({
    channel: options.channel,
    repository: options.repository,
  });
  const manifest = options.manifest ?? deps.manifest ?? COMPONENTS;
  const installed = await (deps.detectInstalledReadOnly ?? deps.detectInstalled)(manifest);
  const plan = planUpdate({
    channel: options.channel,
    config: prepared.effectiveConfig,
    manifest,
    installed,
    target,
  });
  const report = {
    ok: true,
    status: 'checked',
    plan,
    config: {
      exists: raw.exists,
      migrationRequired: prepared.migration.changed,
      warnings: prepared.migration.warnings,
      backend: plan.backend,
    },
    lock: await maybeInvoke(deps.inspectLock),
    journal: await maybeInvoke(deps.readJournal),
  };
  await maybeInvoke(deps.report, report);
  return report;
}

/**
 * Runs an update or a read-only check. Checks never acquire a lock, stage
 * releases, write migration output, or invoke service/process boundaries.
 */
export async function runUpdate(options = {}, injectedDeps = {}) {
  const channel = options.channel ?? 'stable';
  validateChannel(channel);
  const deps = defaultDependencies(injectedDeps);
  if (options.check === true) {
    return checkUpdate({ ...options, channel }, deps);
  }

  const lockPath = deps.paths?.lockPath ?? updatePaths(injectedDeps.home).lockPath;
  let token;
  let stopHeartbeat;
  let result;
  let releaseError;
  try {
    token = await deps.lock.acquire(lockPath);
    const abort = createTransactionAbort({
      assertHeld: candidate => deps.lock.assertHeld(candidate, lockPath),
    });
    stopHeartbeat = deps.lock.startHeartbeat?.(token, lockPath, undefined, {
      onTerminalFailure: ({ reason }) => abort.trigger(reason),
    });
    const context = { lockToken: token, abort, abortSignal: abort.signal };
    deps.fence ??= abort.fence;

    await recoverUpdateJournal(deps, context);
    const raw = await deps.readRawConfig();
    const parsed = parseRawConfig(raw, deps.parseRawConfig ?? loadYaml);
    const prepared = prepareDesiredConfig(raw, parsed);
    const target = await deps.resolveTarget({
      channel,
      repository: options.repository,
    });
    if (!sourceTargetIsValidated(target)) {
      throw updateError(
        'Update source must be an official stable release/tag or an exact main SHA.',
        'ERR_UPDATE_TARGET_UNVALIDATED',
      );
    }
    const stagedRelease = await mutate(deps, context, deps.stageRelease, target);
    const manifest = await deps.readStagedManifest(stagedRelease);
    validateComponentManifest(manifest);
    const installed = await deps.detectInstalled(manifest);
    const plan = planUpdate({
      channel,
      config: prepared.effectiveConfig,
      manifest,
      installed,
      target,
    });
    plan.stagedRelease = stagedRelease;
    plan.desiredConfig = prepared.config;

    const activation = await activateUpdate(plan, deps, context);
    result = {
      ...activation,
      plan,
      migration: prepared.migration,
    };
  } catch (error) {
    result = {
      ok: false,
      status: 'failed',
      error,
    };
  } finally {
    try {
      await stopHeartbeat?.();
      if (token) deps.lock.release(token, lockPath);
    } catch (error) {
      releaseError = error;
    }
  }
  if (releaseError) {
    return {
      ok: false,
      status: 'failed',
      error: updateError(
        `Update lock release failed: ${releaseError.message ?? releaseError}`,
        'ERR_UPDATE_LOCK_RELEASE',
        releaseError,
      ),
      result,
    };
  }
  return result;
}
