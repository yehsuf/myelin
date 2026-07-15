# Managed Update Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `myelin update` safely update the managed runtime and integration, with a non-activating `--download-only` mode.

**Architecture:** A single dependency-free path module makes `MYELIN_DIR` and the default home directory consistent for all user-global Myelin state across Node, Python, shell, and PowerShell. Staging validates candidates before replacing any release directory or pointer. The public update command orchestrates activation, integration, stale-config reporting, existing tool updates, and restart.

**Tech Stack:** Node.js >=20 ESM, Commander.js, Node test runner, POSIX shell, PowerShell.

## Global Constraints

- Releases are `main-<commit>` directories under the resolved managed root.
- The managed root is non-empty `MYELIN_DIR`, otherwise `<home>/.myelin`; it contains every user-global Myelin file, including config, release, service, tool, log, CA, memory, and venv paths.
- Repository-local project `.myelin`, shell-profile locations, `.serena` state, and OS service labels are explicitly excluded from relocation.
- `myelin update --download-only` must not change `current.json`, launcher, aliases, services, wrappers, hooks, MCP configuration, external tools, or restart state.
- `myelin update --check` remains a non-mutating preview of external-tool updates and must not stage or activate a runtime.
- Normal `myelin update` stages, activates, writes the launcher, applies the selected runtime's installer with `--yes`, reports stale config, upgrades tools, and restarts.
- `myelin update --self` and `myelin self update` are migration errors directing users to `myelin update`.
- A failed stage must preserve both `current.json` and the selected runtime directory, including same-commit restages.
- Bootstrap `--dry-run` and `--check` must not activate a release.
- All source is ESM, Windows is first-class, and no new runtime dependencies or symlink assumptions are allowed.

---

### Task 1: Centralize managed runtime-root resolution

**Files:**
- Create: `src/shared/myelin-paths.mjs`
- Modify: `src/config/reader.mjs`
- Modify: `src/config/writer.mjs`
- Modify: `src/cli/config-cmd.mjs`
- Modify: `src/runtime/release-store.mjs`
- Modify: `src/runtime/launcher.mjs`
- Modify: `src/install.mjs`
- Modify: `src/tools/rtk.mjs`
- Test: `test/release-store.test.mjs`
- Test: `test/update.test.mjs`
- Test: `test/rtk-guard.test.mjs`

**Interfaces:**
- Produces `resolveMyelinRoot({ home, env, rootDir })`, returning `rootDir` when it is a non-empty string, then `env.MYELIN_DIR` when non-empty, otherwise `join(home, '.myelin')`.
- Produces pure path helpers for `configPath`, `binDir`, `venvPath`, `caBundlePath`, `runtimeBridgeRoot`, `serviceStatePath`, and release paths.
- Changes `runtimePaths` to accept `{ home, rootDir }` and build `root`, `releasesDir`, `currentPointerPath`, and `launcherPath` beneath the resolved root.
- All release-store calls accept and forward `rootDir`; generated Node/Python bridges read `MYELIN_DIR` on every invocation.

- [ ] **Step 1: Write failing custom-root tests**

Add tests that assert the same supplied root is used by release-store paths,
the generated launcher source, generated CLI/Python bridges, and the RTK hook:

```js
const rootDir = join(home, 'managed-root');
assert.equal(runtimePaths({ home, rootDir }).root, rootDir);
assert.equal(readCurrentRelease({ home, rootDir }).runtimeRoot,
  join(rootDir, 'releases', 'main-abcdef1'));
assert.ok(bridgeSource.includes("process.env.MYELIN_DIR"));
assert.ok(pythonBridgeSource.includes("os.environ.get('MYELIN_DIR')"));
```

- [ ] **Step 2: Run focused tests to verify failure**

Run:

```bash
node --test test/release-store.test.mjs test/update.test.mjs test/rtk-guard.test.mjs
```

