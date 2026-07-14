// Shared decision logic for update-lock heartbeats.
//
// A heartbeat must distinguish two very different failure modes:
//   * Verified ownership loss (the lock file vanished, was replaced, or the
//     stored token no longer matches). This is terminal — the caller no longer
//     owns the fence and must stop immediately.
//   * Transient I/O (EIO, ENOSPC, EBUSY, a failed fsync, etc.). Ownership is
//     still intact; the write simply failed. The heartbeat must retry rather
//     than surrender the lock on the first hiccup.
//
// Both the in-process interval loop (createUpdateLock.startHeartbeat) and the
// worker-thread heartbeat (update-lock-heartbeat.mjs) share this logic so the
// two code paths cannot drift apart.

export const DEFAULT_HEARTBEAT_MAX_CONSECUTIVE_FAILURES = 3;

export function classifyHeartbeatFailure(error) {
  return error?.code === 'ERR_UPDATE_FENCED' ? 'ownership-lost' : 'transient';
}

export function evaluateHeartbeatFailure({
  classification,
  consecutiveFailures = 0,
  maxConsecutiveFailures = DEFAULT_HEARTBEAT_MAX_CONSECUTIVE_FAILURES,
} = {}) {
  if (classification === 'ownership-lost') {
    return { consecutiveFailures, stop: true, reason: 'ownership-lost' };
  }
  const budget = Number.isSafeInteger(maxConsecutiveFailures) && maxConsecutiveFailures > 0
    ? maxConsecutiveFailures
    : DEFAULT_HEARTBEAT_MAX_CONSECUTIVE_FAILURES;
  const next = consecutiveFailures + 1;
  if (next >= budget) {
    return { consecutiveFailures: next, stop: true, reason: 'transient-exhausted' };
  }
  return { consecutiveFailures: next, stop: false, reason: 'transient' };
}
