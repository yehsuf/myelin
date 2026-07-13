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

## WSL and Headroom Migration Fix
- Windows registry-mode Copilot-Headroom restart now resolves the effective Windows home before rebuilding launcher state, persists the launcher through PowerShell at the real Windows path, and can recover launcher-backed process identity even when WSL cannot read `C:\...` paths through the local POSIX filesystem.
- Windows managed Python Headroom stop/reinstall now keeps the tracked PID tied to the managed launcher path, so a port migration still stops the owned instance before deleting the PID file or replacing registration state.
- Added focused regressions for WSL launcher recovery/path resolution and for managed Headroom launcher/PID stop-script ownership checks during port migrations.

## Windows Legacy Fix
- Main Headroom legacy Run-key cleanup now parses the stored executable and stored `--port` from the existing command, stops only that exact owned legacy process, and clears the legacy Run key during migration/restart cleanup.
- Registry-mode Copilot-Headroom status now derives managed identity from the persisted launcher/command when available and otherwise falls back to the caller-supplied configured port instead of hard-coding `8788`.
- Added regressions for old-port legacy Headroom cleanup and custom-port Copilot-Headroom status propagation through `verify`.

## WSL Mitm Fix
- Windows registry-managed mitmproxy now normalizes WSL filesystem inputs for the managed binary, addon, CA bundle, launcher, PID, log, and home paths before building/installing/restarting the service, while leaving URL-valued env vars like `HTTPS_PROXY` untouched.
- `mitmServiceStatus()` now recovers the managed launcher script and PID through the existing safe PowerShell/Windows-file fallback path, so WSL `verify` can correctly recognize the owned Windows mitmproxy service.
- Added focused WSL regressions covering install-option normalization, restart propagation, managed launcher generation, and registry status recovery.

## Windows Ownership Fix
- Centralized runtime PowerShell executable selection so WSL fallback/status probes invoke `powershell.exe`, while native Windows keeps using the standard executable path for shell-out probes.
- Managed Headroom and mitm PID-file stops now require a launcher-parent match before `Stop-Process`; PID reuse, matching ports, or matching command lines alone only clear the stale PID file and leave unrelated processes intact.
- Added WSL status regressions plus managed-PID ownership regressions covering stale/reused PID files without breaking normal managed-stop behavior.

## Remaining Ownership Paths Fix
- Obsolete Windows Headroom Run-key cleanup in `install.mjs` now routes both the stop path and registry deletion through the centralized WSL-aware PowerShell executable selection, so WSL cleanup shells out via `powershell.exe`.
- Headroom Lite stop/cleanup now requires launcher-backed ownership before killing a tracked PID; reused/stale PID files that only match the executable or port are cleared without stopping unrelated processes.
- Added focused install/restart regressions for WSL Run-key cleanup routing, stale reused Lite PID cleanup, and the preserved true managed Lite stop path.

## High Task 2 Review Fix
- `src/install.mjs` now imports `powerShellExecutable` and uses it for both the default cleanup-command builder and default obsolete-Headroom cleanup invocation, eliminating the latent `ReferenceError` on non-injected calls.
- Windows-mode Headroom Lite restart/cleanup now resolves the effective Windows home before binary lookup, launcher/PID path generation, state-file cleanup, and PowerShell `-File` execution, so WSL paths stay on real `C:\...` locations instead of leaking `/mnt/...` or `\mnt\...`.
- Added regressions covering default-parameter cleanup invocation plus WSL Lite restart/cleanup command generation and owned-PID cleanup, proving no POSIX Windows-launcher paths are emitted while native Windows behavior remains intact.

## High Task 2 Verification
1. `node --test test/install.test.mjs test/restart.test.mjs`
   - `31` tests, `31` passed, `0` failed
2. `npm test`
   - `480` tests, `480` passed, `0` failed