Expected: FAIL because runtime paths and generated bridges hardcode
`<home>/.myelin`.

- [ ] **Step 3: Implement one root resolver**

Use this shared interface in `src/shared/myelin-paths.mjs`:

```js
export function resolveMyelinRoot({ home, env = process.env, rootDir } = {}) {
  const configuredRoot = rootDir ?? env.MYELIN_DIR;
  return typeof configuredRoot === 'string' && configuredRoot.trim()
    ? configuredRoot
    : join(home, '.myelin');
}

export function managedPaths({ home, env, rootDir } = {}) {
  const root = resolveMyelinRoot({ home, env, rootDir });
  return {
    root,
    configPath: join(root, 'config.yaml'),
    binDir: join(root, 'bin'),
    venvPath: join(root, 'venv'),
    caBundlePath: join(root, 'ca-bundle.pem'),
    releasesDir: join(root, 'releases'),
    currentPointerPath: join(root, 'current.json'),
    launcherPath: join(root, 'bin', 'myelin-launcher.mjs'),
  };
}
```

Thread `rootDir` through `readCurrentRelease`, `writeCurrentRelease`,
`stageMainRuntime`, `writeManagedLauncher`, installer bridge paths, RTK, and
all config reader/writer/command defaults. Generated JavaScript must use
`process.env.MYELIN_DIR || join(homedir(), '.myelin')`; generated Python must
use `os.environ.get('MYELIN_DIR') or Path.home() / '.myelin'`.
Generated JavaScript must use `process.env.MYELIN_DIR || join(homedir(),
'.myelin')`; generated Python must use `os.environ.get('MYELIN_DIR') or
Path.home() / '.myelin'`.

- [ ] **Step 4: Run focused tests to verify success**

Run:

```bash
node --test test/release-store.test.mjs test/update.test.mjs test/rtk-guard.test.mjs
```

Expected: PASS with custom-root and default-root coverage.

- [ ] **Step 5: Commit**

```bash
git add src/shared/myelin-paths.mjs src/config/reader.mjs src/config/writer.mjs src/cli/config-cmd.mjs src/runtime/release-store.mjs src/runtime/launcher.mjs src/install.mjs src/tools/rtk.mjs test/release-store.test.mjs test/update.test.mjs test/rtk-guard.test.mjs
git commit -m "feat(update-001): centralize managed runtime root"
```

### Task 2: Migrate user-global service and tool paths

**Files:**
- Modify: `src/install.mjs`
- Modify: `src/tools/headroom.mjs`
- Modify: `src/tools/winsw.mjs`
- Modify: `src/tools/rtk.mjs`
- Modify: `src/detect/combined-ca.mjs`
- Modify: `src/detect/tool-path.mjs`
- Modify: `src/service/litellm-service.mjs`
- Modify: `src/service/launchd.mjs`
- Modify: `src/service/systemd.mjs`
- Modify: `src/service/windows.mjs`
- Modify: `src/service/token-optimizer.mjs`
- Modify: `src/cli/init.mjs`
- Modify: `src/cli/restart.mjs`
- Modify: `src/cli/stats.mjs`
- Test: `test/service.test.mjs`
- Test: `test/service-isolation.test.mjs`
- Test: `test/combined-ca.test.mjs`
- Test: `test/detect-tool-path.test.mjs`
- Test: `test/restart.test.mjs`
- Test: `test/stats.test.mjs`
- Test: `test/rtk-guard.test.mjs`
- Test: `test/token-optimizer.test.mjs`

**Interfaces:**
- Each user-global path consumer accepts `home`, `env`, or an explicit root
  through its existing injected dependency/options object, then derives paths
  only from `managedPaths`.
- Existing OS service labels and repository-local project `.myelin` logic are
  not passed through the managed-path helper.

- [ ] **Step 1: Write failing relocation tests**

For each affected pure path helper or service renderer, inject a temporary
`MYELIN_DIR` and assert the rendered path starts under that directory:

