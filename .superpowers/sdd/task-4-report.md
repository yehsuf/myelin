# Task 4 report — Restart and watchdog resolved descriptors safely

## RED

- Added descriptor-plan restart tests before implementation. `node --test test/restart.test.mjs` failed because `runRestart()` used the legacy engine stop/restart paths rather than descriptor adapters.
- Added generic descriptor install/health checks before implementation. The focused test failed at the legacy stop hook.
- Added Windows descriptor watchdog and owned WinSW removal tests before implementation. The focused test failed because watchdog and WinSW identities were role constants rather than descriptor IDs.
- Added legacy-descriptor migration cleanup coverage before implementation. The focused test failed because only the current descriptor registration was removed.

## GREEN

- `node --test test/restart.test.mjs` — 35 passing.
- `node --test test/service.test.mjs` — 118 passing.
- `npm test` — passed (exit code 0).

## Files changed

- `src/cli/restart.mjs`
  - Builds and restarts the selected descriptor plan, pre-removes only owned registrations, waits on each descriptor health URL, then refreshes MITM and watchdogs.
  - Removes the same-engine Copilot descriptor when disabled; Lite failures never select a Python fallback.
- `src/service/windows.mjs`
  - Derives descriptor registry, WinSW, launcher, PID, and watchdog identities from `instance.id`.
  - Uses launcher, PID, executable, listener-port, and role state checks before registry process termination.
  - Removes owned legacy registrations/watchdogs during descriptor migration.
- `test/restart.test.mjs`
  - Covers descriptor ordering, health waits, Lite failure isolation, disabled Copilot cleanup, watchdog identity, ownership, and legacy migration.
- `test/service.test.mjs`
  - Updates generic Windows descriptor expectations for descriptor-derived identities while retaining legacy-wrapper compatibility coverage.

## Self-review

- Verified every removal uses the generic role-removal path and Windows process termination requires all ownership proofs.
- Confirmed disabled Copilot is absent from selected descriptors and explicitly removed, including its watchdog.
- Confirmed no unrelated controller-owned `.gitignore`, `AGENTS.md`, docs, or existing SDD files were changed or staged.

## Concerns

- Windows behavior is validated with generated-script and dependency-injected tests; no live Windows service was modified or exercised.

---

## Critical cleanup follow-up

### RED

- Added a `runRestart()` regression that routes obsolete and disabled role descriptors through the real Windows `removeEngineInstance()` WinSW ownership gate. `node --test test/restart.test.mjs` failed: expected removals were empty because cleanup descriptors omitted `port`.
- Added stale-invalid inactive port coverage. The focused test failed because cleanup descriptor construction threw before restarting the active engine.

### GREEN

- Cleanup descriptors now carry a normalized configured port and matching health URL: engine primary ports resolve from their engine configuration; Copilot resolves from `proxy.copilot_headroom.port` with default `8788`.
- Invalid inactive cleanup ports are warned and skipped rather than preventing an active-engine restart; no portless descriptor reaches Windows ownership cleanup.
- `node --test test/restart.test.mjs` — 38 passing.
- `node --test test/service.test.mjs` — 118 passing.

### Files changed

- `src/cli/restart.mjs`
- `test/restart.test.mjs`

### Self-review

- Confirmed WinSW removal still requires ID, state directory, executable, and exact port identity.
- Three independent code reviews found no remaining significant issues.

### Concerns

- Live Windows services were not exercised.
