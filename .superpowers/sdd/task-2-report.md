# Task 2 Report

- Status: complete
- Branch: `feat/unified-observability`

## Files
- `src/config/engine-runtime.mjs`
- `src/cli/restart.mjs`
- `src/cli/stats.mjs`
- `src/cli/verify.mjs`
- `src/install.mjs`
- `src/service/windows.mjs`
- `test/engine-runtime.test.mjs`
- `test/restart.test.mjs`
- `test/stats.test.mjs`
- `test/verify.test.mjs`

## Tests / Results
1. `node --test test/engine-runtime.test.mjs test/restart.test.mjs test/verify.test.mjs test/stats.test.mjs`
   - Red step before implementation: failed with missing `engine-runtime.mjs` plus missing `buildVerifyResults` / `buildStatsSections` exports and restart assertions showing the old engine-selection behavior.
   - Green step after implementation: `11` tests, `11` passed, `0` failed
2. `node --test test/config.test.mjs test/engine-runtime.test.mjs test/restart.test.mjs test/verify.test.mjs test/stats.test.mjs test/service.test.mjs`
   - `136` tests, `136` passed, `0` failed
3. `npm test`
   - `438` tests, `438` passed, `0` failed

## Concerns
- `src/cli/diagnose.mjs` still assumes Python headroom; this task stayed within the briefed installer/restart/verify/stats surface.

## Review Fix
- Restored symmetric managed-headroom recovery so installer/restart re-register durable launchd/systemd/Windows services when `proxy.engine` returns from `headroom_lite` to Python headroom, even if a transient process is already healthy.
- Tightened Windows obsolete-headroom cleanup to stop only Myelin-owned headroom processes via managed launcher/PID or exact legacy Run-key executable matching, preserving Copilot-Headroom behavior.
- Added lifecycle/restart/Windows ownership regressions covering missing-registration recovery, legacy Run-key migration, WSL Windows-home resolution, and loopback proxy filtering.

## Engine Transition Fix
- `myelin restart` now rebuilds the mitmproxy service definition from config before restarting it, so `MYELIN_HEADROOM_PORT` always follows the selected engine on macOS, Linux, and Windows while keeping Copilot-Headroom egress routing intact.
- Headroom Lite now uses a managed launcher + PID file and refuses to kill an unrelated port owner; restart/obsolete cleanup only stop a Myelin-owned Lite process and surface unmanaged conflicts instead.
- Added focused restart tests for Lite ownership conflicts and for mitm service regeneration across all three operating systems.

## Windows Mitm Transition Fix
- Windows registry-managed mitmproxy now persists a dedicated `start-mitmproxy.ps1` launcher that rebuilds the service env in Process scope before launching `mitmdump`, including `MYELIN_HEADROOM_PORT`, `MYELIN_EGRESS_PORT`, and Copilot-Headroom routing vars.
- The launcher clears stale optional managed env vars when they are no longer configured, preserving existing egress and Copilot-Headroom behavior without leaking prior registry-managed state into the next process tree.
- Restart/install now stop only the Myelin-managed mitmproxy instance via the persisted launcher/PID plus exact command-line identity, instead of `Stop-Process -Name mitmdump`, so unrelated system `mitmdump` processes are left alone.

## Windows Mitm Status Fix
- Registry-mode `mitmServiceStatus()` now validates the persisted managed launcher, PID file, executable path, parent launcher path, and exact command line before reporting Running.
- Added regression coverage for the status-script generator and parser so an unrelated `mitmdump` snapshot cannot satisfy the managed service check.
- `myelin verify` stays red when only an unrelated `mitmdump` exists.

## Transition Edge Fix
- Windows registry-mode `myelin restart` now always rebuilds/persists the Copilot-Headroom launcher from current config before spawning it, while stopping the previously managed instance from the recorded Run-key identity so port changes do not leave the old owned process behind.
- Headroom Lite restart now verifies the recorded managed PID before unlinking or replacing state; if the tracked owned Lite process is still alive on the old port, restart stops it first instead of forgetting ownership and starting a second managed Lite instance.
- Added restart regressions for both edges: Copilot-Headroom launcher regeneration on Windows registry restarts and Lite managed-PID cleanup during port transitions.