```js
const env = { MYELIN_DIR: join(home, 'custom-myelin') };
assert.equal(headroomVenvPath({ home, env }), join(env.MYELIN_DIR, 'venv'));
assert.match(renderedService, new RegExp(escapeRegExp(env.MYELIN_DIR)));
assert.ok(!renderedService.includes(join(home, '.myelin')));
```

Keep a paired assertion that project-local `join(repoRoot, '.myelin')` remains
unchanged.

- [ ] **Step 2: Run focused tests to verify failure**

Run:

```bash
node --test test/service.test.mjs test/service-isolation.test.mjs test/combined-ca.test.mjs test/detect-tool-path.test.mjs test/restart.test.mjs test/stats.test.mjs test/rtk-guard.test.mjs test/token-optimizer.test.mjs
```

Expected: FAIL because at least one global service, tool, CA, log, or venv
path still constructs `<home>/.myelin` directly.

- [ ] **Step 3: Replace direct global path construction**

Import `managedPaths` in each listed global-state module and replace only
`join(home, '.myelin', ...)` equivalents with the matching helper path.
Thread the selected root into generated shell and PowerShell profiles, Windows
registry values, service definitions, launchd/systemd working directories,
and log paths. Do not change project-local `.myelin` calls or service labels.

- [ ] **Step 4: Run focused tests to verify success**

Run the Step 2 command again.

Expected: PASS with custom-root path coverage and unchanged project-local
state assertions.

- [ ] **Step 5: Commit**

```bash
git add src/install.mjs src/tools src/detect src/service src/cli test/service.test.mjs test/service-isolation.test.mjs test/combined-ca.test.mjs test/detect-tool-path.test.mjs test/restart.test.mjs test/stats.test.mjs test/rtk-guard.test.mjs test/token-optimizer.test.mjs
git commit -m "feat(update-001): relocate managed global state"
```

### Task 3: Make staging and bootstrap activation-safe

**Files:**
- Modify: `src/runtime/stage-main.mjs`
- Modify: `install.sh`
- Modify: `install.ps1`
- Test: `test/release-store.test.mjs`

**Interfaces:**
- `stageMainRuntime({ home, rootDir, repoUrl, activate = true, ...deps })`
  validates a temporary candidate, returns `{ releaseId, runtimeRoot, reused }`,
  and writes the pointer only when `activate` is true.
- Bootstrap scripts export the selected `MYELIN_DIR` before invoking Node.

- [ ] **Step 1: Write failing stage and bootstrap safety tests**

Add a same-commit failure case:

```js
writeCurrentRelease({ home, rootDir, releaseId });
mkdirSync(join(runtimeRoot, 'src', 'cli'), { recursive: true });
assert.throws(() => stageMainRuntime({ home, rootDir, repoUrl, execFileSyncFn }), /npm ci failed/);
assert.equal(existsSync(runtimeRoot), true);
assert.equal(readCurrentRelease({ home, rootDir }).runtimeRoot, runtimeRoot);
```

Add static/bootstrap behavioral checks that `--dry-run` and `--check` bypass
pointer-writing staging and that both scripts export/pass `MYELIN_DIR`.

- [ ] **Step 2: Run focused tests to verify failure**

Run:

```bash
node --test test/release-store.test.mjs
```

Expected: FAIL because an incomplete destination is deleted before candidate
validation and bootstraps stage unconditionally.

- [ ] **Step 3: Validate before replacing**

Keep the existing release directory until `npm ci --ignore-scripts` and
`node --check src/cli/index.mjs` succeed in `stageRoot`. Only then remove a
non-reusable destination, rename the validated candidate, and call
`writeCurrentRelease` when `activate` is true:

```js
validateStage(stageRoot);
if (existsSyncFn(runtimeRoot) && !isReusableRelease(runtimeRoot, existsSyncFn)) {
  rmSyncFn(runtimeRoot, { recursive: true, force: true });
}
renameSyncFn(stageRoot, runtimeRoot);
if (activate) writeCurrentReleaseFn({ home, rootDir, releaseId });
```

For `activate: false`, retain the validated candidate but do not call
`writeCurrentRelease`. Preserve all existing cleanup of failed `stageRoot`.

In `install.sh`, parse `--dry-run` and `--check` before `stage_main_runtime`;
in `install.ps1`, branch on `$DryRun -or $Check`. Those modes must execute
only non-activating behavior and never call the pointer writer. Export
`MYELIN_DIR` in both scripts and replace the Windows Defender bin path with
`Join-Path $MyelinDir 'bin'`.

- [ ] **Step 4: Run focused tests to verify success**

Run:

```bash
node --test test/release-store.test.mjs
```

Expected: PASS, including failed same-commit restage preservation and
non-activating bootstrap modes.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/stage-main.mjs install.sh install.ps1 test/release-store.test.mjs
git commit -m "fix(update-001): preserve runtime before activation"
```

### Task 4: Replace the public self-update command

**Files:**
- Modify: `src/cli/index.mjs`
- Modify: `src/cli/update.mjs`
- Test: `test/update.test.mjs`

**Interfaces:**
- `runManagedUpdate({ downloadOnly = false, check = false }, deps)` returns
  `{ status, releaseId, runtimeRoot, staleKeys, downloadOnly }`.
- A dependency-injected installer runner receives the selected runtime root
  and `['--yes']`.

- [ ] **Step 1: Write failing command and orchestration tests**

Cover the public surface:

```js
assert.match(updateHelp.stdout, /--download-only/);
assert.equal(selfUpdate.status, 1);
assert.match(selfUpdate.stderr, /run `myelin update`/);
```

Cover default orchestration with injected dependencies:

```js
await runManagedUpdate({}, deps);
assert.deepEqual(calls, [
  ['stage', { activate: true }],
  ['launcher'],
  ['installer', ['--yes']],
  ['stale-config'],
  ['tool-updates'],
  ['restart'],
]);
```

Cover download-only:

```js
await runManagedUpdate({ downloadOnly: true }, deps);
assert.deepEqual(calls, [['stage', { activate: false }]]);
assert.equal(result.downloadOnly, true);
```

- [ ] **Step 2: Run focused tests to verify failure**

Run:

```bash
node --test test/update.test.mjs
```

Expected: FAIL because `update` performs tool-only updates, `self update`
activates separately, and no download-only option exists.

- [ ] **Step 3: Implement the managed update pipeline**

Make `update` accept `--download-only` and route to `runManagedUpdate`.
Retain `--check` as a non-mutating preview of tool updates and runtime
activation. Replace the functional `self update` action with a migration-only
handler that prints `` `myelin self update` is deprecated; run `myelin update`. ``.

The normal path must call:

```js
const staged = stageMainRuntimeFn({ home, rootDir, repoUrl, activate: true });
const launcher = writeManagedLauncherFn({ home, rootDir, os });
installerRunner({
  runtimeRoot: staged.runtimeRoot,
  args: ['--yes'],
  env: { ...process.env, MYELIN_DIR: rootDir },
});
const { staleKeys } = await checkStaleConfigKeysFn();
await runToolUpdatesFn();
await runRestartFn();
```

The download-only path calls `stageMainRuntimeFn` with `activate: false`,
prints the retained release, and returns without every later operation.
Installer failure returns nonzero without rolling back the validated pointer.
The `--check` path must call only the existing external-tool preview and
return without staging, launcher writes, installer execution, or restart.

- [ ] **Step 4: Run focused tests to verify success**

Run:

```bash
node --test test/update.test.mjs
node src/cli/index.mjs update --help
node src/cli/index.mjs self update
```

Expected: tests PASS; help lists `--download-only`; `self update` exits
nonzero with the migration message.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.mjs src/cli/update.mjs test/update.test.mjs
git commit -m "feat(update-001): make update managed runtime flow"
```