## High Task 2 Findings Fix
- `src/install.mjs` now routes the install-time engine plan through `applyServiceEngineInstallPlan()`, so selecting Python Headroom first stops only the previously managed Headroom Lite instance via the existing ownership-checked restart cleanup path before re-registering managed Headroom.
- Windows registry-mode main `serviceStatus()` now derives managed main-Headroom identity from the Myelin Run key, launcher, PID file, executable path, and exact command line, while preserving a safe exact-match fallback for older legacy Run-key installs until they are migrated.
- Added focused regressions for the Lite→Headroom install transition, positive and negative main-Headroom registry identity checks, legacy registry status compatibility, and verify staying red when only Copilot-Headroom is healthy.

## High Task 2 Findings Verification
1. `node --test test/install.test.mjs test/service.test.mjs test/verify.test.mjs`
   - `110` tests, `110` passed, `0` failed
2. `node --test test/install.test.mjs test/service.test.mjs test/verify.test.mjs test/restart.test.mjs`
   - `131` tests, `131` passed, `0` failed
3. `npm test`
   - `486` tests, `486` passed, `0` failed

## High Task 2 Integration Findings Fix
- Installer-side downstream proxy wiring now derives mitm/watchdog options from the resolved `applyServiceEngineInstallPlan()` result, so a Headroom Lite fallback to Python Headroom carries the resolved engine port into `MYELIN_HEADROOM_PORT` and watchdog health targets instead of reusing the stale pre-fallback plan.
- `myelin restart` now regenerates/reinstalls Copilot-Headroom static service definitions from current config on launchd, systemd, and WinSW via the existing install path, so changed port/mode/egress values update persisted service assets instead of only restarting stale definitions; Windows registry restart keeps its launcher-regeneration flow.
- Added focused regressions for both integration findings: fallback wiring into downstream install options plus Copilot-Headroom reinstall behavior across macOS, Linux, and Windows WinSW.

## High Task 2 Integration Findings Verification
1. `node --test test/install.test.mjs test/restart.test.mjs`
   - `37` tests, `37` passed, `0` failed
2. `node --test test/install.test.mjs test/restart.test.mjs test/service.test.mjs test/service-isolation.test.mjs`
   - `139` tests, `139` passed, `0` failed
3. `npm test`
   - `490` tests, `490` passed, `0` failed

## Lite Exclusion and Watchdog Refresh Fix
- `proxy.engine: headroom_lite` no longer falls back to managed Python Headroom during install or restart. If Lite is missing or unhealthy, Myelin now leaves the configured Lite port/wiring intact, reports the failure directly, and still removes obsolete managed Python Headroom from that machine.
- `myelin restart` now regenerates/reinstalls the main Python Headroom static service definitions on launchd, systemd, and WinSW from current config before bringing the selected engine back up, matching the existing Copilot-Headroom refresh behavior.
- Restart also refreshes watchdog definitions after service wiring changes so watchdog health targets follow the current selected engine / Copilot / mitm ports instead of retaining stale Python-Headroom ports.

## Lite Exclusion and Watchdog Refresh Verification
1. `node --test test/install.test.mjs test/restart.test.mjs`
   - `41` tests, `41` passed, `0` failed
2. `node --test test/install.test.mjs test/restart.test.mjs test/verify.test.mjs test/stats.test.mjs`
   - `49` tests, `49` passed, `0` failed
3. `npm test`
   - `494` tests, `494` passed, `0` failed

## High Lite Hard-Exclusion Fix
- Installer package selection now resolves `proxy.engine` up front and skips `headroom-ai[all]` entirely when `proxy.engine=headroom_lite`, including the dry-run surface, unless Python Headroom is the selected engine.
- launchd watchdog script generation now treats `headroomPort` as optional and omits the main Python Headroom revive stanza when downstream wiring intentionally passes `undefined`, while still preserving the stanza for real Python Headroom installs.
- Added focused regressions covering both hard-exclusion gaps: installer package gating and launchd watchdog stanza omission/preservation.

## High Lite Hard-Exclusion Verification
1. `node --test test/install.test.mjs test/service.test.mjs test/restart.test.mjs`
   - `137` tests, `137` passed, `0` failed
2. `npm test`
   - `498` tests, `498` passed, `0` failed
