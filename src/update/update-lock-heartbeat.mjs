import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import {
  DEFAULT_HEARTBEAT_MAX_CONSECUTIVE_FAILURES,
  evaluateHeartbeatFailure,
} from './heartbeat-failure-budget.mjs';

const {
  path,
  heartbeatPath,
  token,
  intervalMs,
  maxConsecutiveFailures = DEFAULT_HEARTBEAT_MAX_CONSECUTIVE_FAILURES,
} = workerData;

let consecutiveFailures = 0;
let terminated = false;

function shutdown() {
  if (terminated) return;
  terminated = true;
  clearInterval(timer);
  parentPort?.close();
}

// Terminal: ownership is verifiably lost (file gone/replaced/token mismatch) or
// transient I/O exhausted its retry budget. Notify the parent before closing.
function terminate(reason) {
  if (terminated) return;
  parentPort?.postMessage({ type: 'heartbeat-terminated', reason });
  shutdown();
}

// A transient I/O error: ownership is still intact, the write simply failed.
// Retry until the consecutive-failure budget is exhausted.
function recordTransientFailure() {
  const outcome = evaluateHeartbeatFailure({
    classification: 'transient',
    consecutiveFailures,
    maxConsecutiveFailures,
  });
  consecutiveFailures = outcome.consecutiveFailures;
  if (outcome.stop) terminate(outcome.reason);
}

function writeHeartbeatRecord(owner) {
  const heartbeatRecord = {
    schemaVersion: owner.schemaVersion,
    token: owner.token,
    pid: owner.pid,
    heartbeatAt: Date.now(),
  };
  const temporary = `${heartbeatPath}.new`;
  try {
    const temporaryStat = lstatSync(temporary);
    if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink()) {
      // A tampered temporary path is an ownership/safety violation, not I/O.
      return terminate('ownership-lost');
    }
    unlinkSync(temporary);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  mkdirSync(dirname(heartbeatPath), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, JSON.stringify(heartbeatRecord), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  const descriptor = openSync(temporary, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, heartbeatPath);
  const publishedDescriptor = openSync(heartbeatPath, 'r');
  try {
    fsyncSync(publishedDescriptor);
  } finally {
    closeSync(publishedDescriptor);
  }
  try {
    const directoryDescriptor = openSync(dirname(path), 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (
      process.platform !== 'win32'
      || !['EACCES', 'EISDIR', 'EPERM'].includes(error?.code)
    ) {
      throw error;
    }
  }
}

function heartbeat() {
  if (terminated) return;

  // Verify ownership first. A missing/replaced lock or token mismatch is a
  // terminal loss of the fence and must stop immediately.
  let owner;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return terminate('ownership-lost');
    owner = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return terminate('ownership-lost');
    // Transient failure reading the lock: ownership may still be intact.
    return recordTransientFailure();
  }
  if (owner?.token !== token) return terminate('ownership-lost');

  // Ownership confirmed: any failure writing the heartbeat is transient I/O.
  try {
    writeHeartbeatRecord(owner);
    consecutiveFailures = 0;
  } catch {
    if (!terminated) recordTransientFailure();
  }
}

const timer = setInterval(heartbeat, intervalMs);
timer.unref?.();
parentPort?.on('message', message => {
  if (message === 'stop') shutdown();
});