### Task 5: Migrate user documentation and regression coverage

**Files:**
- Modify: `README.md`
- Modify: `BACKLOG.md`
- Test: `test/update.test.mjs`

**Interfaces:**
- README install and update examples invoke managed commands only.

- [ ] **Step 1: Write a failing documentation regression test**

Add a source assertion:

```js
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
assert.ok(readme.includes('myelin update'));
assert.ok(!readme.includes('myelin update --self'));
assert.ok(!readme.includes('~/.myelin/repo'));
assert.ok(!readme.includes('git reset --hard origin/main'));
```

- [ ] **Step 2: Run focused test to verify failure**

Run:

```bash
node --test test/update.test.mjs
```

Expected: FAIL because README still describes mutable checkout installation and
the deprecated `update --self` command.

- [ ] **Step 3: Replace mutable-checkout instructions**

Use `install.sh` for macOS/Linux and `install.ps1` for Windows installation.
Use `myelin install --yes` for reconfiguration, profile examples, and block
bypass service regeneration. Document:

```bash
myelin update
myelin update --download-only
```

Explain that download-only validates and retains a release without switching
the active runtime. Mark `INSTALL-001` `in-progress` until the complete
branch passes final review and platform validation.

- [ ] **Step 4: Run focused test to verify success**

Run:

```bash
node --test test/update.test.mjs
```

Expected: PASS with no legacy deployment-checkout commands documented.

- [ ] **Step 5: Commit**

```bash
git add README.md BACKLOG.md test/update.test.mjs
git commit -m "docs(update-001): document managed update workflow"
```

### Task 6: Validate the completed update flow

**Files:**
- Test: `test/release-store.test.mjs`
- Test: `test/update.test.mjs`
- Test: `test/rtk-guard.test.mjs`

- [ ] **Step 1: Run all managed-update focused suites**

Run:

```bash
node --test test/release-store.test.mjs test/update.test.mjs test/rtk-guard.test.mjs
```

Expected: PASS for default/custom root, stage failure preservation,
download-only non-activation, command migration, integration orchestration,
and documentation assertions.

- [ ] **Step 2: Run the complete suite**

Run:

```bash
npm test
```

Expected: PASS with no skipped or failed tests.

- [ ] **Step 3: Validate command behavior**

Run:

```bash
node src/cli/index.mjs update --help
node src/cli/index.mjs update --download-only
node src/cli/index.mjs self update
```

Expected: help documents `--download-only`; download-only either stages a
candidate or reports its infrastructure failure without changing a pointer;
the deprecated nested command exits nonzero with its migration message.

- [ ] **Step 4: Review the final diff**

Verify the release pointer is never changed by download-only, dry-run, check,
or a failed stage; verify all generated runtime consumers use the root
resolver; verify README has no deployment-checkout commands.

- [ ] **Step 5: Confirm no validation-only commit is needed**

Run:

```bash
git status --short
```

Expected: no source changes. If validation exposes a defect, return to the
task that owns the affected file and add its focused regression test before
committing the correction with that task.

---

## Task 2 — Final Findings Resolution (2026-07-14)

Follow-up fixes for the two remaining Task 2 review findings. No live
installer/service action was taken; verification is via mocks and injected
temp homes/env only.

**Finding 1 — `buildCombinedCaCert` ignored an injected env.**
`src/detect/combined-ca.mjs` resolved the combined CA bundle path with
`managedPaths({ home })`, so a caller-injected `env` (e.g. a relocated
`MYELIN_DIR`) was not honored — only the ambient `process.env` was consulted.
Fix: added an `env = process.env` option threaded into
`managedPaths({ home, env })`. New tests in `test/combined-ca.test.mjs` assert
the injected `env.MYELIN_DIR` reroutes the bundle without mutating
`process.env`, and that an injected env overrides the ambient value.

**Finding 2 — `installCopilotHeadroomService` registry env dropped `MYELIN_DIR`.**
The dedicated Copilot-Headroom registry (Run-key) path persisted `envVars`
verbatim, unlike the Claude-Headroom (`installService`) and mitm paths which
wrap env in `withForwardedMyelinDir`. A relocated managed root was therefore
lost on a Run-key restart. Fix: wrapped the persisted env in
`withForwardedMyelinDir(envVars, env)` so the baked launcher (`Process`-scope
`SetEnvironmentVariable('MYELIN_DIR', ...)`) and the Run-key relaunch retain
the relocation. Added an injectable `runPsImpl` (mirroring
`spawnDetachedService`'s `runPsFn`) so the function is testable without
executing PowerShell. New tests in `test/service.test.mjs` assert the launcher
persists the forwarded `MYELIN_DIR` and the working directory follows the
relocated root, and that a default install (unset env) persists no
`MYELIN_DIR`.

**Verification:**
- Focused: `node --test test/combined-ca.test.mjs test/service.test.mjs` → 111 pass, 0 fail.
- Full: `node --test 'test/**/*.test.mjs'` → 592 pass, 0 fail.

---

## Task 2 — Windows Validation Regression: explicit path-platform input (2026-07-14)

Fixes the Windows-host validation regression where the new shared
`managedPaths`/`resolveMyelinRoot` helper (`src/shared/myelin-paths.mjs`) joined
paths with the host-native `node:path` separator. On a Windows host, callers and
tests that *simulate* darwin/linux (injecting POSIX homes like `/home/u`) got
backslashed paths (`\home\u\.myelin\...`) where POSIX paths were required,
failing ~24 isolated-Windows tests. No installer/service/live-HOME action was
taken; verification is via the Mac suite plus a faithful in-process Windows
simulation (win32 `node:path` + `process.platform='win32'`).

**Root cause.** Separators leaked from the host's `process.platform` because the
shared helper used the ambient `node:path`. A simulated-OS caller had no way to
select the target separator, so the same POSIX input produced host-dependent
output.

**Design — explicit platform/path-implementation input (no `process.platform`
leakage at call sites).** `src/shared/myelin-paths.mjs` now:
- accepts an explicit `platform` (default `process.platform`) on
  `resolveMyelinRoot` / `managedPaths`; `'win32'`/`'windows'` → Windows
  separators, every other token (darwin/linux/WSL/…) → POSIX;
- exports `pathModuleForPlatform(platform)` (→ `path.win32`|`path.posix`),
  `isWindowsStylePath(p)` (drive-rooted/UNC/backslash detection), and
  `joinManaged(base, ...segs)` which extends an *already-resolved* root in the
  root's own separator style (used at no-signal sites so an injected
  POSIX/Windows `MYELIN_DIR` keeps its style without re-plumbing a platform
  token). The default-root join is the only place a `platform` token governs the
  separator, so an injected `MYELIN_DIR`/`rootDir` is always used verbatim.

**Callers threaded (each honors an explicit signal it already had):**
- `src/detect/tool-path.mjs` `ensureToolPath` — `platform` into `managedPaths`
  and its own `.local/bin`/AppData/nvm joins via `pathModuleForPlatform`.
- `src/cli/rtk-guard.mjs` `rtkBinaryCandidates` — `plat` into `managedPaths` and
  the `bin`/`.cargo/bin` joins.
- `src/tools/rtk.mjs` `resolveMyelinRepoRoot` — passes its existing `plat` into
  `managedPaths` (previously computed `sep` but not the root) and the probe join.
- `src/cli/update.mjs` `upgradeCommands` — `os` into `managedPaths` for the
  headroom venv path.
- `src/cli/stats.mjs` `mitmproxyLogPath` — added `platform` param; uses
  `joinManaged` on the resolved root.
- `src/cli/restart.mjs` `buildCopilotHeadroomTaskEnv` and
  `src/service/token-optimizer.mjs` `defaultCloneDir` — no-signal sibling joins
  converted to `joinManaged` (no test edits needed).

**Tests.**
- New host-independent regression tests in `test/myelin-paths.test.mjs` for
  `pathModuleForPlatform`, `isWindowsStylePath`, `joinManaged`, and
  `managedPaths`/`resolveMyelinRoot` proving simulated darwin/linux → POSIX and
  simulated win32 → backslashes on the *same* host.
- `test/stats.test.mjs` — thread `platform:'linux'` into the two
  `mitmproxyLogPath` cases (the only no-signal caller that needed a test signal).
- Corrected latent host-native-`join` expected values that would fail on a real
  Windows host despite simulating a POSIX platform:
  `test/detect-tool-path.test.mjs` (win32 cases now assert `win32.join`),
  `test/rtk-guard.test.mjs` (`resolveRtkBinary` first-candidate uses a POSIX
  literal matching `plat:'linux'`), `test/update.test.mjs` (drop mixed-separator
  `.replace` expected), `test/service.test.mjs` (project-local `.myelin`
  compares to `join(repoRoot,'.myelin')`).

**Verification.**
- Focused: `node --test test/myelin-paths.test.mjs test/detect-tool-path.test.mjs test/rtk-guard.test.mjs test/stats.test.mjs test/restart.test.mjs test/token-optimizer.test.mjs test/update.test.mjs test/service.test.mjs` → 220 pass, 0 fail.
- Full (Mac): `node --test 'test/**/*.test.mjs'` → 603 pass, 0 fail (+11 new regression tests).
- Faithful Windows simulation (in-process loader mapping `node:path`→win32 for
  app code + `process.platform='win32'`) over the path-logic suites
  (myelin-paths, detect-tool-path, rtk-guard, stats, restart, token-optimizer) →
  93 pass, 0 fail: simulated darwin/linux yields POSIX and real Windows paths are
  preserved. Remaining full-suite failures under that simulation are confined to
  suites doing real temp-dir fs, subprocess spawns (Python bridges, MCP servers,
  `npm.cmd`), or dynamic-import of computed win32 paths on a POSIX filesystem —
  harness limitations present identically on `origin/main`, not path-separator
  logic.

---

## Review-finding follow-up (task2) — root-style separators + caller propagation

Addressed three review findings on top of the explicit-platform threading:

**1. `managedPaths` mixed separators on explicit-root/platform conflict.**
`src/shared/myelin-paths.mjs` — the derived paths (`configPath`, `binDir`,
`venvPath`, `launcherPath`, …) still joined with `pathModuleForPlatform(platform)`,
so an explicit `rootDir`/`MYELIN_DIR` whose style disagreed with `platform` (a
Windows `D:\managed` on a linux target, or a POSIX `/custom/mroot` on a win32
target) spliced a mismatched separator into the resolved root
(`D:\managed/config.yaml`). Now: when the root is explicit (non-blank `rootDir`
or `MYELIN_DIR`), the join style is derived from the resolved root itself via
`isWindowsStylePath` — an explicit root keeps one consistent separator. The
default `<home>/.myelin` root still tracks `platform`.

**2. token-optimizer default clone dir dropped its os/platform.**
`src/service/token-optimizer.mjs` `defaultCloneDir` now forwards `platform: os`
into `managedPaths` (and accepts an injectable `home`, and is exported) so the
default clone dir's root resolves under the caller's target platform, not the
host's `process.platform`.

**3. restart did not thread its platform.**
`src/cli/restart.mjs` `buildCopilotHeadroomTaskEnv` now takes a `platform`
param and forwards it into `managedPaths`; `runRestart` passes the `detectOS()`
result (`os`) when building the Copilot-Headroom task env.

**Tests.**
- `test/myelin-paths.test.mjs` — Windows explicit root + POSIX platform (and the
  inverse: POSIX `MYELIN_DIR` + win32 platform) now assert every derived path
  keeps one consistent separator style (no mixed `\`+`/`).
- `test/restart.test.mjs` — caller-propagation: threading `platform`
  (`windows`/`darwin`) keeps a default `HEADROOM_WORKSPACE_DIR` root in the
  matching separator style on any host.
- `test/token-optimizer.test.mjs` — `defaultCloneDir` propagation: `os`
  (`windows`/`darwin`) selects the default-root separator style host-independently.
- `test/install-profile-path.test.mjs` — corrected the latent host-native-`join`
  expectation: a Windows-style `MYELIN_DIR` now yields `D:\managed\bin` (proper
  backslashes) via the root-style derivation, replacing the host-native
  `join('D:\\managed','bin')` value that only held on a POSIX host.

**Verification.**
- Focused: `node --test test/myelin-paths.test.mjs test/restart.test.mjs test/token-optimizer.test.mjs` → 45 pass, 0 fail.
- Full (Mac): `node --test 'test/**/*.test.mjs'` → 609 pass, 0 fail.
- No installer/service/live-HOME/live-machine action taken.

## Review-finding follow-up (task2) — WinSW root-style separators (2026-07-14)

Final remaining root-style finding: the WinSW path helpers forced
`pathWin32.join` onto a resolved managed root, so a relocated explicit
POSIX/Windows `MYELIN_DIR` spliced a mismatched separator into the base
(e.g. `/srv/managed\services\myelin-headroom`) — the same class of bug already
fixed for `managedPaths`/`liteLLMConfigPath`.

**Change — route managed-root-derived joins through `joinManaged`.**
- `src/service/windows.mjs` — `winswServiceDir`, `winswExecutablePath`,
  `winswConfigPath`, `winswWatchdogScriptPath`, `winswWatchdogLogPath`, and the
  default (`!logPath`) branch of `winswLogDir` now use `joinManaged`, so a
  relocated root keeps one consistent separator style end to end. The default
  root is `windowsPath`-normalized via `defaultWindowsHome`, so a normal Windows
  install stays fully backslashed — only an explicitly relocated POSIX root
  diverges.
- `src/tools/winsw.mjs` — `winswBinPath` and the `bin` `mkdirSync` now use
  `joinManaged` (unused `pathWin32` import removed).

**Retained Windows conventions (intentionally left `pathWin32`/`windowsPath`).**
- `defaultServiceEnv` `APPDATA`/`LOCALAPPDATA` — derived from the always-Windows
  `winHome`, not the managed root; they are Windows service env vars.
- `winswLogDir` explicit-`logPath` branch — a caller-supplied log path is
  deliberately `windowsPath`-normalized before `extname`/`dirname`.
- `generateCopilotHeadroomRunScript` launcher `.ps1` path — the generated
  PowerShell runs on Windows and its `workDir` is `windowsPath`-normalized.

**Tests.** `test/service.test.mjs` (`managed-root relocation (MYELIN_DIR)`):
- new cross-style case: a POSIX `MYELIN_DIR` keeps every WinSW/watchdog asset
  path (`winswServiceDir`, `winswServicePaths`, `winswBinPath`) forward-slashed
  with no spliced backslashes;
- complementary case: a Windows `MYELIN_DIR` stays fully backslashed with no
  spliced forward-slash. Existing Windows-style relocation tests unchanged
  (a Windows base through `joinManaged` equals the prior `pathWin32.join`).

**Verification.**
- Focused: `node --test test/service.test.mjs test/myelin-paths.test.mjs` → 113 pass, 0 fail.
- Full (Mac): `node --test 'test/**/*.test.mjs'` → 612 pass, 0 fail.
- No installer/service/live-HOME/live-machine action taken.
