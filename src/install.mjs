#!/usr/bin/env node
/**
 * Myelin — complete installer
 * Flags: --profile proxy|mcp|minimal  --index-tier light|default|full
 *        --no-headroom  --no-rtk  --copilot-only  --claude-only
 *        --check  --dry-run
 */
import { parseArgs } from 'node:util';
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, accessSync, unlinkSync, chmodSync, symlinkSync } from 'node:fs';
import { join, resolve, win32 as pathWin32 } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createInterface as createRL } from 'node:readline';
import { buildCombinedCaCert } from './detect/combined-ca.mjs';
import { detectOS, detectShell, powerShellExecutable } from './detect/os.mjs';
import { isWsl } from './detect/wsl.mjs';
import { detectAll, detectCopilotHud, detectRtk } from './detect/tools.mjs';
import { which } from './detect/which.mjs';
import { detectCorporateProxy, detectCaBundles, buildCorporateSslEnv } from './detect/proxy.mjs';
import { isPortFree, findFreePort } from './detect/port.mjs';
import { loadConfig, DEFAULT_CONFIG_PATH } from './config/reader.mjs';
import { resolveMitmCompression } from './config/compression-env.mjs';
import { writeConfig } from './config/writer.mjs';
import { DEFAULT_CONFIG, mergeDeep } from './config/schema.mjs';
import { buildEngineInstancePlan, buildServiceEnginePlan, selectedEnginePort, isCompressionDisabled } from './config/engine-runtime.mjs';
import { applyDisableSerenaDashboardAutoOpen } from './service/serena-config.mjs';
import {
  installTokenOptimizerForCopilot,
  hardenCopilotTokenOptimizerHook,
  tokenOptimizerClaudeCodeInstructions,
  tokenOptimizerLicenseNotice,
} from './service/token-optimizer.mjs';
import { renderManagedBlock } from './config/instruction-snippets.mjs';
import { writeManagedSection } from './config/managed-section.mjs';
import { ensureUv } from './tools/uv.mjs';
import { HEADROOM_AI_SPEC, installHeadroom, waitForHeadroom, headroomBinPath } from './tools/headroom.mjs';
import { installRtk, getRtkVersionWarning, runRtkInit, ensureSafeRtkCopilotHook } from './tools/rtk.mjs';
import {
  installService,
  installMitmService,
  installEngineInstance,
  removeEngineInstance,
  removeMitmService,
} from './service/index.mjs';
import { linkGlobalBin } from './service/npmlink.mjs';
import {
  defaultWindowsHome,
  normalizeWindowsFilesystemPath,
  resolveWindowsServiceExecutable,
  setUserEnvVars,
} from './service/windows.mjs';
import { buildCopilotWrapper, buildClaudeWrapper } from './service/wrappers.mjs';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync, spawn } from 'node:child_process';
import { readCurrentRelease, runtimePaths } from './runtime/release-store.mjs';
import { stageMainRuntime } from './runtime/stage-main.mjs';
import { managedPaths, joinManaged, isManagedRootRelocated, resolveMyelinRoot } from './shared/myelin-paths.mjs';
import { posixSingleQuote, powershellSingleQuote } from './shared/shell-quote.mjs';
import { updatePaths, createUpdateLock, resolveStoragePlatform } from './update/update-orchestrator.mjs';
import {
  resolveManagedCompressionBinary,
  resolveManagedMitmBinary,
} from './update/managed-service-binary.mjs';
import { selectedBackend } from './update/engine-selection.mjs';
import { stageComponent } from './update/component-installers.mjs';
import { activateComponent } from './update/version-store.mjs';
import { COMPONENTS } from './update/component-manifest.mjs';

// helpers
const ok   = m => console.log(`  \u2713 ${m}`);
const skip = m => console.log(`  \u00b7 ${m}`);
const warn = m => console.warn(`  \u26a0 ${m}`);
const step = m => console.log(`\n${m}`);

function backup(path) {
  if (existsSync(path)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    copyFileSync(path, `${path}.bak.${ts}`);
  }
}

function mergeDeepPlain(base, override) {
  if (typeof base !== 'object' || base === null) return override;
  if (typeof override !== 'object' || override === null) return override;
  const r = { ...base };
  for (const k of Object.keys(override)) {
    r[k] = (typeof override[k] === 'object' && !Array.isArray(override[k]) && override[k] !== null)
      ? mergeDeepPlain(base[k] ?? {}, override[k]) : override[k];
  }
  return r;
}

function mergeJsonFile(path, updates, createIfMissing = {}) {
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : createIfMissing;
  backup(path);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(mergeDeepPlain(current, updates), null, 2), 'utf8');
}

export function shouldInstallPythonHeadroomPackage({ cfg = {}, flags = {} } = {}) {
  if (flags['no-headroom']) return false;
  return buildServiceEnginePlan(cfg).selectedEngine === 'headroom';
}

/**
 * Create the managed Python venv via `uv` using an execFileSync ARGUMENT ARRAY
 * so the venv path — which is MYELIN_DIR-derived (arbitrary user text) — is
 * handed to `uv` as ONE literal argv element and never composed into a shell
 * string. A relocated root containing `"`, `$(...)`, backticks, or `'` therefore
 * cannot break out into command execution. The venv is only (re)created when its
 * `pyvenv.cfg` is missing.
 */
export function ensureManagedVenv(venv, {
  execFileSyncImpl = execFileSync,
  existsSyncImpl = existsSync,
  stdio = 'pipe',
} = {}) {
  const venvArg = String(venv);
  if (!existsSyncImpl(join(venvArg, 'pyvenv.cfg'))) {
    execFileSyncImpl('uv', ['venv', venvArg], { stdio });
  }
}

/**
 * Install a pip package spec INTO the managed venv via `uv pip install --python
 * <venv> <spec>`, again as an execFileSync argument array. Both the venv path
 * and the (fixed) package spec are literal argv elements — no shell parses
 * `[extras]`, `>=`, or any metacharacter in a relocated venv path.
 */
export function installPipPackageInManagedVenv(venv, spec, {
  execFileSyncImpl = execFileSync,
  stdio = 'inherit',
} = {}) {
  execFileSyncImpl('uv', ['pip', 'install', '--python', String(venv), String(spec)], { stdio });
}

/**
 * Resolves the proxy port written into Claude/shell/wrapper env config.
 *
 * A running primary engine instance owns the port. When there is none AND the
 * backend is `disabled` there is no proxy service at all — return `null` so
 * callers OMIT/UNSET ANTHROPIC_BASE_URL + HEADROOM_PORT and let Claude run
 * unproxied, rather than inventing a NOMINAL port that points at a service that
 * isn't running. For a non-disabled backend with no resolved primary instance
 * (e.g. mid-install), fall back to the service plan's canonical port so the
 * emitted env stays a real integer.
 */
export function resolveProxyEnvPort(cfg = {}, primaryInstance = null) {
  if (primaryInstance?.port != null) return primaryInstance.port;
  if (isCompressionDisabled(cfg)) return null;
  return buildServiceEnginePlan(cfg).selectedPort;
}

/**
 * Builds the ANTHROPIC_BASE_URL + HEADROOM_PORT fragment for ~/.claude/settings.json.
 * When `selectedProxyPort` is null (backend disabled, no proxy), both keys are
 * emitted as `undefined` so mergeJsonFile actively STRIPS any stale value —
 * Claude then runs unproxied instead of pointing at a nonexistent port.
 */
export function resolveClaudeProxyEnv(selectedProxyPort) {
  if (selectedProxyPort == null) {
    return { ANTHROPIC_BASE_URL: undefined, HEADROOM_PORT: undefined };
  }
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${selectedProxyPort}`,
    HEADROOM_PORT: String(selectedProxyPort),
  };
}

function isVersionAtLeast(version, minimum) {
  const parse = (v) => v.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const a = parse(version ?? '0.0.0');
  const b = parse(minimum);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

export function buildManagedHeadroomRunKeyCleanupCommand({ powershellExe = powerShellExecutable() } = {}) {
  return `${powershellExe} -NoProfile -Command "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'MyelinHeadroom' -ErrorAction SilentlyContinue"`;
}

export async function removeManagedHeadroomRegistration({
  os,
  winManager,
  home,
  headroomPort = 8787,
  warnFn = warn,
  okFn = ok,
  execSyncImpl = execSync,
  powershellExe = powerShellExecutable(),
  stopManagedHeadroomProcessImpl,
} = {}) {
  if (os === 'darwin') {
    try {
      const { plistPath } = await import('./service/launchd.mjs');
      const uid = process.getuid?.() ?? execSync('id -u').toString().trim();
      try { execSync(`launchctl bootout gui/${uid}/com.myelin.headroom`, { stdio: 'ignore' }); } catch {}
      const path = plistPath();
      if (existsSync(path)) unlinkSync(path);
      okFn('obsolete headroom launchd service removed');
    } catch (e) {
      warnFn(`obsolete headroom cleanup failed: ${e.message}`);
    }
    return;
  }

  if (os === 'linux') {
    try {
      const { unitPath } = await import('./service/systemd.mjs');
      try { execSync('systemctl --user disable --now myelin-headroom.service', { stdio: 'pipe' }); } catch {}
      const path = unitPath();
      if (existsSync(path)) unlinkSync(path);
      try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }); } catch {}
      okFn('obsolete headroom systemd service removed');
    } catch (e) {
      warnFn(`obsolete headroom cleanup failed: ${e.message}`);
    }
    return;
  }

  if (winManager === 'winsw') {
    try {
      const { HEADROOM_SERVICE_ID, uninstallWinswService } = await import('./service/windows.mjs');
      uninstallWinswService({ id: HEADROOM_SERVICE_ID });
      okFn('obsolete headroom WinSW service removed');
    } catch (e) {
      warnFn(`obsolete headroom cleanup failed: ${e.message}`);
    }
    return;
  }

  try {
    try {
      const stopManagedHeadroomProcess = stopManagedHeadroomProcessImpl
        ?? (await import('./service/windows.mjs')).stopManagedHeadroomProcess;
      stopManagedHeadroomProcess({ port: headroomPort, home, execSyncImpl, powershellExe });
    } catch {}
    execSyncImpl(buildManagedHeadroomRunKeyCleanupCommand({ powershellExe }), { stdio: 'pipe' });
    okFn('obsolete headroom Run key removed');
  } catch (e) {
    warnFn(`obsolete headroom cleanup failed: ${e.message}`);
  }
}

export async function managedHeadroomRegistrationStatus({ os, winManager, home, headroomPort = 8787, env = process.env, runKeyStatusImpl } = {}) {
  if (os === 'darwin') {
    const { plistPath } = await import('./service/launchd.mjs');
    return { registered: existsSync(plistPath()) };
  }

  if (os === 'linux') {
    const { unitPath } = await import('./service/systemd.mjs');
    return { registered: existsSync(unitPath()) };
  }

  if (winManager === 'winsw') {
    const { HEADROOM_SERVICE_ID, winswServiceStatus } = await import('./service/windows.mjs');
    const status = winswServiceStatus({ id: HEADROOM_SERVICE_ID, home });
    return {
      registered: status.state !== 'Missing' && status.state !== 'NonExistent',
      status,
    };
  }

  const { headroomRunKeyStatus, isLegacyManagedHeadroomRunKeyValue, launcherOwnedByManagedRoot } = await import('./service/windows.mjs');
  const status = (runKeyStatusImpl ?? headroomRunKeyStatus)();
  const legacy = isLegacyManagedHeadroomRunKeyValue({ port: headroomPort, runKeyValue: status.raw });
  // A Run key is only "registered" if its launcher belongs to the CURRENT
  // managed root. A stale key from an earlier default ~/.myelin (or a different
  // relocated root) must be re-registered, never trusted.
  const ownsCurrentRoot = status.registered && !legacy
    ? launcherOwnedByManagedRoot({ runKeyValue: status.raw, home, env })
    : false;
  return {
    ...status,
    registered: status.registered && !legacy && ownsCurrentRoot,
    needsMigration: legacy,
    foreignRoot: status.registered && !legacy && !ownsCurrentRoot,
  };
}

/**
 * Pure detection + decision for the one-time relocation migration: when the user
 * relocates the managed root via MYELIN_DIR but the default `<home>/.myelin`
 * still holds the managed state (releases/current.json/config) and the relocated
 * root does not yet exist, that state should be migrated so the relocated install
 * keeps its release history and config. This helper makes NO filesystem changes;
 * it only reports whether a migration is warranted and which sources to move.
 *
 * @returns {{ relocated: boolean, shouldMigrate: boolean, from: string, to: string,
 *   sources: string[], reason: string }}
 */
export function planManagedRelocationMigration({
  home,
  env = process.env,
  platform = detectOS(),
  existsSyncImpl = existsSync,
} = {}) {
  const relocatedRoot = resolveMyelinRoot({ home, env, platform });
  const defaultRoot = resolveMyelinRoot({ home, env: {}, platform });
  const stripTrailing = (p) => String(p).replace(/[\\/]+$/u, '');
  const sameAsDefault =
    stripTrailing(relocatedRoot).toLowerCase() === stripTrailing(defaultRoot).toLowerCase();

  if (!isManagedRootRelocated({ home, env, platform }) || sameAsDefault) {
    return { relocated: false, shouldMigrate: false, from: defaultRoot, to: relocatedRoot, sources: [], reason: 'not-relocated' };
  }

  const defaultExists = existsSyncImpl(defaultRoot);
  const relocatedExists = existsSyncImpl(relocatedRoot);
  // Migrate only when the default install still holds state AND the relocated
  // root is empty/absent — otherwise there is nothing to move (relocated root
  // already populated) or nothing to move from (no default state).
  const shouldMigrate = defaultExists && !relocatedExists;
  const sources = shouldMigrate
    ? ['releases', 'current.json', 'config.yaml'].map((name) => joinManaged(defaultRoot, name))
    : [];
  const reason = shouldMigrate
    ? 'migrate-default-to-relocated'
    : (relocatedExists ? 'relocated-root-populated' : 'no-default-state');
  return { relocated: true, shouldMigrate, from: defaultRoot, to: relocatedRoot, sources, reason };
}

export async function ensureManagedHeadroomService({
  os = detectOS(),
  winManager = 'registry',
  home,
  headroomBin,
  port,
  envVars = {},
  interceptToolResults,
  logFn = console.log,
  okFn = ok,
  warnFn = warn,
  installServiceImpl = installService,
  waitForHeadroomImpl = waitForHeadroom,
  registrationStatusImpl = managedHeadroomRegistrationStatus,
  stopHealthyProcessImpl = stopHealthyProcessForManagedInstall,
} = {}) {
  const registration = await registrationStatusImpl({ os, winManager, home, headroomPort: port });
  const alreadyHealthy = await waitForHeadroomImpl(port, 1500).catch(() => false);
  const shouldInstall = !alreadyHealthy || !registration?.registered;

  if (shouldInstall) {
    if (alreadyHealthy && !registration?.registered) {
      if (os === 'windows' && !registration?.needsMigration) {
        const reason = `unmanaged Headroom process is already healthy on :${port}; leaving it untouched`;
        warnFn(`  ⚠ ${reason}`);
        return {
          installed: false,
          alreadyHealthy: true,
          registeredBefore: false,
          healthy: true,
          conflict: true,
          reason,
        };
      }
      await stopHealthyProcessImpl({ os, winManager, home, port, headroomBin });
    }
    await installServiceImpl({
      headroomBin,
      port,
      envVars,
      home,
      interceptToolResults,
      logPath: joinManaged(managedPaths({ home, platform: os }).root, 'headroom.log'),
      manager: winManager,
    });
    okFn(`service registered (port ${port})`);
    logFn('  Waiting for proxy...');
    const healthy = await waitForHeadroomImpl(port, os === 'windows' ? 15000 : 10000);
    healthy ? okFn(`proxy healthy on :${port}`) : warnFn('no response — run: myelin diagnose');
    return { installed: true, alreadyHealthy, registeredBefore: !!registration?.registered, healthy };
  }

  okFn(`service registered (port ${port})`);
  okFn(`proxy healthy on :${port}`);
  return { installed: false, alreadyHealthy: true, registeredBefore: true, healthy: true };
}

function cleanupPort(engine, role, cfg = {}) {
  const rawPort = role === 'primary'
    ? (engine === 'headroom_lite'
      ? cfg?.proxy?.headroom_lite?.port ?? 8790
      : cfg?.proxy?.headroom?.port ?? 8787)
    : cfg?.proxy?.copilot_headroom?.port ?? 8788;
  const port = typeof rawPort === 'string' ? Number(rawPort) : rawPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function ownedEngineRoleInstance(engine, role, home = homedir(), cfg = {}) {
  const id = `${engine}-${role}`;
  const port = cleanupPort(engine, role, cfg);
  if (port == null) return null;
  const root = managedPaths({ home }).root;
  return {
    engine,
    role,
    id,
    port,
    stateDir: joinManaged(root, 'state', id),
    logPath: joinManaged(root, `${id}.log`),
    healthUrl: `http://127.0.0.1:${port}/health`,
  };
}

function legacyWindowsEngineRoleInstance(role, home = homedir(), cfg = {}, defaultWindowsHomeImpl = defaultWindowsHome) {
  const port = cleanupPort('headroom', role, cfg);
  if (port == null) return null;
  const winHome = defaultWindowsHomeImpl(home);
  const root = managedPaths({ home: winHome, platform: 'windows' }).root;
  const id = `headroom-${role}`;
  const stateDir = role === 'primary'
    ? joinManaged(root, 'services', 'myelin-headroom')
    : joinManaged(root, 'copilot-headroom');
  return {
    engine: 'headroom',
    role,
    id,
    legacy: true,
    port,
    stateDir,
    logPath: joinManaged(root, `${id}.log`),
    healthUrl: `http://127.0.0.1:${port}/health`,
  };
}

export async function removeObsoleteOwnedInstances({
  selectedEngine,
  cfg = {},
  winManager,
  home,
  warn: warnFn,
  removeEngineInstanceImpl = removeEngineInstance,
} = {}) {
  const obsoleteEngine = selectedEngine === 'headroom' ? 'headroom_lite' : 'headroom';
  for (const role of ['primary', 'copilot']) {
    const instance = ownedEngineRoleInstance(obsoleteEngine, role, home, cfg);
    if (!instance) {
      warnFn?.(`  ⚠ skipped ${obsoleteEngine}-${role} cleanup: configured port is invalid`);
      continue;
    }
    await removeEngineInstanceImpl(instance, {
      manager: winManager,
      home,
      warn: warnFn,
      includeLegacy: false,
    });
  }

}

async function removeSelectedLegacyWindowsInstances({
  os,
  cfg = {},
  home,
  warn: warnFn,
  removeEngineInstanceImpl = removeEngineInstance,
  defaultWindowsHomeImpl = defaultWindowsHome,
} = {}) {
  if (os !== 'windows') return false;
  for (const role of ['primary', 'copilot']) {
    const instance = legacyWindowsEngineRoleInstance(role, home, cfg, defaultWindowsHomeImpl);
    if (!instance) {
      warnFn?.(`  ⚠ skipped legacy ${role} cleanup: configured port is invalid`);
      continue;
    }
    // The selected manager can differ from the manager that created a legacy
    // registration, so verify and remove each legacy registration type first.
    for (const manager of ['registry', 'winsw']) {
      await removeEngineInstanceImpl(instance, {
        manager,
        home,
        warn: warnFn,
        includeLegacy: false,
      });
    }
  }
  return true;
}

async function removeSelectedAlternateManagerInstances({
  os,
  plan,
  winManager,
  home,
  warn: warnFn,
  removeEngineInstanceImpl = removeEngineInstance,
} = {}) {
  if (os !== 'windows') return false;
  const alternateManager = winManager === 'winsw' ? 'registry' : 'winsw';
  for (const instance of plan.instances ?? []) {
    await removeEngineInstanceImpl(instance, {
      manager: alternateManager,
      home,
      warn: warnFn,
      includeLegacy: false,
    });
  }
  return true;
}

async function removeDisabledOwnedCopilotInstance({
  plan,
  cfg = {},
  winManager,
  home,
  warn: warnFn,
  removeEngineInstanceImpl = removeEngineInstance,
} = {}) {
  if (plan.instances.some((instance) => instance.role === 'copilot')) return false;
  const instance = ownedEngineRoleInstance(plan.engine, 'copilot', home, cfg);
  if (!instance) {
    warnFn?.(`  ⚠ skipped ${plan.engine}-copilot cleanup: configured port is invalid`);
    return false;
  }
  await removeEngineInstanceImpl(instance, {
    manager: winManager,
    home,
    warn: warnFn,
    includeLegacy: false,
  });
  return true;
}

function engineInstanceServiceEnv(instance, envVars = {}) {
  if (instance.role !== 'primary') return {};
  if (instance.engine === 'headroom') return envVars;
  const {
    HEADROOM_PORT: _headroomPort,
    ANTHROPIC_TARGET_API_URL: _anthropicTarget,
    OPENAI_TARGET_API_URL: _openaiTarget,
    HEADROOM_MODE: _headroomMode,
    ...connectionEnv
  } = envVars;
  return connectionEnv;
}

/**
 * Cross-validates a staged `--update-apply` request against the environment the
 * update orchestrator exported, then asserts the transaction's update lock is
 * held. This fences an ordinary install from masquerading as a staged apply and
 * ensures no staged mutation proceeds without the orchestrator's live lock.
 * Returns the validated nested token on success; throws otherwise.
 */
export function assertStagedApplyAuthorization({
  flags,
  env = process.env,
  configPath,
  lockPath,
  createLock = createUpdateLock,
} = {}) {
  const nestedToken = flags?.['update-token'];
  const stagedRelease = flags?.['staged-release'];
  if (
    typeof nestedToken !== 'string'
    || nestedToken.length === 0
    || nestedToken !== env.MYELIN_UPDATE_TRANSACTION_TOKEN
    || typeof stagedRelease !== 'string'
    || resolve(stagedRelease) !== resolve(env.MYELIN_UPDATE_STAGED_RELEASE ?? '')
    || configPath !== env.MYELIN_UPDATE_CONFIG_PATH
  ) {
    throw new Error('Invalid staged update apply request.');
  }
  createLock({ useWorkerHeartbeat: false }).assertHeld({ token: nestedToken }, lockPath);
  return nestedToken;
}

/**
 * Builds the mutation fence used before every install side effect. Under a
 * staged apply it re-asserts the orchestrator's nested lock; for an ordinary
 * install it re-asserts the global install lock acquired at startup. A missing
 * lock is a hard failure so no install can mutate global state unguarded.
 */
export function createInstallMutationFence({
  nestedToken = null,
  installGlobalLock = null,
  lockPath,
  createLock = createUpdateLock,
} = {}) {
  return () => {
    if (nestedToken) {
      createLock({ useWorkerHeartbeat: false }).assertHeld({ token: nestedToken }, lockPath);
      return;
    }
    if (installGlobalLock) {
      installGlobalLock.lock.assertHeld(installGlobalLock.token, lockPath);
      return;
    }
    throw new Error('Install mutation fence requires a held global update lock.');
  };
}

/**
 * Resolves the platform used for managed-component storage lookups (pointer
 * files, staged version directories) — distinct from the Windows *service*
 * target platform. Under WSL, `os` is 'windows' (a native Windows service is
 * registered) but managed components are npm/uv-installed and staged on the
 * Linux/WSL side, so their storage must resolve through `resolveStoragePlatform`
 * rather than the raw service-target `os` (finding 4: WSL staged-apply
 * platform mismatch — passing `os` directly makes lookups search for
 * never-staged `.cmd`/`.exe` layouts).
 */
export function resolveInstallComponentStoragePlatform(os, { isWslImpl = isWsl } = {}) {
  const wsl = os === 'windows' && isWslImpl();
  return resolveStoragePlatform(os, { wsl });
}

/**
 * Resolves the pinned managed compression binary to bind during a staged apply.
 * When compression is disabled (`proxy.compression.enabled === false`), no
 * compression binary is resolved or staged — a disabled proxy update must never
 * provision a compression backend. Returns null outside of a staged apply.
 */
export function resolveStagedCompressionBinary({
  updateApply,
  cfg = {},
  componentsRoot,
  platform,
  resolveBinary = resolveManagedCompressionBinary,
} = {}) {
  if (!updateApply) return null;
  const backend = selectedBackend(cfg);
  if (backend === 'disabled') return null;
  return resolveBinary({ backend, componentsRoot, platform })?.binPath ?? null;
}

/**
 * Provisions (stages + activates) the pinned managed `headroom-lite` component
 * so a fresh `myelin install` with Lite selected never requires a pre-existing
 * global `headroom-lite` binary (finding 2). Storage always targets
 * `resolveInstallComponentStoragePlatform` so the same fix also holds for WSL
 * (finding 4).
 */
export async function provisionManagedCompressionComponent({
  home,
  os,
  isWslImpl = isWsl,
  stageComponentImpl = stageComponent,
  activateComponentImpl = activateComponent,
  resolveManagedCompressionBinaryImpl = resolveManagedCompressionBinary,
  componentsImpl = COMPONENTS,
} = {}) {
  const storagePlatform = resolveInstallComponentStoragePlatform(os, { isWslImpl });
  const componentsRoot = updatePaths(home).componentsRoot;
  const component = componentsImpl.headroomLite;
  try {
    try {
      await stageComponentImpl({
        name: 'headroomLite',
        component,
        root: componentsRoot,
        platform: storagePlatform,
      });
    } catch (e) {
      // A completed immutable stage already exists — re-staging is unnecessary.
      // Proceed directly to activation so the installer is idempotent on re-run.
      if (e?.code !== 'ERR_COMPONENT_IMMUTABLE_STAGE_EXISTS') throw e;
    }
    await activateComponentImpl({
      root: componentsRoot,
      name: 'headroomLite',
      version: component.version,
      platform: storagePlatform,
    });
  } catch (e) {
    throw new Error(`Failed to provision headroom-lite: ${e.message}`);
  }
  return resolveManagedCompressionBinaryImpl({
    backend: 'headroom-lite',
    componentsRoot,
    platform: storagePlatform,
  })?.binPath ?? null;
}

export async function applyServiceEngineInstallPlan({
  enginePlan,
  cfg = {},
  os,
  winManager = cfg?.proxy?.windows_service?.manager ?? 'registry',
  home,
  headroomBin,
  envVars = {},
  warnFn = warn,
  installEngineInstanceImpl = installEngineInstance,
  removeEngineInstanceImpl = removeEngineInstance,
  detectToolImpl,
  isWslImpl = isWsl,
  defaultWindowsHomeImpl = defaultWindowsHome,
  resolveWindowsServiceExecutableImpl = resolveWindowsServiceExecutable,
  managedCompressionBin = null,
  skipObsoleteCleanup = false,
  provisionManagedCompressionImpl = provisionManagedCompressionComponent,
} = {}) {
  const wsl = os === 'windows' && isWslImpl();
  const serviceHome = os === 'windows' ? defaultWindowsHomeImpl(home) : home;
  const resolvedPlan = enginePlan ?? buildEngineInstancePlan(cfg, {
    home: serviceHome,
    os,
    defaultWindowsHomeImpl,
  });

  // Canonical `compression.backend: disabled` (surfaced as plan engine
  // 'disabled' by buildEngineInstancePlan) must never register an engine
  // service. Tear down any owned engine registrations (both engines, both
  // roles) and install nothing.
  if (resolvedPlan.engine === 'disabled') {
    if (!skipObsoleteCleanup) {
      for (const engine of ['headroom', 'headroom_lite']) {
        for (const role of ['primary', 'copilot']) {
          const instance = ownedEngineRoleInstance(engine, role, home, cfg);
          if (!instance) continue;
          await removeEngineInstanceImpl(instance, {
            manager: winManager,
            home,
            warn: warnFn,
            includeLegacy: false,
          });
        }
      }
    }
    const servicePlan = buildServiceEnginePlan(cfg);
    return {
      enginePlan: {
        ...servicePlan,
        engine: 'disabled',
        instances: [],
        selectedEngine: 'disabled',
      },
      persistHeadroomFallback: false,
      selectedInstallEngine: 'disabled',
      // No engine service runs: there is no proxy port. null signals callers to
      // omit/unset ANTHROPIC_BASE_URL + HEADROOM_PORT (run Claude unproxied).
      selectedProxyPort: null,
    };
  }
  const primary = resolvedPlan.instances?.find(({ role }) => role === 'primary');
  if (!primary) throw new Error('Engine instance plan must include a primary descriptor');

  const platformOptions = { manager: winManager, home, envVars };
  if (resolvedPlan.engine === 'headroom') {
    platformOptions.headroomBin = resolveWindowsServiceExecutableImpl({
      engine: resolvedPlan.engine,
      candidate: managedCompressionBin ?? headroomBin,
      serviceHome,
      servicePlatform: os,
      wsl,
    });
  } else if (resolvedPlan.engine === 'headroom_lite') {
    // Staged apply threads a pinned managed binary; otherwise fall back to a
    // legacy globally-installed headroom-lite; and if neither exists (a fresh
    // install with Lite selected) provision the pinned managed component
    // before ever registering its service — a fresh install must never
    // require a pre-existing global binary (finding 2).
    let liteCandidate = managedCompressionBin;
    if (!liteCandidate) {
      const detectTool = detectToolImpl ?? (await import('./detect/tools.mjs')).detectTool;
      const headroomLite = await detectTool('headroom-lite', '--version');
      if (headroomLite.installed && headroomLite.path) {
        liteCandidate = headroomLite.path;
      } else {
        liteCandidate = await provisionManagedCompressionImpl({ home, os, isWslImpl });
      }
    }
    platformOptions.headroomLiteBin = resolveWindowsServiceExecutableImpl({
      engine: resolvedPlan.engine,
      candidate: liteCandidate,
      serviceHome,
      servicePlatform: os,
      wsl,
    });
  } else {
    throw new Error(`Unsupported engine: ${resolvedPlan.engine}`);
  }

  // Staged apply must never remove or mutate globally-owned service instances;
  // obsolete-instance cleanup is suppressed while a release transaction applies.
  if (!skipObsoleteCleanup) {
    await removeSelectedLegacyWindowsInstances({
      os,
      cfg,
      home,
      warn: warnFn,
      removeEngineInstanceImpl,
      defaultWindowsHomeImpl,
    });
    await removeSelectedAlternateManagerInstances({
      os,
      plan: resolvedPlan,
      winManager,
      home,
      warn: warnFn,
      removeEngineInstanceImpl,
    });
    await removeObsoleteOwnedInstances({
      selectedEngine: resolvedPlan.engine,
      cfg,
      winManager,
      home,
      warn: warnFn,
      removeEngineInstanceImpl,
    });
    await removeDisabledOwnedCopilotInstance({
      plan: resolvedPlan,
      cfg,
      winManager,
      home,
      warn: warnFn,
      removeEngineInstanceImpl,
    });
  }

  for (const instance of resolvedPlan.instances) {
    await installEngineInstanceImpl(instance, {
      ...platformOptions,
      envVars: engineInstanceServiceEnv(instance, envVars),
    });
  }

  const servicePlan = buildServiceEnginePlan(cfg);
  return {
    enginePlan: {
      ...servicePlan,
      engine: resolvedPlan.engine,
      instances: resolvedPlan.instances,
      selectedEngine: resolvedPlan.engine,
      selectedPort: primary.port,
    },
    persistHeadroomFallback: false,
    selectedInstallEngine: resolvedPlan.engine,
    selectedProxyPort: primary.port,
  };
}

/**
 * Build the argument-array exec that stops ONLY a managed-root Headroom process
 * listening on `port`. The MYELIN_DIR-derived `headroomBin` and the `port` are
 * passed to `bash` as POSITIONAL PARAMETERS ($1/$2), never string-interpolated
 * into the script, so a `$(...)`/backtick/quote/space in the relocated binary
 * path is treated as literal data and can never be shell-executed. The `case`
 * quotes `"$bin"` so glob metacharacters in the path match literally too.
 */
export function buildHeadroomStopExec({ port, headroomBin }) {
  const script =
    'bin="$1"; port="$2"; ' +
    'pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null); ' +
    'for pid in $pids; do ' +
    'cmd=$(ps -p "$pid" -o command=); ' +
    'case "$cmd" in *"$bin"*"proxy --port $port"*) kill -9 "$pid" ;; esac; ' +
    'done';
  return { file: '/bin/bash', args: ['-c', script, 'myelin-headroom-stop', String(headroomBin), String(port)] };
}

async function stopHealthyProcessForManagedInstall({ os, home, port, headroomBin, execFileSyncImpl = execFileSync }) {
  if (os === 'windows') {
    try {
      const { stopManagedHeadroomProcess } = await import('./service/windows.mjs');
      stopManagedHeadroomProcess({ port, home });
    } catch {}
    return;
  }

  try {
    const { file, args } = buildHeadroomStopExec({ port, headroomBin });
    execFileSyncImpl(file, args, { stdio: 'pipe' });
  } catch {}
}

async function detectHeadroomFork() {
  // Kept for detecting already-installed local dev builds — uses them as-is, doesn't prefer them
  const candidates = [
    join(homedir(), 'Work', 'headroom', '.venv13', 'bin', 'headroom'),
    join(homedir(), 'Work', 'headroom', '.venv', 'bin', 'headroom'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, source: 'local-dev' };
  }
  return null;
}

function shellProfilePath(os, shell) {
  if (os === 'windows') {
    // Documents\WindowsPowerShell is Controlled Folder Access protected on many corp machines.
    // Use APPDATA instead and dot-source it from the real $PROFILE.
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Microsoft', 'Windows', 'PowerShell', 'v1.0', 'profile.ps1');
  }
  if (shell.includes('zsh'))  return join(homedir(), '.zshrc');
  if (shell.includes('bash')) return join(homedir(), '.bashrc');
  if (shell.includes('fish')) return join(homedir(), '.config', 'fish', 'config.fish');
  return join(homedir(), '.profile');
}

/**
 * Make `myelin`/`_copilot` auto-load in every new PowerShell window without ever
 * touching $PROFILE. PowerShell's real profile files always live under
 * Documents\WindowsPowerShell(\...), which Windows Defender's Controlled Folder
 * Access blocks on many corp machines — confirmed live: icacls shows full NTFS
 * control for the user, yet New-Item/Add-Content into that folder silently fail
 * with no thrown error (so a naive execSync-based approach reports false success).
 *
 * Instead, this drops a small PowerShell module under %APPDATA% (not CFA-protected)
 * that dot-sources the managed profile content, and persists that module's parent
 * directory on the user's PSModulePath via the registry (an env var write, not a
 * filesystem write, so CFA doesn't apply). PowerShell auto-imports a module the
 * first time an unrecognized command name it exports is typed, so `myelin` and
 * `_copilot` work in any new session with zero Documents access required.
 */
function installWindowsAutoloadModule(appData, profilePath) {
  const moduleDir = join(appData, 'Microsoft', 'Windows', 'PowerShell', 'Modules', 'MyelinAutoload');
  mkdirSync(moduleDir, { recursive: true });
  const psm1 = join(moduleDir, 'MyelinAutoload.psm1');
  writeFileSync(psm1, `. "${profilePath}"\nExport-ModuleMember -Function myelin, _copilot, _claude\n`, 'utf8');
  writeFileSync(join(moduleDir, 'MyelinAutoload.psd1'),
    `@{\n  ModuleVersion = '1.0'\n  RootModule = 'MyelinAutoload.psm1'\n  FunctionsToExport = @('myelin','_copilot','_claude')\n}\n`, 'utf8');

  const modulesParent = join(appData, 'Microsoft', 'Windows', 'PowerShell', 'Modules');
  const tmp = join(tmpdir(), `myelin-psmodulepath-${Date.now()}.ps1`);
  writeFileSync(tmp, `
$existing = [Environment]::GetEnvironmentVariable('PSModulePath', 'User')
$target = '${modulesParent}'
if (-not $existing) { $existing = '' }
if ($existing -notlike "*$target*") {
  $new = if ($existing) { "$target;$existing" } else { $target }
  [Environment]::SetEnvironmentVariable('PSModulePath', $new, 'User')
}
`, 'utf8');
  try {
    execSync(`powershell -ExecutionPolicy Bypass -File "${tmp}"`, { stdio: 'pipe' });
    return existsSync(psm1);
  } catch {
    return false;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

function printStateTable(tools, caBundles, proxy) {
  console.log('\nCurrent State\n' + '─'.repeat(60));
  for (const [name, r] of Object.entries(tools)) {
    const icon = r.installed ? '\u2713' : '\u2717';
    console.log(`  ${icon} ${name.padEnd(14)} ${r.installed ? r.version : 'not installed'}`);
  }
  if (caBundles.length) console.log(`  CA bundles:     ${caBundles.map(b => b.source).join(', ')}`);
  if (proxy) console.log(`  Upstream proxy: ${proxy}`);
  console.log('─'.repeat(60) + '\n');
}

/**
 * Install mitmproxy CA into all PEM bundles referenced by env vars.
 * Detects locations from NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, REQUESTS_CA_BUNDLE,
 * HEADROOM_CA_BUNDLE, GIT_SSL_CAINFO, CURL_CA_BUNDLE. Prompts user per file.
 * Creates ~/.myelin/ca-bundle.pem if none exists.
 *
 * Interactive: shows exact file path and asks Y/n for each.
 */
async function installMitmproxyCA(home, interactive = true) {
  const mitmCaPath = join(home, '.mitmproxy', 'mitmproxy-ca-cert.pem');
  if (!existsSync(mitmCaPath)) {
    skip('mitmproxy CA not found (run: mitmdump --listen-port 18899 briefly to generate)');
    return;
  }
  const mitmCert = readFileSync(mitmCaPath, 'utf8');
  const mitmMarker = 'CN=mitmproxy';

  // --- 1. Discover all CA-related paths from environment ---
  const envVars = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
                   'HEADROOM_CA_BUNDLE', 'GIT_SSL_CAINFO', 'CURL_CA_BUNDLE'];
  const discovered = new Map(); // path → { writable, isPemBundle }

  for (const v of envVars) {
    const p = process.env[v];
    if (!p || !existsSync(p) || discovered.has(p)) continue;
    // Check if it's a PEM bundle (multiple certs) vs single cert
    let content = '';
    try { content = readFileSync(p, 'utf8'); } catch { continue; }
    const certCount = (content.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    if (certCount < 1) continue; // not a PEM file at all
    const isPemBundle = certCount > 1;
    // Check writability by attempting a test write
    let writable = false;
    try { accessSync(p, 2 /* W_OK */); writable = true; } catch {}
    discovered.set(p, { writable, isPemBundle, content });
  }

  // --- 2. Always rebuild our own bundle (fresh system content + mitmproxy CA) ---
  const { root: myelinRoot, caBundlePath: ourBundle } = managedPaths({ home });
  mkdirSync(myelinRoot, { recursive: true });

  // Seed from: read-only discovered files + well-known system paths
  let sysCerts = '';
  const seedPaths = [
    ...[...discovered.entries()].filter(([, v]) => !v.writable).map(([p]) => p),
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/pki/tls/certs/ca-bundle.crt',
    '/etc/ssl/ca-bundle.pem',
    '/etc/ssl/cert.pem',
  ];
  for (const p of seedPaths) {
    if (existsSync(p)) {
      try { sysCerts += readFileSync(p, 'utf8') + '\n'; } catch {}
    }
  }
  if (!sysCerts && process.platform === 'darwin') {
    try { sysCerts = execSync('security find-certificate -a -p /Library/Keychains/SystemRootCertificates.keychain 2>/dev/null', { shell: true, stdio: 'pipe' }).toString(); } catch {}
  }
  // Corporate/MDM-installed interception CAs (e.g. NetFree) live in the
  // general System keychain and/or the user's login keychain — NOT in
  // SystemRootCertificates.keychain (Apple's built-in roots only). Must
  // always be queried (not gated behind "sysCerts is empty"), since on
  // macOS /etc/ssl/cert.pem often already exists and would otherwise skip
  // this entirely, silently omitting the one CA that actually matters for
  // TLS interception on this network. Missing it breaks any tool (pip,
  // gem, serena/semble's downloads, etc.) that does verify=<this file>
  // instead of trusting the OS keychain the way curl/Safari do.
  //
  // NOTE: `security find-certificate -a -p <keychain>` without a `-c` name
  // filter does NOT reliably enumerate every cert in the keychain on this
  // system (empirically confirmed: returns a partial subset, silently
  // missing entries that ARE found when searched by name) — so we also
  // explicitly search by the common names of known corporate TLS
  // interception products, which is the only reliable way to find them.
  if (process.platform === 'darwin') {
    const KEYCHAINS = [
      '/Library/Keychains/System.keychain',
      join(home, 'Library', 'Keychains', 'login.keychain-db'),
    ];
    const KNOWN_INTERCEPTOR_NAMES = ['NetFree', 'Zscaler', 'Blue Coat', 'Bluecoat', 'Forcepoint', 'Netskope', 'Menlo Security', 'Palo Alto', 'Cisco Umbrella'];
    for (const kc of KEYCHAINS) {
      // Best-effort full dump first (may already catch some)
      try {
        const certs = execSync(`security find-certificate -a -p "${kc}" 2>/dev/null`, { shell: true, stdio: 'pipe' }).toString();
        if (certs.trim()) sysCerts += '\n' + certs;
      } catch {}
      // Reliable targeted search for known interceptor CA names. Duplicates
      // (if the dump above already had them) are harmless in a CA bundle —
      // no need to dedup, and a naive text-prefix dedup check is unreliable
      // since unrelated certs commonly share the same leading PEM header
      // bytes, causing false-positive "already present" skips.
      for (const name of KNOWN_INTERCEPTOR_NAMES) {
        try {
          const certs = execSync(`security find-certificate -a -c "${name}" -p "${kc}" 2>/dev/null`, { shell: true, stdio: 'pipe' }).toString();
          if (certs.trim()) sysCerts += '\n' + certs;
        } catch {}
      }
    }
  }
  // Strip old mitmproxy CA entry, re-add fresh
  const withoutMitm = sysCerts.replace(/\n?# mitmproxy CA[\s\S]*?-----END CERTIFICATE-----\n?/g, '');
  writeFileSync(ourBundle,
    (withoutMitm || '') + '\n# mitmproxy CA (Myelin Copilot interception)\n' + mitmCert + '\n', 'utf8');
  ok(`ca-bundle.pem rebuilt from system CAs + mitmproxy CA`);
  discovered.set(ourBundle, { writable: true, isPemBundle: true, content: readFileSync(ourBundle, 'utf8') });

  // --- 3. For writable PEM bundles: offer to append mitmproxy CA ---
  for (const [pemPath, { writable, isPemBundle, content }] of discovered) {
    if (!writable || !isPemBundle) continue;
    if (content.includes(mitmMarker)) { skip(`${pemPath} — already trusts mitmproxy CA`); continue; }

    if (interactive) {
      const answer = await promptYN(`Add mitmproxy CA to ${pemPath}? [Y/n]: `);
      if (!answer) { skip(`${pemPath} — skipped`); continue; }
    }
    // Non-interactive (e.g. myelin update): always add mitmproxy CA automatically
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    try { copyFileSync(pemPath, `${pemPath}.bak.${ts}`); } catch {}
    writeFileSync(pemPath,
      content + '\n# mitmproxy CA (Myelin Copilot interception)\n' + mitmCert + '\n', 'utf8');
    ok(`${pemPath} — added mitmproxy CA`);
  }

  // --- 4. Report read-only bundles (inform user, suggest elevation) ---
  const readOnlyBundles = [...discovered.entries()].filter(([p, v]) => !v.writable && v.isPemBundle && p !== ourBundle);
  for (const [p] of readOnlyBundles) {
    skip(`${p} — read-only, content merged into ca-bundle.pem (to add directly: run installer as admin)`);
  }
}

// Shared readline instance — created once, reused across all prompts.
// Auto-accepts (returns true) when stdin is not a TTY or --yes flag is set.
let _rl = null;

async function promptYN(question) {
  if (!process.stdin.isTTY || process.argv.includes('--yes') || process.argv.includes('-y')) {
    process.stdout.write(question + ' [auto: Y]\n');
    return true;
  }
  if (!_rl) _rl = createRL({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    _rl.question(question, ans => {
      const a = ans.trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes');
    });
  });
}

function _closeRL() { if (_rl) { _rl.close(); _rl = null; } }

const MANAGED_MAIN_REPO_URL = 'https://github.com/yehsuf/myelin';

function resolveManagedMainRepoUrl({
  env = process.env,
  execSyncFn = execSync,
  metaUrl = import.meta.url,
} = {}) {
  if (env.MYELIN_REPO_URL) return env.MYELIN_REPO_URL;

  try {
    return String(execSyncFn('git config --get remote.origin.url', {
      cwd: fileURLToPath(new URL('..', metaUrl)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })).trim() || MANAGED_MAIN_REPO_URL;
  } catch {
    return MANAGED_MAIN_REPO_URL;
  }
}

/**
 * Build the shell line that defines the `myelin` command in the managed profile
 * block. The managed command path is MYELIN_DIR-derived and thus arbitrary text
 * (a relocated root can contain spaces, `$(...)`, backticks, `$VAR`, or quotes),
 * so it is emitted as an inert single-quoted literal:
 *   - POSIX: `alias myelin='<path>'` — the single quotes stop any expansion or
 *     command substitution when the profile is sourced or the alias is invoked.
 *   - Windows: `function global:myelin { & '<path>' @args }` — the PowerShell
 *     call operator with a single-quoted (verbatim) literal, so `$(...)`/`$var`
 *     in the path never expand when the function runs.
 */
export function managedMyelinCommandLine({ os, commandPath }) {
  return os === 'windows'
    ? `function global:myelin { & ${powershellSingleQuote(commandPath)} @args }`
    : `alias myelin=${posixSingleQuote(commandPath)}`;
}

/**
 * Build the shell-profile PATH additions, rooting the managed bin dir in the
 * managed root so a relocated MYELIN_DIR is honored. The default (MYELIN_DIR
 * unset — or set to the default `<home>/.myelin`) keeps the shell-portable
 * `$HOME`/`$env:USERPROFILE` form; only a *genuinely relocated* managed root
 * (an explicit rootDir/MYELIN_DIR resolving somewhere other than the default)
 * points the entries at the resolved managed bin dir.
 *
 * "Relocated" is decided by {@link isManagedRootRelocated} (explicit root that
 * resolves to a NON-default path), never by mere non-blankness of MYELIN_DIR —
 * `myelin update` forwards the resolved default root (resolveMyelinRoot never
 * returns blank), so treating any non-blank value as relocated would rewrite a
 * default install's portable `$HOME` PATH into a hardcoded absolute path on
 * every update, breaking synced dotfiles / home moves.
 *
 * When the root is relocated, the POSIX block additionally persists an
 * `export MYELIN_DIR=<quoted root>` (via `posixMyelinDirExport`) and the Windows
 * block a `$env:MYELIN_DIR = '<native root>'` (via `windowsMyelinDirExport`,
 * carrying the NATIVE Windows form of the root) so a freshly-sourced shell
 * resolves the same managed root the baked-in PATH points at. Values are
 * single-quoted (POSIX / PowerShell literal rules) to stay safe for paths with
 * spaces or shell metacharacters. Both exports are empty when not relocated.
 */
export function managedProfilePathBlock({ os, home = homedir(), env = process.env } = {}) {
  const relocated = isManagedRootRelocated({ home, env, platform: os });
  const managed = managedPaths({ home, env, platform: os });
  const managedBinDir = managed.binDir;
  if (os === 'windows') {
    const myelinBin = relocated
      ? normalizeWindowsFilesystemPath(managedBinDir, { rejectPosix: true })
      : '$env:USERPROFILE\\.myelin\\bin';
    return {
      posixExport: '',
      posixMyelinDirExport: '',
      windowsMyelinDirExport: relocated
        ? `$env:MYELIN_DIR = ${powershellSingleQuote(normalizeWindowsFilesystemPath(managed.root, { rejectPosix: true }))}`
        : '',
      windowsPathDirs: [
        '$env:USERPROFILE\\.local\\bin',
        myelinBin,
        '$env:APPDATA\\uv\\bin',
        '$env:LOCALAPPDATA\\uv\\bin',
        '$env:APPDATA\\npm',
      ],
    };
  }
  // A relocated managed bin dir is arbitrary user-supplied text; splice it into
  // the PATH export as a single-quoted literal (closing/reopening the outer
  // double quotes) so `$(…)`, backticks, `"`, and `$VAR` in the path can never
  // be executed or expanded when the profile is sourced. The default form keeps
  // `$HOME/.myelin/bin` unquoted so the shell still expands `$HOME`.
  const posixExport = relocated
    ? `\nexport PATH="$HOME/.local/bin:"${posixSingleQuote(managedBinDir)}":$PATH"`
    : '\nexport PATH="$HOME/.local/bin:$HOME/.myelin/bin:$PATH"';
  return {
    posixExport,
    posixMyelinDirExport: relocated
      ? `\nexport MYELIN_DIR=${posixSingleQuote(managed.root)}`
      : '',
    windowsMyelinDirExport: '',
    windowsPathDirs: [],
  };
}

/**
 * Render the PowerShell `$PROFILE` PATH-prepend lines from the
 * {@link managedProfilePathBlock} `windowsPathDirs`. Each entry is either:
 *   - a trusted `$env:`-prefixed variable reference (e.g. `$env:USERPROFILE\.local\bin`)
 *     that MUST expand — emitted inside a double-quoted PowerShell string, or
 *   - a relocated managed bin dir, which is MYELIN_DIR-derived arbitrary user
 *     text — emitted as an inert single-quoted PowerShell literal via
 *     {@link powershellSingleQuote} so `$(...)`, backticks, and `$VAR` in the
 *     path can never be executed/expanded when the profile is sourced.
 * A relocated managed path is always a drive/UNC filesystem path (never
 * `$env:`-prefixed), so the classification can never be spoofed into executing
 * a command-substitution vector.
 */
export function renderWindowsProfilePathLines(windowsPathDirs = []) {
  return windowsPathDirs
    .map((p) => {
      const expr = String(p).startsWith('$env:') ? `"${p}"` : powershellSingleQuote(p);
      return `if ($env:PATH -notlike ('*' + ${expr} + '*')) { $env:PATH = ${expr} + ';' + $env:PATH }`;
    })
    .join('\n');
}

/**
 * The Windows registry (HKCU\Environment) MYELIN_DIR entry, as a spreadable map.
 * Returns `{ MYELIN_DIR: <native Windows root> }` ONLY when the managed root is
 * genuinely relocated; a default install returns `{}` so no absolute MYELIN_DIR
 * is persisted and services fall back to `~/.myelin`. The value is the NATIVE
 * Windows form of the resolved root — a mounted `/mnt/<drive>/…` WSL path is
 * converted to `<Drive>:\…` so Explorer-spawned Windows processes (which never
 * see the WSL mount namespace) resolve the real root.
 */
export function managedRegistryMyelinDirVar({ os, home = homedir(), env = process.env } = {}) {
  if (!isManagedRootRelocated({ home, env, platform: os })) return {};
  const { root } = managedPaths({ home, env, platform: os });
  return { MYELIN_DIR: normalizeWindowsFilesystemPath(root, { rejectPosix: true }) };
}

export function resolveManagedRuntime({
  home = homedir(),
  rootDir,
  os,
  readCurrentReleaseFn = readCurrentRelease,
  runtimePathsFn = runtimePaths,
  stageMainRuntimeFn = null,
  repoUrl = MANAGED_MAIN_REPO_URL,
} = {}) {
  let currentRelease = readCurrentReleaseFn({ home, rootDir });
  if (!currentRelease?.runtimeRoot) {
    if (!stageMainRuntimeFn) {
      throw new Error('no current managed runtime configured');
    }

    stageMainRuntimeFn({ home, rootDir, repoUrl });
    currentRelease = readCurrentReleaseFn({ home, rootDir });
    if (!currentRelease?.runtimeRoot) {
      throw new Error('managed runtime bootstrap did not select a current release');
    }
  }

  const paths = runtimePathsFn({ home, rootDir });
  const binDir = joinManaged(paths.root, 'bin');
  return {
    runtimeRoot: currentRelease.runtimeRoot,
    launcherPath: paths.launcherPath,
    commandPath: joinManaged(binDir, os === 'windows' ? 'myelin.cmd' : 'myelin'),
  };
}

function runtimeBridgePaths(home, rootDir) {
  const { runtimeBridgeRoot: root } = managedPaths({ home, rootDir });
  // Extend the (possibly relocated, possibly cross-style) managed bridge root
  // in its OWN separator style via joinManaged — a host-native join would
  // splice mismatched separators onto a relocated root of the opposite style
  // (e.g. `D:\managed\runtime-bridge/src/cli/index.mjs`).
  return {
    root,
    cliPath: joinManaged(root, 'src', 'cli', 'index.mjs'),
    mitmAddonPath: joinManaged(root, 'src', 'mitm', 'copilot_addon.py'),
    gitExtraPath: joinManaged(root, 'src', 'mcp', 'git-extra.py'),
  };
}

function renderManagedCliBridgeSource() {
  return `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 as win32Path, posix as posixPath } from 'node:path';

const RELEASE_ID_RE = /^main-[0-9a-f]{7,64}$/;
const BACKSLASH = String.fromCharCode(92);

// Mirror src/shared/myelin-paths.mjs isWindowsStylePath / resolveMyelinRoot so
// this generated bridge canonicalizes an explicit MYELIN_DIR exactly like the
// installer: expand a leading ~ / ~/ / ~BACKSLASH against home, root a relative
// value at home (never cwd), pass an absolute value through, blank => default.
function isWindowsStylePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.length >= 3 && /[A-Za-z]/.test(p.charAt(0)) && p.charAt(1) === ':' && (p.charAt(2) === '/' || p.charAt(2) === BACKSLASH)) return true;
  if (p.startsWith(BACKSLASH + BACKSLASH) || p.startsWith('//')) return true;
  if (p.startsWith('/')) return false;
  return p.includes(BACKSLASH);
}

function resolveManagedRoot(home) {
  const raw = process.env.MYELIN_DIR;
  if (typeof raw !== 'string' || !raw.trim()) return join(home, '.myelin');
  const homeModule = isWindowsStylePath(home) ? win32Path : posixPath;
  if (raw === '~') return home;
  if (raw.length >= 2 && raw.charAt(0) === '~' && (raw.charAt(1) === '/' || raw.charAt(1) === BACKSLASH)) {
    return homeModule.join(home, raw.slice(2));
  }
  const rawModule = isWindowsStylePath(raw) ? win32Path : posixPath;
  if (rawModule.isAbsolute(raw)) return raw;
  return homeModule.join(home, raw);
}

function readCurrentRelease(home) {
  const root = resolveManagedRoot(home);
  const currentPointerPath = join(root, 'current.json');
  const releasesDir = join(root, 'releases');

  try {
    const parsed = JSON.parse(readFileSync(currentPointerPath, 'utf8'));
    if (
      !parsed
      || typeof parsed !== 'object'
      || parsed.version !== 1
      || typeof parsed.releaseId !== 'string'
      || !RELEASE_ID_RE.test(parsed.releaseId)
    ) {
      return null;
    }

    const runtimeRoot = join(releasesDir, parsed.releaseId);
    if (normalizedRuntimeRoot(parsed.runtimeRoot) !== normalizedRuntimeRoot(runtimeRoot)) {
      return null;
    }

    return {
      version: 1,
      releaseId: parsed.releaseId,
      runtimeRoot,
    };
  } catch {
    return null;
  }
}

function normalizedRuntimeRoot(value) {
  const raw = String(value ?? '');
  const isWindowsDriveRoot = raw.length >= 3
    && raw.charAt(1) === ':'
    && (raw.charAt(2) === '/' || raw.charAt(2) === String.fromCharCode(92))
    && /[a-z]/i.test(raw.charAt(0));
  const normalized = raw.split(String.fromCharCode(92)).join('/');
  const segments = normalized.split('/');
  const drive = segments[2] ?? '';
  if (segments[0] === '' && segments[1] === 'mnt' && drive.length === 1 && /[a-z]/i.test(drive)) {
    const rest = segments.slice(3).join('/').split('/').join(String.fromCharCode(92));
    return (drive.toUpperCase() + ':' + String.fromCharCode(92) + rest).toLowerCase();
  }
  return isWindowsDriveRoot || process.platform === 'win32'
    ? raw.split('/').join(String.fromCharCode(92)).toLowerCase()
    : raw;
}

try {
  const currentRelease = readCurrentRelease(homedir());
  if (!currentRelease?.runtimeRoot) {
    throw new Error('no current managed runtime configured');
  }

  const entrypoint = join(currentRelease.runtimeRoot, 'src', 'cli', 'index.mjs');
  if (!existsSync(entrypoint)) {
    throw new Error(\`managed runtime entrypoint missing: \${entrypoint}\`);
  }

  const child = spawnSync(process.execPath, [entrypoint, ...process.argv.slice(2)], { stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
} catch (error) {
  console.error(\`[myelin] \${error.message}\`);
  process.exit(1);
}
`;
}

function renderManagedPythonBridgeSource(relativeTargetPath, mode) {
  return `#!/usr/bin/env python3
import json
import ntpath
import os
from pathlib import Path
import posixpath
import re
import runpy
import sys

TARGET_PATH = ${JSON.stringify(relativeTargetPath)}
MODE = ${JSON.stringify(mode)}
RELEASE_ID_RE = re.compile(r'^main-[0-9a-f]{7,64}$')

def is_windows_style_path(p):
    if not isinstance(p, str) or len(p) == 0:
        return False
    if len(p) >= 3 and p[0].isascii() and p[0].isalpha() and p[1] == ':' and p[2] in ('/', chr(92)):
        return True
    if p.startswith(chr(92) + chr(92)) or p.startswith('//'):
        return True
    if p.startswith('/'):
        return False
    return chr(92) in p

# Mirror src/shared/myelin-paths.mjs resolveMyelinRoot: expand a leading
# ~ / ~/ / ~BACKSLASH against home, root a relative MYELIN_DIR at home (never
# cwd), pass an absolute value through, blank/absent => <home>/.myelin.
def resolve_managed_root(home):
    raw = os.environ.get('MYELIN_DIR')
    if not (raw and raw.strip()):
        return os.path.join(home, '.myelin')
    home_module = ntpath if is_windows_style_path(home) else posixpath
    if raw == '~':
        return home
    if len(raw) >= 2 and raw[0] == '~' and raw[1] in ('/', chr(92)):
        rest = raw[2:]
        return home if rest == '' else home_module.join(home, rest)
    raw_module = ntpath if is_windows_style_path(raw) else posixpath
    if raw_module.isabs(raw):
        return raw
    return home_module.join(home, raw)

def normalized_runtime_root(value):
    raw = str(value)
    is_windows_drive_root = len(raw) >= 3 and raw[1] == ':' and raw[2] in ('/', chr(92)) and raw[0].isalpha()
    if is_windows_drive_root:
        return raw.replace('/', chr(92)).casefold()
    normalized = raw.replace(chr(92), '/')
    parts = normalized.split('/')
    drive = parts[2] if len(parts) > 2 else ''
    if len(parts) >= 3 and parts[0] == '' and parts[1] == 'mnt' and len(drive) == 1 and drive.isalpha():
        rest = '/'.join(parts[3:]).replace('/', chr(92))
        return (drive.upper() + ':' + chr(92) + rest).casefold()
    return os.path.normcase(os.path.normpath(raw))

def resolve_target():
    root = Path(resolve_managed_root(str(Path.home())))
    current_path = root / 'current.json'
    releases_dir = root / 'releases'
    try:
        current = json.loads(current_path.read_text(encoding='utf-8'))
    except Exception as exc:
        raise RuntimeError(f'could not read {current_path}: {exc}') from exc

    release_id = current.get('releaseId')
    version = current.get('version')
    if (
        version != 1
        or not isinstance(release_id, str)
        or RELEASE_ID_RE.fullmatch(release_id) is None
    ):
        raise RuntimeError(f'invalid managed runtime pointer: {current_path}')

    runtime_root = releases_dir / release_id
    if normalized_runtime_root(current.get('runtimeRoot')) != normalized_runtime_root(runtime_root):
        raise RuntimeError(f'invalid managed runtime pointer: {current_path}')

    target = runtime_root / Path(TARGET_PATH)
    if not target.is_file():
        raise RuntimeError(f'managed runtime target missing: {target}')
    return target

try:
    target = resolve_target()
    if MODE == 'module':
        globals().update(runpy.run_path(str(target)))
    else:
        runpy.run_path(str(target), run_name='__main__')
except Exception as exc:
    print(f'[myelin] {exc}', file=sys.stderr)
    raise SystemExit(1)
`;
}

export function writeManagedRuntimeBridge({
  home = homedir(),
  rootDir,
  mkdirSyncFn = mkdirSync,
  writeFileSyncFn = writeFileSync,
} = {}) {
  const paths = runtimeBridgePaths(home, rootDir);
  mkdirSyncFn(joinManaged(paths.root, 'src', 'cli'), { recursive: true });
  mkdirSyncFn(joinManaged(paths.root, 'src', 'mitm'), { recursive: true });
  mkdirSyncFn(joinManaged(paths.root, 'src', 'mcp'), { recursive: true });
  writeFileSyncFn(paths.cliPath, renderManagedCliBridgeSource(), 'utf8');
  writeFileSyncFn(paths.mitmAddonPath, renderManagedPythonBridgeSource('src/mitm/copilot_addon.py', 'module'), 'utf8');
  writeFileSyncFn(paths.gitExtraPath, renderManagedPythonBridgeSource('src/mcp/git-extra.py', 'script'), 'utf8');
  return paths;
}

/**
 * Return the path to the Myelin mitmproxy addon script.
 * Resolves through the stable runtime bridge so updates follow current.json.
 */
export function mitmAddonPath(home) {
  return runtimeBridgePaths(home).mitmAddonPath;
}

/**
 * Install myelin Copilot skills (myelin-compact, myelin-constitution) into
 * ~/.copilot/skills/. Idempotent — safe to call on every `myelin install`.
 *
 * Each skill gets a SKILL.md and, where applicable, a companion script symlink
 * (POSIX) or copy (Windows — symlinks need developer mode or admin rights).
 *
 * @param {object} opts
 * @param {string}   opts.home                    - User home directory
 * @param {boolean}  opts.copilot                 - Whether Copilot CLI is installed
 * @param {string}   opts.repoRoot                - Absolute path to myelin repo root (trailing sep)
 * @param {string}   opts.managedRuntimeCommandPath - Absolute path to the `myelin` binary
 * @param {string}   opts.os                      - 'darwin' | 'linux' | 'windows'
 * @param {Function} [opts.mkdirSyncImpl]
 * @param {Function} [opts.writeFileSyncImpl]
 * @param {Function} [opts.symlinkSyncImpl]
 * @param {Function} [opts.copyFileSyncImpl]
 * @param {Function} [opts.unlinkSyncImpl]
 */
export function installCopilotSkills({
  home,
  copilot,
  repoRoot,
  managedRuntimeCommandPath,
  os,
  mkdirSyncImpl = mkdirSync,
  writeFileSyncImpl = writeFileSync,
  symlinkSyncImpl = symlinkSync,
  copyFileSyncImpl = copyFileSync,
  unlinkSyncImpl = unlinkSync,
} = {}) {
  if (!copilot) return;

  const skillsDir = join(home, '.copilot', 'skills');

  // ── myelin-compact ──────────────────────────────────────────────────────────
  // compact-prepare.mjs lives in the repo; the SKILL.md references it via the
  // skill directory so the path is always ~/.copilot/skills/myelin-compact/…
  // (environment-agnostic). On POSIX we symlink so repo updates are reflected
  // immediately; on Windows we copy (symlinks need developer-mode/admin).
  {
    const dir = join(skillsDir, 'myelin-compact');
    mkdirSyncImpl(dir, { recursive: true });
    writeFileSyncImpl(join(dir, 'SKILL.md'), COMPACT_SKILL_MD);
    const src = fileURLToPath(new URL('./cli/compact-prepare.mjs', import.meta.url));
    const dst = join(dir, 'compact-prepare.mjs');
    if (os === 'windows') {
      copyFileSyncImpl(src, dst);
    } else {
      try { unlinkSyncImpl(dst); } catch { /* not present yet */ }
      symlinkSyncImpl(src, dst);
    }
  }

  // ── myelin-constitution ──────────────────────────────────────────────────────
  // The SKILL.md instructs the agent to run `myelin constitution <cmd>` using
  // the managed runtime binary — never a hardcoded ~/tokenstack path.
  {
    const dir = join(skillsDir, 'myelin-constitution');
    mkdirSyncImpl(dir, { recursive: true });
    writeFileSyncImpl(join(dir, 'SKILL.md'), constitutionSkillMd(managedRuntimeCommandPath));
  }
}

/** SKILL.md content for myelin-compact (environment-independent). */
const COMPACT_SKILL_MD = `---
name: myelin-compact
description: Prepare a dense /compact hint from the current session's live state (git, todos, plan.md, config) and re-orient after /compact. Works in any repo.
argument-hint: "[prepare|resume] — prepare before /compact, resume after (post-compact)"
---

# compact — generic /compact pipeline

Generates a ready-to-paste \`/compact\` hint from live session state. No project-specific hardcoding — works in any repo.

## When to use
- Context is getting long and \`/compact\` is imminent → invoke with \`prepare\`
- Immediately after \`/compact\` completes → invoke with \`resume\`

## Instructions for the agent

Let \`$MODE\` = first token of \`$ARGUMENTS\`, default \`prepare\`. Must be \`prepare\` or \`resume\`.

### Mode: prepare

1. Export current todos to a file so the script can read them:
   \`\`\`sql
   SELECT id, title, COALESCE(description,'') AS description, status, updated_at
   FROM todos
   WHERE status IN ('in_progress','pending','blocked')
   ORDER BY CASE status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, updated_at DESC
   \`\`\`
   Write the JSON result to \`~/.copilot/session-state/$COPILOT_AGENT_SESSION_ID/files/todos.json\`.

2. Run:
   \`\`\`bash
   node ~/.copilot/skills/myelin-compact/compact-prepare.mjs prepare
   \`\`\`

3. Print the full script output verbatim.

4. **YOU (the agent) now compose the actual compact hint** using the \`<<<SESSION_STATE_BRIEF>>>\` block as source of truth. Maximum 4000 characters total.

5. Print the hint between \`>>> COMPACT HINT >>>\` and \`<<< END COMPACT HINT <<<\` sentinels.

6. Tell the user to paste it after \`/compact \` in the next message.

7. Do NOT run \`/compact\` yourself.

### Mode: resume

1. Run:
   \`\`\`bash
   node ~/.copilot/skills/myelin-compact/compact-prepare.mjs resume
   \`\`\`
2. Print the output verbatim.
3. In ≤3 lines, state the top priority.

## Error handling
- Exit 2: tell user "Run this inside an active Copilot CLI session."
- \`sqlite3\` missing: warn "todos may be incomplete — install sqlite3 for full accuracy."
`;

/** SKILL.md content for myelin-constitution (uses managed runtime path). */
function constitutionSkillMd(cliPath) {
  return `---
name: myelin-constitution
description: Loads, checks, and manages the project constitution (.github/copilot-instructions.md). Run at session start or after /compact to ensure project invariants are active.
argument-hint: "[show|check|init]"
---

# myelin-constitution

Manages the project constitution — a stable, cached \`.github/copilot-instructions.md\` file that Copilot CLI reads natively at every session start.

## When to use
- Start of a new session → run with \`show\` to confirm constitution is present and current
- After \`/compact\` → run \`show\` to confirm it's active
- When a durable decision is made → propose \`myelin constitution append <section> "<rule>"\`

## Instructions for the agent

Let \`$CMD\` = first token of \`$ARGUMENTS\`, default \`show\`.

### show
Run: \`"${cliPath}" constitution show\`
Print output. Confirm: "Constitution active: <name> sha256=<first8>…"

### check
Run: \`"${cliPath}" constitution check\`
Print output. If errors: tell user what to fix.

### init
Run: \`"${cliPath}" constitution init\`
Print output. Tell user to edit \`.github/copilot-instructions.md\` and commit it.

### append
Syntax: \`append <section> <bullet>\`
Run: \`"${cliPath}" constitution append "<section>" "<bullet>"\`
Ask user to commit the change.

## What belongs in the constitution (stable only)
✅ Architecture invariants · Standing rules · Technology stack · Key file map
❌ Blocked items · Shipped work · PR numbers · Branch names
`;
}


/**
 * Solves Copilot launching MCP servers from a generic CWD instead of the project dir.
 */
function writeSerenaWrapper(home, serenaBin) {
  const binDir = managedPaths({ home }).binDir;
  mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    const ps1 = join(binDir, 'serena-mcp.ps1');
    writeFileSync(ps1, `# Detect git root from CWD and pass to serena
$dir = (Get-Location).Path
while ($dir -ne [System.IO.Path]::GetPathRoot($dir)) {
  if (Test-Path (Join-Path $dir '.git')) { break }
  if (Test-Path (Join-Path $dir '.serena\project.yml') -or (Test-Path (Join-Path $dir '.myelin\project.yml'))) { break }
  $dir = Split-Path $dir -Parent
}
& '${serenaBin.replace(/\\/g, '\\\\')}' start-mcp-server --project $dir @args
`, 'utf8');
    const cmd = join(binDir, 'serena-mcp.cmd');
    writeFileSync(cmd, `@echo off\npowershell -ExecutionPolicy Bypass -File "${ps1}" %*\n`, 'utf8');
    return cmd;
  }
  const sh = join(binDir, 'serena-mcp');
  writeFileSync(sh, `#!/bin/sh
dir="$PWD"
while [ "$dir" != "/" ]; do
  [ -d "$dir/.git" ] && break
  [ -f "$dir/.serena/project.yml" ] && break
  [ -f "$dir/.myelin/project.yml" ] && break
  dir="$(dirname "$dir")"
done
exec "${serenaBin}" start-mcp-server --project "$dir" "$@"
`, 'utf8');
  try { chmodSync(sh, 0o755); } catch {}
  return sh;
}

/**
 * Write a codegraph MCP wrapper that re-roots the process at the repo before
 * launching `codegraph mcp`, so it finds the repo-local `.codegraph/graph.db`
 * even when the client spawns MCP servers from a generic working directory.
 */
function writeCodegraphWrapper(home, codegraphBin) {
  const binDir = managedPaths({ home }).binDir;
  mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    const ps1 = join(binDir, 'codegraph-mcp.ps1');
    writeFileSync(ps1, `# Detect git/codegraph root from CWD and launch codegraph there
$dir = (Get-Location).Path
while ($dir -ne [System.IO.Path]::GetPathRoot($dir)) {
  if (Test-Path (Join-Path $dir '.git')) { break }
  if (Test-Path (Join-Path $dir '.codegraph\\graph.db')) { break }
  if (Test-Path (Join-Path $dir '.myelin\\project.yml')) { break }
  $dir = Split-Path $dir -Parent
}
Set-Location $dir
& '${codegraphBin.replace(/\\/g, '\\\\')}' mcp @args
`, 'utf8');
    const cmd = join(binDir, 'codegraph-mcp.cmd');
    writeFileSync(cmd, `@echo off\npowershell -ExecutionPolicy Bypass -File "${ps1}" %*\n`, 'utf8');
    return cmd;
  }
  const sh = join(binDir, 'codegraph-mcp');
  writeFileSync(sh, `#!/bin/sh
dir="$PWD"
while [ "$dir" != "/" ]; do
  [ -e "$dir/.git" ] && break
  [ -f "$dir/.codegraph/graph.db" ] && break
  [ -f "$dir/.myelin/project.yml" ] && break
  dir="$(dirname "$dir")"
done
cd "$dir" || exit 1
exec "${codegraphBin}" mcp "$@"
`, 'utf8');
  try { chmodSync(sh, 0o755); } catch {}
  return sh;
}

/**
 * Detect the mitmdump binary path (cross-platform).
 * Checks existence for absolute paths, then tries running --version.
 */
export function detectMitmdump(os) {
  const candidates =
    os === 'windows'
      ? [
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Scripts', 'mitmdump.exe'),
          join(process.env.APPDATA ?? '', 'Python', 'Scripts', 'mitmdump.exe'),
          // pip install --user puts in versioned paths e.g. Python313\Scripts
          ...[...Array(8)].map((_, i) =>
            join(process.env.APPDATA ?? '', 'Python', `Python3${10 + i}`, 'Scripts', 'mitmdump.exe')
          ),
          ...[...Array(8)].map((_, i) =>
            join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', `Python3${10 + i}`, 'Scripts', 'mitmdump.exe')
          ),
          join(homedir(), '.local', 'bin', 'mitmdump.exe'),
          'mitmdump',
        ]
      : [
          '/opt/homebrew/bin/mitmdump',
          '/usr/local/bin/mitmdump',
          '/usr/bin/mitmdump',
          join(homedir(), '.local', 'bin', 'mitmdump'),
          join(homedir(), '.local', 'bin', 'mitmdump.exe'),
          'mitmdump',
        ];

  for (const c of candidates) {
    const isAbsolute = c.startsWith('/') || c.includes('\\');
    if (isAbsolute && !existsSync(c)) continue;
    // For absolute paths that exist, skip --version check — just return it
    if (isAbsolute && existsSync(c)) return c;
    try {
      execSync(`"${c}" --version`, { stdio: 'ignore', timeout: 5000 });
      return c;
    } catch { /* not found in PATH */ }
  }
  return null;
}

const LOOPBACK_PROXY_PATTERN = /https?:\/\/(127\.\d+\.\d+\.\d+|localhost):\d+\/?/i;

export function buildMitmServiceInstallOptions({
  cfg = {},
  os,
  home = homedir(),
  mitmdumpBin,
  sslEnv = buildCorporateSslEnv(),
  corpProxy = cfg?.proxy?.headroom?.corporate_proxy ?? '',
  winManager = cfg?.proxy?.windows_service?.manager ?? 'registry',
  headroomPort = selectedEnginePort(cfg),
  enginePlan = buildEngineInstancePlan(cfg),
  mitmAddonPathImpl = mitmAddonPath,
  defaultWindowsHomeImpl = defaultWindowsHome,
} = {}) {
  const mitmCfg = cfg?.proxy?.mitm ?? {};
  const { MYELIN_COMPRESS, copilotHeadroomPort } = resolveMitmCompression(cfg);
  const copilotInstance = copilotHeadroomPort
    ? enginePlan.instances?.find(({ role }) => role === 'copilot')
    : undefined;
  const copilotEngineUrl = copilotInstance ? `http://127.0.0.1:${copilotInstance.port}` : undefined;
  const egressPort = copilotInstance ? (mitmCfg.egress_port ?? 8889) : undefined;
  const windowsHome = os === 'windows' &&
    /^\/(?!mnt\/[a-zA-Z](?:\/|$))/u.test(String(home ?? ''))
    ? defaultWindowsHomeImpl(home)
    : home;
  const normalizedHomeCandidate = os === 'windows' ? normalizeWindowsFilesystemPath(windowsHome) : home;
  const effectiveHome = os === 'windows' && !/^(?:[a-z]:\\|\\\\)/i.test(normalizedHomeCandidate)
    ? defaultWindowsHomeImpl(home)
    : normalizedHomeCandidate;
  if (os === 'windows' && !/^(?:[a-zA-Z]:[\\/]|\\\\)/u.test(effectiveHome)) {
    throw new Error(`Cannot resolve a Windows-service home from ${home}; refusing to emit a \\home service asset path.`);
  }
  const envVars = {
    MYELIN_HEADROOM_PORT: String(headroomPort),
    MYELIN_COMPRESS,
    ...(copilotEngineUrl ? { MYELIN_COPILOT_ENGINE_URL: copilotEngineUrl } : {}),
    ...(mitmCfg.block_bypass ? { MYELIN_BLOCK_BYPASS: '1' } : {}),
    ...(mitmCfg.block_marker ? { MYELIN_BLOCK_MARKER: mitmCfg.block_marker } : {}),
    ...(mitmCfg.override_proxy ? { MYELIN_OVERRIDE_PROXY: mitmCfg.override_proxy } : {}),
    ...(mitmCfg.vpn_domains_file ? { MYELIN_VPN_DOMAINS_FILE: mitmCfg.vpn_domains_file } : {}),
    ...(mitmCfg.extra_providers ? { MYELIN_EXTRA_PROVIDERS: mitmCfg.extra_providers } : {}),
    ...sslEnv,
  };
  if (os === 'windows') {
    for (const key of ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'HEADROOM_CA_BUNDLE', 'MYELIN_VPN_DOMAINS_FILE']) {
      if (envVars[key]) envVars[key] = normalizeWindowsFilesystemPath(envVars[key]);
    }
  }
  return {
    mitmdumpBin: os === 'windows' ? normalizeWindowsFilesystemPath(mitmdumpBin) : mitmdumpBin,
    port: mitmCfg.port ?? 8888,
    addonPath: os === 'windows'
      ? normalizeWindowsFilesystemPath(mitmAddonPathImpl(effectiveHome, os), { rejectPosix: true })
      : mitmAddonPathImpl(effectiveHome, os),
    envVars,
    upstreamProxy: String(corpProxy ?? '').replace(LOOPBACK_PROXY_PATTERN, '').trim(),
    logPath: joinManaged(managedPaths({
      home: effectiveHome,
      platform: os === 'windows' ? 'windows' : os,
    }).root, 'mitmproxy.log'),
    home: effectiveHome,
    egressPort,
    manager: winManager,
  };
}

export function buildCopilotHeadroomServiceInstallOptions({
  cfg = {},
  headroomBin,
  home = homedir(),
  manager = cfg?.proxy?.windows_service?.manager ?? 'registry',
  sslEnv = buildCorporateSslEnv(),
} = {}) {
  const copilotHeadroomCfg = cfg?.proxy?.copilot_headroom ?? {};
  const mitmCfg = cfg?.proxy?.mitm ?? {};
  const egressPort = mitmCfg.egress_port ?? 8889;
  const port = copilotHeadroomCfg.port ?? 8788;
  const loopbackTarget = `http://127.0.0.1:${egressPort}`;
  return {
    headroomBin,
    port,
    envVars: {
      ANTHROPIC_TARGET_API_URL: loopbackTarget,
      OPENAI_TARGET_API_URL: loopbackTarget,
      HEADROOM_MODE: copilotHeadroomCfg.mode ?? 'cache',
      NO_PROXY: '127.0.0.1,localhost,::1',
      ...sslEnv,
    },
    home,
    manager,
    egressPort,
  };
}

export function buildDownstreamProxyServiceInstallOptions({
  cfg = {},
  os,
  home = homedir(),
  mitmdumpBin,
  sslEnv = buildCorporateSslEnv(),
  corpProxy = cfg?.proxy?.headroom?.corporate_proxy ?? '',
  winManager = cfg?.proxy?.windows_service?.manager ?? 'registry',
  installPlan = {},
} = {}) {
  const resolvedEnginePlan = { ...(installPlan?.enginePlan ?? installPlan ?? buildServiceEnginePlan(cfg)) };
  const windowsServiceCfg = cfg?.proxy?.windows_service ?? {};
  const mitmCfg = cfg?.proxy?.mitm ?? {};
  const mitmEnabled = mitmCfg.enabled !== false;
  const { copilotHeadroomPort } = resolveMitmCompression(cfg);
  const watchdogInterval = Number(windowsServiceCfg.watchdog_interval_minutes ?? 2) || 2;
  return {
    mitmOpts: mitmEnabled && mitmdumpBin ? buildMitmServiceInstallOptions({
      cfg,
      os,
      home,
      mitmdumpBin,
      sslEnv,
      corpProxy,
      winManager,
      headroomPort: resolvedEnginePlan.selectedPort,
      enginePlan: resolvedEnginePlan.instances ? resolvedEnginePlan : buildEngineInstancePlan(cfg),
    }) : null,
    watchdogOpts: {
      home,
      enabled: winManager === 'winsw' && (windowsServiceCfg.watchdog_enabled ?? false),
      intervalMinutes: watchdogInterval,
      instances: resolvedEnginePlan.instances ?? buildEngineInstancePlan(cfg).instances,
      headroomPort: resolvedEnginePlan.selectedPort,
      ...(mitmEnabled ? { mitmPort: mitmCfg.port ?? 8888 } : {}),
      ...(mitmEnabled && copilotHeadroomPort && mitmdumpBin ? {
        copilotHeadroomPort,
        egressPort: mitmCfg.egress_port ?? 8889,
      } : {}),
    },
  };
}

export async function applyMitmServiceInstallPlan({
  cfg = {},
  os,
  home,
  winManager,
  mitmOpts,
  installMitmServiceImpl = installMitmService,
  removeMitmServiceImpl = removeMitmService,
} = {}) {
  if (cfg?.proxy?.mitm?.enabled === false) {
    await removeMitmServiceImpl({ os, manager: winManager, home });
    return { installed: false, removed: true };
  }
  if (!mitmOpts) return { installed: false, removed: false };
  await installMitmServiceImpl(mitmOpts);
  return { installed: true, removed: false };
}

/**
 * Install mitmproxy (mitmdump) if not present.
 * Mac: brew. Windows: pip (pipx). Linux: pip via uv.
 * Returns the mitmdump binary path.
 */
export async function ensureMitmproxy(os, {
  wsl = false,
  serviceHome,
  installIfMissing = true,
  detectMitmdumpImpl = detectMitmdump,
  resolveWindowsServiceExecutableImpl = resolveWindowsServiceExecutable,
  execSyncImpl = execSync,
  execFileSyncImpl = execFileSync,
} = {}) {
  const windowsServiceFromWsl = os === 'windows' && wsl;
  const resolveDetectedMitmdump = () => {
    const candidate = detectMitmdumpImpl(os);
    if (!windowsServiceFromWsl) return candidate;
    return resolveWindowsServiceExecutableImpl(
      {
        backend: 'mitmdump',
        candidate,
        serviceHome,
        servicePlatform: os,
        wsl,
      },
      { execFileSyncImpl },
    );
  };

  let bin = null;
  let resolutionError = null;
  try {
    bin = resolveDetectedMitmdump();
  } catch (error) {
    if (!windowsServiceFromWsl) throw error;
    resolutionError = error;
  }
  if (bin) return bin;

  if (!installIfMissing) {
    // Detect-only mode: mitmproxy is a managed pinned component provisioned by
    // the atomic staged release. An atomic update must never mutate global
    // component state, so we never fall through to a package-manager install.
    return null;
  }

  console.log('  Installing mitmproxy…');
  if (os === 'darwin') {
    // brew exits non-zero if already installed via different formula; ignore exit code
    try { execSyncImpl('brew install mitmproxy', { stdio: 'inherit' }); } catch {}
  } else if (windowsServiceFromWsl) {
    const script = `$launchers = @(
  @{ Name = 'py.exe'; Prefix = @('-3') },
  @{ Name = 'python.exe'; Prefix = @() }
)
foreach ($launcher in $launchers) {
  $command = Get-Command -Name $launcher.Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) { continue }
  $path = if ($command.Source) { $command.Source } else { $command.Path }
  if (-not $path) { continue }
  $windowsPath = $path.Replace('/', '\\')
  $isWslUnc = $windowsPath.StartsWith('\\\\wsl.localhost\\', [System.StringComparison]::OrdinalIgnoreCase) -or
    $windowsPath.StartsWith('\\\\wsl$\\', [System.StringComparison]::OrdinalIgnoreCase)
  if ($isWslUnc -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
    continue
  }
  $arguments = @()
  $arguments += $launcher.Prefix
  $arguments += @('-m', 'pip', 'install', '--user', 'mitmproxy')
  & $path @arguments
  exit $LASTEXITCODE
}
Write-Error 'Windows Python was not found in PATH.'
exit 1`;
    try {
      execFileSyncImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          stdio: 'inherit',
          windowsHide: true,
        },
      );
    } catch {}
  } else if (os === 'windows') {
    try {
      execSyncImpl('pip install --user mitmproxy', { stdio: 'inherit' });
    } catch {}
  } else {
    try {
      execSyncImpl('pip install --user mitmproxy', { stdio: 'inherit' });
    } catch {}
  }

  try {
    bin = resolveDetectedMitmdump();
  } catch (error) {
    if (!windowsServiceFromWsl) throw error;
    resolutionError = error;
  }
  if (bin) { ok(`mitmproxy (${bin})`); return bin; }
  if (windowsServiceFromWsl) {
    throw resolutionError ?? new Error(
      'Unable to resolve a Windows-service executable for mitmdump from WSL. Install mitmproxy with Windows Python so mitmdump.exe is available in the Windows user PATH or a Windows Python Scripts directory.',
    );
  }
  const installCmd = os === 'darwin' ? 'brew install mitmproxy'
                   : os === 'windows' ? 'pip install mitmproxy'
                   : 'pip3 install --user mitmproxy';
  warn(`mitmdump not found after install — install manually: ${installCmd}`);
  return null;
}

/**
 * Generate the mitmproxy CA (runs mitmdump briefly if CA does not exist).
 * Returns the CA cert path, or null.
 */
async function ensureMitmCA(home, mitmdumpBin) {
  const caPath = join(home, '.mitmproxy', 'mitmproxy-ca-cert.pem');
  if (existsSync(caPath)) return caPath;
  if (!mitmdumpBin) return null;

  ok('Generating mitmproxy CA (one-time)…');
  try {
    // Run mitmdump briefly in background; poll for CA file (appears in ~0.5-2s)
    const proc = spawn(mitmdumpBin, ['--listen-port', '19876'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.unref();
    const pid = proc.pid;
    if (!pid) throw new Error('spawn failed — no PID');

    // Poll up to 15s
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (existsSync(caPath)) break;
    }
    try { process.kill(pid, 'SIGTERM'); } catch {}
  } catch (e) {
    warn(`CA generation failed: ${e.message}`);
  }

  if (!existsSync(caPath)) {
    skip(`mitmproxy CA not found — run manually: mitmdump --listen-port 19876 &; sleep 3; kill %1`);
    return null;
  }
  return caPath;
}

/**
 * Ownership-verified shutdown of legacy Myelin-managed proxy processes during
 * the one-time ~/.tokenstack → ~/.myelin migration.
 *
 * The previous implementation ran `Stop-Process -Name headroom,mitmdump`,
 * which name-kills *any* process sharing those names — including a user's own
 * unrelated headroom/mitmproxy install. This replacement never name-kills:
 * it only stops a process when (a) its pid was persisted by Myelin under the
 * legacy managed directory, (b) the process is still live (has a StartTime),
 * and (c) the process is genuinely running *from* the managed directory being
 * migrated (command-line / executable-path ownership — mirrors the
 * headroomLiteMatchesManagedPid guard in src/cli/restart.mjs). A same-named
 * process installed elsewhere can never satisfy (c), so it is left untouched.
 */
function legacyManagedPidFiles(oldDir) {
  return [
    join(oldDir, 'services', 'myelin-headroom', 'headroom.pid'),
    join(oldDir, 'services', 'myelin-copilot-headroom', 'copilot-headroom.pid'),
    join(oldDir, 'services', 'myelin-mitmproxy', 'mitm.pid'),
    join(oldDir, 'state', 'headroom-lite', 'headroom-lite.pid'),
  ];
}

function legacyProcessInfo(pid, { execSyncImpl = execSync, powershellExe } = {}) {
  try {
    const ps = powershellExe ?? powerShellExecutable({ windowsInterop: true });
    const script = [
      `$proc = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
      'if (-not $proc) { return }',
      '@{ command = $proc.CommandLine; executablePath = $proc.ExecutablePath; startTime = if ($proc.CreationDate) { $proc.CreationDate.ToString("o") } else { "" } } | ConvertTo-Json -Compress',
    ].join('; ');
    const out = execSyncImpl(`${ps} -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().replace(/^\uFEFF/, '').trim();
    return out ? JSON.parse(out) : null;
  } catch {
    return null;
  }
}

function legacyManagedProcessIsOwned(processInfo, managedRoot) {
  if (!processInfo) return false;
  // Require a live process (StartTime present) to avoid acting on a stale or
  // torn pid record, then verify command-path ownership under the managed dir.
  if (!processInfo.startTime) return false;
  return [processInfo.command, processInfo.executablePath].some((value) =>
    pathReferencesManagedDir(value, managedRoot)
  );
}

/**
 * Does `value` (a process command line or executable path) reference a file that
 * lives INSIDE `dir`, matched at a PATH-COMPONENT boundary? A plain substring
 * check wrongly treats a sibling like `...\uv\tools-backup\semble.exe` as owned
 * by `...\uv\tools` (the prefix `tools` is a substring of `tools-backup`).
 * Require `dir` to be followed by a path separator (or to equal the value
 * exactly) after normalizing separators AND case, so `...\uv\tools` matches only
 * a genuine `...\uv\tools\<child>` and never `...\uv\tools-backup\...`.
 */
function pathReferencesManagedDir(value, dir) {
  const normalize = (s) => String(s ?? '').replace(/[\\/]+/g, '/').toLowerCase();
  const needle = normalize(dir).replace(/\/+$/u, '');
  if (!needle) return false;
  const hay = normalize(value);
  return hay === needle || hay.includes(`${needle}/`);
}

function defaultStopManagedPid(pid, { execSyncImpl = execSync, powershellExe } = {}) {
  const ps = powershellExe ?? powerShellExecutable({ windowsInterop: true });
  // Stop strictly by pid — never by process name.
  execSyncImpl(`${ps} -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction Stop"`, { stdio: 'pipe' });
}

export function stopLegacyManagedProxies({
  os,
  oldDir,
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  powershellExe,
  processInfoFn = (pid) => legacyProcessInfo(pid, { execSyncImpl, powershellExe }),
  stopPidFn = (pid) => defaultStopManagedPid(pid, { execSyncImpl, powershellExe }),
} = {}) {
  const stopped = [];
  const skipped = [];
  if (os !== 'windows' || !oldDir) return { stopped, skipped };

  const seen = new Set();
  for (const pidFile of legacyManagedPidFiles(oldDir)) {
    let pid = null;
    try {
      if (!existsSyncImpl(pidFile)) continue;
      pid = Number(
        String(readFileSyncImpl(pidFile, 'utf8') ?? '')
          .replace(/^\uFEFF/, '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ?? '',
      );
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);

    const info = processInfoFn(pid);
    if (!legacyManagedProcessIsOwned(info, oldDir)) {
      skipped.push({ pid, reason: 'not a verified Myelin-managed process' });
      continue;
    }

    try {
      stopPidFn(pid);
      stopped.push(pid);
    } catch (error) {
      skipped.push({ pid, reason: `failed to stop pid ${pid}: ${error?.message?.split?.('\n')?.[0] ?? error}` });
    }
  }

  return { stopped, skipped };
}

/**
 * Ownership-verified shutdown of a uv-tool-managed MCP process (serena-agent /
 * semble) so a Windows in-place `uv tool install` can replace files the running
 * server holds open — WITHOUT ever name-killing.
 *
 * The previous implementation ran `Get-Process -Name 'serena-agent' |
 * Stop-Process -Force`, which kills ANY process sharing that name, including a
 * user's own unrelated build. This replacement instead:
 *   (a) resolves the uv tool install location (`uv tool dir`); if it cannot be
 *       resolved, it does NOTHING (best-effort no-op) rather than name-killing;
 *   (b) enumerates same-named processes and keeps only those that are LIVE
 *       (StartTime present) AND whose command line / executable path runs FROM
 *       the uv tool dir — a same-named process installed elsewhere can never
 *       satisfy this, so it is left untouched;
 *   (c) stops each verified process strictly by PID (never by name).
 */
function defaultUvToolDir({ execSyncImpl = execSync } = {}) {
  try {
    const out = execSyncImpl('uv tool dir', { stdio: ['ignore', 'pipe', 'pipe'] });
    const dir = String(out ?? '').toString().replace(/^\uFEFF/, '').trim();
    return dir || null;
  } catch {
    return null;
  }
}

function defaultUvToolProcessList(name, { execSyncImpl = execSync, powershellExe } = {}) {
  try {
    const ps = powershellExe ?? powerShellExecutable({ windowsInterop: true });
    const script = [
      `$procs = Get-CimInstance Win32_Process -Filter "Name = '${name}.exe' OR Name = '${name}'" -ErrorAction SilentlyContinue`,
      'if (-not $procs) { return }',
      '@($procs | ForEach-Object { @{ pid = $_.ProcessId; command = $_.CommandLine; executablePath = $_.ExecutablePath; startTime = if ($_.CreationDate) { $_.CreationDate.ToString("o") } else { "" } } }) | ConvertTo-Json -Compress',
    ].join('; ');
    const out = execSyncImpl(`${ps} -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().replace(/^\uFEFF/, '').trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export function stopManagedUvToolProcess(name, {
  os,
  execSyncImpl = execSync,
  powershellExe,
  toolDirFn = () => defaultUvToolDir({ execSyncImpl }),
  processListFn = (n) => defaultUvToolProcessList(n, { execSyncImpl, powershellExe }),
  isOwnedFn = legacyManagedProcessIsOwned,
  stopPidFn = (pid) => defaultStopManagedPid(pid, { execSyncImpl, powershellExe }),
} = {}) {
  const stopped = [];
  const skipped = [];
  if (os !== 'windows' || !name) return { stopped, skipped };

  // Cannot verify ownership → refuse to touch anything (never blind name-kill).
  const toolDir = toolDirFn();
  if (!toolDir) return { stopped, skipped, unverified: true };

  const seen = new Set();
  for (const info of processListFn(name)) {
    const pid = Number(info?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);

    if (!isOwnedFn(info, toolDir)) {
      skipped.push({ pid, reason: 'not a verified uv-tool-managed process' });
      continue;
    }

    try {
      stopPidFn(pid);
      stopped.push(pid);
    } catch (error) {
      skipped.push({ pid, reason: `failed to stop pid ${pid}: ${error?.message?.split?.('\n')?.[0] ?? error}` });
    }
  }

  return { stopped, skipped };
}

/**
 * Copilot/Claude wrappers are now defined in ./service/wrappers.mjs so they
 * can be unit-tested for env-var isolation. Never set provider env vars
 * globally (shell profile / Windows registry) — always via these wrappers.
 */
async function main() {
  const { values: flags } = parseArgs({
    options: {
      profile:         { type: 'string',  default: 'proxy' },
      'index-tier':    { type: 'string',  default: 'default' },
      'no-headroom':   { type: 'boolean', default: false },
      'no-rtk':        { type: 'boolean', default: false },
      'copilot-only':  { type: 'boolean', default: false },
      'claude-only':   { type: 'boolean', default: false },
      check:           { type: 'boolean', default: false },
      'dry-run':       { type: 'boolean', default: false },
      yes:             { type: 'boolean', default: false, short: 'y' },
      'update-apply':  { type: 'boolean', default: false },
      'update-token':  { type: 'string' },
      'staged-release':{ type: 'string' },
      config:          { type: 'string' },
    },
    strict: false,
  });

  const os       = detectOS();
  const shell    = detectShell();
  const home     = homedir();
  const managed = managedPaths({ home, env: process.env });
  const claudeCC = !flags['copilot-only'];
  const copilot  = !flags['claude-only'];
  // During an atomic staged apply (`--update-apply`) the managed components are
  // already pinned and provisioned by the staged release. Global (unpinned)
  // component installs must be suppressed so the transaction never mutates
  // legacy/global state (Task 10 finding 3).
  const runGlobalComponentInstalls = !flags['update-apply'];

  // Mutation fence (Task 10 finding 1). Every install side effect must run under
  // a held update lock: a staged apply re-asserts the orchestrator's nested lock
  // (after validating the exported transaction environment), while an ordinary
  // install acquires the global update lock so it can never race a concurrent
  // update/install. dry-run/check perform no mutations and take no lock.
  const transactionPaths = updatePaths(home);
  const configPath = flags.config ?? DEFAULT_CONFIG_PATH;
  const nestedToken = flags['update-apply']
    ? assertStagedApplyAuthorization({ flags, configPath, lockPath: transactionPaths.lockPath })
    : null;
  let installGlobalLock = null;
  let stopInstallHeartbeat = null;
  if (!flags['update-apply'] && !flags.check && !flags['dry-run']) {
    const lock = createUpdateLock();
    const token = lock.acquire(transactionPaths.lockPath);
    installGlobalLock = { lock, token };
    stopInstallHeartbeat = lock.startHeartbeat(token, transactionPaths.lockPath);
    process.once('exit', () => {
      try {
        stopInstallHeartbeat?.();
        lock.release(token, transactionPaths.lockPath);
      } catch {}
    });
  }
  const assertInstallMutationFence = createInstallMutationFence({
    nestedToken,
    installGlobalLock,
    lockPath: transactionPaths.lockPath,
  });

  console.log('\n🧬 Myelin Installer — ' + os + '\n');

  // Relocation-migration decision (detection only): if the user moved the
  // managed root via MYELIN_DIR but the default ~/.myelin still holds the
  // release/config state and the new root is empty, surface that so its history
  // and config can be carried over.
  try {
    const relocation = planManagedRelocationMigration({ home, env: process.env, platform: os });
    if (relocation.shouldMigrate) {
      warn(`relocated MYELIN_DIR (${relocation.to}) is empty but ${relocation.from} holds managed state — migrate releases/current.json/config to preserve history`);
    }
  } catch {}

  // Staged-release apply (--update-apply) must never mutate legacy global
  // state; skip the one-time ~/.tokenstack migration entirely in that mode.
  let didMigrate = false;
  if (!flags['dry-run'] && !flags['update-apply']) {
  // Migrate ~/.tokenstack → ~/.myelin (one-time)
  const oldDir = join(home, '.tokenstack');
  const newDir = managed.root;
  // Also handle the case where Move-Item put .tokenstack *inside* .myelin
  const nestedOld = join(newDir, '.tokenstack');
  const runningFromOld = process.argv[1]?.startsWith(oldDir);
  const runningFromNested = process.argv[1]?.startsWith(nestedOld);

  if (existsSync(nestedOld)) {
    // Move non-repo contents of .myelin/.tokenstack up into .myelin
    // Safe to run even when running from inside nestedOld — we skip repo and don't delete if locked
    try {
      const { readdirSync, renameSync } = await import('node:fs');
      for (const entry of readdirSync(nestedOld)) {
        if (entry === 'repo') continue; // repo may be locked if running from it
        const src = join(nestedOld, entry);
        const dst = join(newDir, entry);
        if (!existsSync(dst)) renameSync(src, dst);
      }
      // Move repo to correct location only if not currently running from it
      const nestedRepo = join(nestedOld, 'repo');
      const correctRepo = join(newDir, 'repo');
      if (!runningFromNested && existsSync(nestedRepo) && !existsSync(correctRepo)) {
        const { renameSync } = await import('node:fs');
        renameSync(nestedRepo, correctRepo);
      }
      // Only delete nestedOld if not running from it
      if (!runningFromNested) {
        const { rmSync } = await import('node:fs');
        rmSync(nestedOld, { recursive: true, force: true });
        ok('Cleaned up nested ~/.myelin/.tokenstack → ~/.myelin');
      } else {
        ok('Migrated runtime files from nested .tokenstack (repo stays until next install from correct path)');
      }
      didMigrate = true;
    } catch (e) { warn(`Nested migration failed: ${e.message.split('\n')[0]}`); }
  }

  if (existsSync(oldDir) && !existsSync(newDir) && !runningFromOld) {
    // On Windows, running processes lock the venv dir — stop them first, but
    // ONLY Myelin-managed processes verified by persisted pid + command-path
    // ownership. Never name-kill (that could take out an unrelated headroom
    // or mitmproxy the user installed themselves).
    if (os === 'windows') {
      try {
        const { stopped, skipped } = stopLegacyManagedProxies({ os, oldDir });
        if (stopped.length) {
          ok(`Stopped ${stopped.length} Myelin-managed legacy process(es) before migration`);
          await new Promise(r => setTimeout(r, 1000));
        }
        for (const { pid, reason } of skipped) {
          skip(`Left process ${pid} running (${reason})`);
        }
      } catch (e) {
        warn(`Could not stop legacy managed processes: ${e.message.split('\n')[0]} — continuing`);
      }
    }
    try {
      const { renameSync } = await import('node:fs');
      renameSync(oldDir, newDir);
      ok('Migrated ~/.tokenstack → ~/.myelin');
      didMigrate = true;
    } catch {
      // Fallback: copy + delete (handles cross-device or locked files).
      // Uses fs cp/rm APIs — never a shell — so the managed `newDir`
      // (MYELIN_DIR-derived, may contain spaces/$()/quotes) is never parsed by
      // any shell. cpSync recurses; this branch only runs when newDir is absent.
      try {
        const { cpSync, rmSync } = await import('node:fs');
        cpSync(oldDir, newDir, { recursive: true });
        rmSync(oldDir, { recursive: true, force: true });
        ok('Migrated ~/.tokenstack → ~/.myelin (via copy)');
        didMigrate = true;
      } catch (e2) {
        warn(`Could not migrate ~/.tokenstack → ~/.myelin: ${e2.message.split('\n')[0]} — continuing`);
      }
    }
  } else if (existsSync(oldDir) && existsSync(newDir)) {
    const oldRepo = join(oldDir, 'repo');
    const newRepoDir = join(newDir, 'repo');
    if (runningFromOld) {
      // The currently-executing script's own files live under oldDir —
      // deleting it now would pull the source tree out from under this
      // very process (dynamic imports later in this run would then fail
      // with MODULE_NOT_FOUND). Defer cleanup to the next run.
      // Instead, pre-populate the canonical ~/.myelin/repo location with a
      // COPY (not move — oldDir must stay intact for the rest of this run)
      // so resolveRepoRoot() below picks it up immediately: the shell
      // alias/service configs generated later in *this same run* will
      // already point at newRepoDir, and the *next* invocation (now
      // running from newRepoDir) will finish removing oldDir.
      if (existsSync(oldRepo) && !existsSync(newRepoDir)) {
        try {
          // fs cp (never a shell): the managed `newRepoDir` is MYELIN_DIR-derived
          // and must never be spliced into a `cp`/`robocopy` shell command.
          const { cpSync } = await import('node:fs');
          cpSync(oldRepo, newRepoDir, { recursive: true });
          ok('Copied repo to ~/.myelin/repo (removing ~/.tokenstack next run)');
        } catch (e) {
          warn(`Could not pre-copy repo to ~/.myelin/repo: ${e.message.split('\n')[0]}`);
        }
      } else {
        ok('~/.tokenstack still in use by this run — will remove on next install/update');
      }
    } else {
      try {
        const { rmSync } = await import('node:fs');
        rmSync(oldDir, { recursive: true, force: true });
        ok('Removed legacy ~/.tokenstack');
      } catch {}
    }
  }

  // Migrate old launchd/systemd service names
  if (os === 'darwin') {
    try {
      execSync('launchctl bootout gui/$(id -u)/com.tokenstack.headroom 2>/dev/null || true', { shell: true, stdio: 'pipe' });
      const oldPlist = join(home, 'Library', 'LaunchAgents', 'com.tokenstack.headroom.plist');
      if (existsSync(oldPlist)) { const { unlinkSync } = await import('node:fs'); unlinkSync(oldPlist); ok('Removed legacy com.tokenstack.headroom launchd service'); }
    } catch {}
    // Patch any headroom plist that still references ~/.tokenstack CA paths
    try {
      const { readdirSync, readFileSync } = await import('node:fs');
      const la = join(home, 'Library', 'LaunchAgents');
      const plists = readdirSync(la).filter(f => f.endsWith('.headroom.plist') && !f.includes('.bak'));
      for (const pf of plists) {
        const fp = join(la, pf);
        const raw = readFileSync(fp, 'utf8');
        if (raw.includes('.tokenstack')) {
          writeFileSync(fp, raw.replaceAll('.tokenstack', '.myelin'), 'utf8');
          ok(`Patched ${pf}: .tokenstack → .myelin CA paths`);
        }
      }
    } catch {}
  } else if (os === 'linux') {
    try {
      execSync('systemctl --user disable --now tokenstack-headroom.service 2>/dev/null || true', { stdio: 'pipe' });
      const oldUnit = join(home, '.config', 'systemd', 'user', 'tokenstack-headroom.service');
      if (existsSync(oldUnit)) { const { unlinkSync } = await import('node:fs'); unlinkSync(oldUnit); ok('Removed legacy tokenstack-headroom systemd service'); }
    } catch {}
  }

  // Clear stale SSL env vars pointing to old ~/.tokenstack path
  for (const v of ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'HEADROOM_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO']) {
    if (process.env[v]?.includes('.tokenstack')) delete process.env[v];
  }
  } // end legacy migration (skipped under --update-apply)

  console.log('Detecting existing installations...');

  const tools     = await detectAll();
  const { proxy: corpProxy } = detectCorporateProxy();
  const caBundles = detectCaBundles();
  const sslEnv    = buildCorporateSslEnv(caBundles[0]?.path ?? null);

  if (flags.check) { printStateTable(tools, caBundles, corpProxy); process.exit(0); }

  mkdirSync(managed.root, { recursive: true });
  const existingCfg = await loadConfig(DEFAULT_CONFIG_PATH);
  const initialEnginePlan = buildEngineInstancePlan(existingCfg);
  const initialPrimaryInstance = initialEnginePlan.instances.find(({ role }) => role === 'primary');
  const installsPythonHeadroomPackage = shouldInstallPythonHeadroomPackage({ cfg: existingCfg, flags });
  const copilotHudEnabled = Boolean(existingCfg.copilot_hud?.enabled);
  const tokenOptimizerEnabled = existingCfg.observability?.token_optimizer === true;
  const codegraphEnabled = existingCfg.code_discovery?.codegraph === true;
  const venv = managed.venvPath;
  // Gated on BOTH the config flag AND actual presence — a leftover global
  // install from a prior "enabled: true" run (or an unrelated `npm install -g
  // @optave/codegraph` on the machine) must never cause MCP registration
  // while the flag is false. See claudeMcpServers/copilotMcpServers below for
  // the matching cleanup: an explicit `codegraph: undefined` actively strips
  // any stale entry mergeJsonFile previously wrote (mergeDeepPlain otherwise
  // never deletes keys — only overlays what's present in the update object).
  let codegraphReady = codegraphEnabled && tools.codegraph.installed;
  let port = resolveProxyEnvPort(existingCfg, initialPrimaryInstance);
  let selectedInstallEngine = initialEnginePlan.engine;
  let selectedProxyPort = resolveProxyEnvPort(existingCfg, initialPrimaryInstance);
  if (initialEnginePlan.engine === 'headroom' && !(await isPortFree(port))) {
    const alreadyOurs = await import('./tools/headroom.mjs').then(m => m.waitForHeadroom(port, 1500)).catch(() => false);
    if (alreadyOurs) {
      ok(`Headroom already running on port ${port} — keeping`);
    } else {
      warn(`Port ${port} in use. Finding a free port...`);
      port = await findFreePort(port + 1, port + 20);
      ok(`Using port ${port}`);
    }
  }
  if (existingCfg.proxy?.engine !== 'headroom_lite') selectedProxyPort = port;

  if (flags['dry-run']) {
    console.log('\n[dry-run] Would install / configure:');
    const dryRunTools = ['uv', 'serena', 'semble', 'ast-grep', ...(existingCfg.budget_routing?.litellm ? ['litellm'] : []), ...(codegraphEnabled ? ['codegraph'] : []), 'rtk', 'mitmproxy'];
    console.log(`  ${dryRunTools.join(', ')}`);
    if (copilotHudEnabled && copilot) console.log('  copilot-hud plugin');
    if (installsPythonHeadroomPackage) console.log('  headroom-ai[all] from PyPI');
    if (flags.profile === 'proxy') console.log(`  headroom service on port ${port}, mitmproxy service on port 8888`);
    if (claudeCC) console.log('  ~/.claude/settings.json, CLAUDE.md, hooks');
    if (copilot)  console.log('  ~/.copilot/mcp-config.json');
    console.log('  shell profile HEADROOM_PORT + _copilot/_claude wrappers (per-invocation env, no global pollution)');
    console.log('\n[dry-run] No changes made.\n');
    return;
  }

  const managedRuntime = resolveManagedRuntime({
    home,
    os,
    stageMainRuntimeFn: stageMainRuntime,
    repoUrl: resolveManagedMainRepoUrl(),
  });
  const runtimeBridge = writeManagedRuntimeBridge({ home });


  step('[1/7] Package manager...');
  assertInstallMutationFence();
  if (runGlobalComponentInstalls) {
    await ensureUv();
    ok('uv ready');
  } else {
    skip('package manager (managed component provisioned by staged release)');
  }

  // 2. Code discovery tools
  step('[2/7] Code discovery tools...');
  assertInstallMutationFence();
  if (runGlobalComponentInstalls) {
  if (!tools.serena.installed) {
    console.log('  Installing Serena (oraios/serena)...');
    if (os === 'windows') {
      stopManagedUvToolProcess('serena-agent', { os });
      await new Promise(r => setTimeout(r, 500));
    }
    try {
      execSync('uv tool install --python 3.12 "serena-agent @ git+https://github.com/oraios/serena.git"', { stdio: 'pipe' });
      ok('serena installed');
    } catch (e) {
      const output = `${e?.message ?? ''}\n${e?.stderr?.toString?.() ?? ''}\n${e?.stdout?.toString?.() ?? ''}`.toLowerCase();
      if (os === 'windows' && (output.includes('access is denied') || output.includes('os error 5') || output.includes('cannot access the file'))) {
        warn('serena install failed: MCP server process still locked. Stop Claude Code / Copilot CLI and re-run: myelin install --yes');
      } else {
        if (e?.stdout) process.stdout.write(e.stdout);
        if (e?.stderr) process.stderr.write(e.stderr);
        throw e;
      }
    }
  } else { skip(`serena (${tools.serena.version})`); }
  // Always ensure bottle<0.13 in serena env — 0.13+ is pyzapp (no .py), breaks webview
  try {
    const serenaEnv = execSync('uv tool dir', { stdio: 'pipe' }).toString().trim();
    const bottlePath = join(serenaEnv, 'serena-agent');
    // execFileSync: bottlePath (uv-tool-dir-derived venv) is a literal argv element, never shell-parsed
    execFileSync('uv', ['pip', 'install', '--python', bottlePath, 'bottle<0.13'], { stdio: 'pipe' });
  } catch {}
  // Serena opens a browser tab/window every time its MCP server starts by
  // default (web_dashboard_open_on_launch: true) - quality-of-life fix,
  // never worth failing the install over if it doesn't apply yet (config
  // file may not exist until Serena's first run, e.g. via `myelin init`).
  try {
    if (applyDisableSerenaDashboardAutoOpen(home)) ok('serena dashboard auto-open disabled');
  } catch {}

  if (!tools.semble.installed) {
    console.log('  Installing Semble...');
    if (os === 'windows') {
      stopManagedUvToolProcess('semble', { os });
      await new Promise(r => setTimeout(r, 500));
    }
    let sembleInstalled = false;
    try {
      execSync('uv tool install "semble[mcp]"', { stdio: 'pipe' });
      sembleInstalled = true;
    } catch (e) {
      const output = `${e?.message ?? ''}\n${e?.stderr?.toString?.() ?? ''}\n${e?.stdout?.toString?.() ?? ''}`.toLowerCase();
      if (os === 'windows' && (output.includes('access is denied') || output.includes('os error 5') || output.includes('cannot access the file'))) {
        warn('semble install failed: MCP server process still locked. Stop Claude Code / Copilot CLI and re-run: myelin install --yes');
      } else {
        if (e?.stdout) process.stdout.write(e.stdout);
        if (e?.stderr) process.stderr.write(e.stderr);
        throw e;
      }
    }
    if (sembleInstalled) {
      try {
        execSync(`semble install ${claudeCC ? '--agent claude --type mcp subagent' : ''} --yes`, { stdio: 'pipe' });
      } catch {}
      ok('semble installed');
    }
  } else { skip('semble (installed)'); }

  // agentcairn — best-in-class local memory MCP (Obsidian vault + DuckDB, LongMemEval top score)
  {
    const cairnInstalled = (() => { try { execSync('uv tool run --from agentcairn cairn --version', { stdio: 'pipe', timeout: 5000 }); return true; } catch { return false; } })();
    if (!cairnInstalled) {
      console.log('  Installing agentcairn...');
      try {
        execSync('uv tool install --python 3.12 agentcairn', { stdio: 'inherit' });
        ok('agentcairn installed');
      } catch { warn('agentcairn install failed — will use uvx fallback'); }
    } else { skip('agentcairn (installed)'); }
    // Claude Code plugin gives richer auto-recall hooks — install if claude CLI is available
    if (claudeCC) {
      try {
        execSync('claude plugin list 2>/dev/null | grep -q agentcairn || (claude plugin marketplace add ccf/agentcairn 2>/dev/null && claude plugin install agentcairn@agentcairn --yes 2>/dev/null)', { shell: true, stdio: 'pipe', timeout: 30000 });
      } catch {}
    }
  }

  if (!tools.astgrep.installed) {
    console.log('  Installing ast-grep...');
    if (os === 'darwin') {
      try { execSync('brew install ast-grep', { stdio: 'inherit' }); ok('ast-grep (brew)'); }
      catch { execSync('cargo install ast-grep --locked', { stdio: 'inherit' }); ok('ast-grep (cargo)'); }
    } else if (os === 'linux') {
      // Try npm package (cross-platform, no cargo needed), then GitHub release, then cargo
      try {
        execSync('npm install -g @ast-grep/cli', { stdio: 'inherit' });
        ok('ast-grep (npm)');
      } catch {
        try { execSync('cargo install ast-grep --locked', { stdio: 'inherit' }); ok('ast-grep (cargo)'); }
        catch { warn('ast-grep install failed — install manually: npm install -g @ast-grep/cli'); }
      }
    } else {
      // Windows: no cargo by default — use npm
      try { execSync('npm install -g @ast-grep/cli', { stdio: 'inherit' }); ok('ast-grep (npm)'); }
      catch { warn('ast-grep install failed — install manually: npm install -g @ast-grep/cli'); }
    }
  } else { skip(`ast-grep (${tools.astgrep.version})`); }

  if (copilotHudEnabled && copilot) {
    // jq is only needed by copilot-hud's POSIX shell hooks — not on Windows.
    // On Windows, skip the check entirely. On Mac/Linux, try to auto-install.
    let jqOk = os === 'windows';
    if (!jqOk) {
      jqOk = Boolean(await which('jq'));
      if (!jqOk) {
        if (os === 'darwin') {
          console.log('  Installing jq (required by copilot-hud)...');
          try { execSync('brew install jq', { stdio: 'inherit' }); jqOk = true; ok('jq'); }
          catch { warn('jq install failed — install manually: brew install jq'); }
        } else {
          warn('copilot-hud requires jq — install it (e.g. sudo apt-get install jq) then re-run');
        }
      }
    }
    if (jqOk) {
      const copilotPath = await which('copilot');
      if (!copilotPath) {
        warn('copilot-hud requested but Copilot CLI not found — skipping');
      } else {
        const copilotHud = await detectCopilotHud();
        if (copilotHud.installed) {
          skip(`copilot-hud (${copilotHud.version ?? 'installed'})`);
        } else {
          console.log('  Installing copilot-hud...');
          try {
            execSync('copilot plugin marketplace add griches/copilot-hud', { stdio: 'inherit' });
          } catch {
            warn('copilot-hud marketplace add failed — attempting install anyway');
          }
          try {
            execSync('copilot plugin install copilot-hud@copilot-hud', { stdio: 'inherit' });
            ok('copilot-hud installed');
            console.log('  Next: run `copilot --experimental`, then `/copilot-hud:setup` once inside the session.');
          } catch {
            warn('copilot-hud install failed — install manually: copilot plugin marketplace add griches/copilot-hud && copilot plugin install copilot-hud@copilot-hud');
          }
        }
      }
    }
  } else if (copilotHudEnabled && !copilot) {
    skip('copilot-hud skipped (--claude-only)');
  }

  if (tokenOptimizerEnabled && copilot) {
    installTokenOptimizerForCopilot({
      os,
      exec: (command, options = {}) => execSync(command, { stdio: 'inherit', ...options }),
      execFile: (file, args, options = {}) => execFileSync(file, args, { stdio: 'inherit', ...options }),
      log: (message = '') => console.log(`  ${message}`),
      warn,
    });
    // The external installer writes an unguarded python-bridge preToolUse hook;
    // make it fail-open so a bridge/python failure can't fail-CLOSE bash tool
    // calls. See src/tools/hook-safety.mjs.
    try {
      if (hardenCopilotTokenOptimizerHook({ home }).action === 'hardened') {
        ok('~/.copilot/hooks/token-optimizer.json (fail-open guard)');
      }
    } catch { /* never fail install over defensive hardening */ }
  } else if (tokenOptimizerEnabled && !copilot) {
    skip('token-optimizer Copilot install skipped (--claude-only)');
  }

  if (tokenOptimizerEnabled && claudeCC) {
    warn(tokenOptimizerLicenseNotice());
    console.log(`  ${tokenOptimizerClaudeCodeInstructions().replace(/\n/g, '\n  ')}`);
  } else if (tokenOptimizerEnabled && !claudeCC) {
    skip('token-optimizer Claude Code instructions skipped (--copilot-only)');
  }

  // LiteLLM budget routing (opt-in)
  if (existingCfg.budget_routing?.litellm) {
    step('LiteLLM budget router...');
    try {
      ensureManagedVenv(venv);
      installPipPackageInManagedVenv(venv, 'litellm[proxy]>=1.92');
      const { generateLiteLLMConfig, liteLLMConfigPath } = await import('./service/litellm-service.mjs');
      const cfgPath = liteLLMConfigPath(home);
      const litellmPort = existingCfg.budget_routing?.litellm_port ?? 4000;
      // LiteLLM talks to an upstream provider directly, so it needs its own
      // explicit API base. Copilot-Headroom does not expose provider URL config:
      // it loops back through mitmproxy and restores the original destination.
      const apiBase = existingCfg.budget_routing?.api_base?.trim() || '';
      if (!apiBase) {
        warn(
          'litellm enabled but budget_routing.api_base is empty. ' +
          'Set it via `myelin config set budget_routing.api_base https://api.githubcopilot.com` ' +
          '(or https://api.business.githubcopilot.com for Business/Enterprise) and re-run — writing config anyway; litellm will fail to start until this is set.'
        );
      }
      const content = generateLiteLLMConfig({
        headroomPort: existingCfg.proxy?.headroom?.port ?? 8787,
        litellmPort,
        cheapModel: existingCfg.budget_routing?.cheap_model ?? 'claude-haiku-4-5',
        complexModel: existingCfg.budget_routing?.complex_model ?? 'claude-sonnet-4-6',
        apiBase,
      });
      writeFileSync(cfgPath, content, 'utf8');
      ok(`litellm config written → ${cfgPath}`);
      ok(`LiteLLM will listen on :${litellmPort}. To route Claude Code through it, use the _claude wrapper with headroom_port set to ${litellmPort} (never set ANTHROPIC_BASE_URL globally — see _claude wrapper in src/service/wrappers.mjs).`);
    } catch (e) {
      warn(`litellm install failed: ${e.message.split('\n')[0]}`);
    }
  }

  if (codegraphEnabled) {
    if (codegraphReady) {
      skip(`codegraph (${tools.codegraph.version})`);
    } else if (!isVersionAtLeast(tools.node.version ?? '', '22.12.0')) {
      warn('codegraph skipped — @optave/codegraph currently requires Node >=22.12.0 upstream (Myelin itself requires only >=20)');
    } else {
      console.log('  Installing codegraph...');
      try {
        execSync('npm install -g @optave/codegraph', { stdio: 'inherit' });
        ok('codegraph installed');
        codegraphReady = true;
      } catch {
        warn('codegraph install failed — install manually: npm install -g @optave/codegraph');
      }
    }
  }

  } else {
    skip('code-discovery tools (managed components provisioned by staged release)');
  }

  // 3. Proxy backbone
  step('[3/7] Proxy backbone...');
  assertInstallMutationFence();
  if (installsPythonHeadroomPackage) {
    if (!tools.headroom.installed && runGlobalComponentInstalls) {
      console.log('  Installing headroom...');
      ensureManagedVenv(venv);
      // execFileSync passes the spec as a literal argv element, so the `[all]`
      // extras marker is never shell-globbed on any platform — no per-OS quoting.
      installPipPackageInManagedVenv(venv, HEADROOM_AI_SPEC);
      ok('headroom installed (headroom-ai from PyPI)');
    } else {
      skip(`headroom (${tools.headroom.version})`);
    }
  } else if (!flags['no-headroom']) {
    skip('headroom install skipped (proxy.engine=headroom_lite)');
  }

  // Build combined CA bundle: root CA + intermediate CA extracted from live TLS chain
  // This is required when a corporate SSL interceptor (e.g. NetFree/Hot) uses an intermediate
  // CA that isn't in the system trust store. We extract it from the live connection.
  const combinedCert = flags['update-apply']
    ? null
    : await buildCombinedCaCert(caBundles[0]?.path ?? null, home, { force: didMigrate });
  if (combinedCert && combinedCert !== caBundles[0]?.path) {
    // Update sslEnv to point to the combined cert
    Object.keys(sslEnv).forEach(k => { sslEnv[k] = combinedCert; });
    ok(`Combined CA cert built → ${combinedCert}`);
  }

  if (!flags['no-rtk']) {
    if (!tools.rtk.installed && runGlobalComponentInstalls) {
      console.log('  Installing RTK...');
      await installRtk(os);
      tools.rtk = await detectRtk();
    } else if (!tools.rtk.installed) {
      skip('rtk (managed component provisioned by staged release)');
    } else {
      skip(`rtk (${tools.rtk.version})`);
    }
    const rtkVersionWarning = getRtkVersionWarning(tools.rtk);
    if (rtkVersionWarning) warn(rtkVersionWarning);
  }

  // mitmproxy — install binary + generate CA + append CA to PEM bundles
  const mitmEnabled = existingCfg?.proxy?.mitm?.enabled !== false;
  let mitmdumpBin = null;
  if (flags['update-apply']) {
    // Staged apply: resolve the pinned managed mitmproxy binary provisioned by
    // the release transaction. Never install or touch a global mitmproxy.
    if (mitmEnabled) {
      mitmdumpBin = resolveManagedMitmBinary({
        componentsRoot: updatePaths(home).componentsRoot,
        platform: resolveInstallComponentStoragePlatform(os),
      }).binPath;
    }
  } else if (!mitmEnabled) {
    // proxy.mitm.enabled=false → no binary needed
  } else {
    mitmdumpBin ??= await ensureMitmproxy(os, { installIfMissing: runGlobalComponentInstalls });
  }
  if (!mitmEnabled) {
    skip('mitmproxy setup skipped (proxy.mitm.enabled=false)');
  } else if (flags['update-apply']) {
    // Staged apply reuses the CA trust bundle already provisioned by the release
    // transaction; it must never regenerate or append to global CA bundles.
    if (mitmdumpBin) ok('mitmproxy ready (managed release binary)');
    else warn('managed mitmproxy binary missing from staged release');
  } else if (mitmdumpBin) {
    await ensureMitmCA(home, mitmdumpBin);
    // non-interactive when --yes: auto-append CA to bundle without prompting
    await installMitmproxyCA(home, !flags['yes']);
    ok('mitmproxy ready');
  } else {
    warn('mitmproxy not available — Copilot compression disabled');
  }

  // 4. Service
  if (!flags['no-headroom'] && flags.profile === 'proxy') {
    step('[4/7] Background service...');
    assertInstallMutationFence();
    const loadedCfg = await loadConfig(DEFAULT_CONFIG_PATH);
    const cfg = selectedInstallEngine === 'headroom' && port !== (loadedCfg.proxy?.headroom?.port ?? 8787)
      ? {
        ...loadedCfg,
        proxy: {
          ...loadedCfg.proxy,
          headroom: { ...loadedCfg.proxy?.headroom, port },
        },
      }
      : loadedCfg;
    const enginePlan = buildEngineInstancePlan(cfg);
    const primaryInstance = enginePlan.instances.find(({ role }) => role === 'primary');
    // Staged apply (--update-apply) binds the pinned managed compression binary
    // provisioned by the release transaction instead of a global install. When
    // compression is disabled no compression binary is resolved or staged.
    const managedCompressionBin = resolveStagedCompressionBinary({
      updateApply: flags['update-apply'],
      cfg,
      componentsRoot: transactionPaths.componentsRoot,
      platform: resolveInstallComponentStoragePlatform(os),
    });
    const binPath = enginePlan.engine === 'headroom' ? headroomBinPath() : undefined;
    const envVars = { ...(primaryInstance ? { HEADROOM_PORT: String(primaryInstance.port) } : {}), ...sslEnv };
    const windowsServiceCfg = cfg.proxy?.windows_service ?? {};
    const winManager = windowsServiceCfg.manager ?? 'registry';
    if (corpProxy) envVars.HTTPS_PROXY = corpProxy;
    envVars.OPENAI_TARGET_API_URL = cfg.proxy.headroom.openai_target_url ?? 'https://api.githubcopilot.com';
    envVars.HEADROOM_MODE = cfg.proxy.headroom.mode ?? 'cache';
    const installPlan = await applyServiceEngineInstallPlan({
      enginePlan,
      cfg,
      os,
      winManager,
      home,
      headroomBin: binPath,
      managedCompressionBin,
      skipObsoleteCleanup: flags['update-apply'],
      envVars,
      warnFn: warn,
    });
    selectedInstallEngine = installPlan.selectedInstallEngine;
    selectedProxyPort = installPlan.selectedProxyPort;
    const downstreamProxyInstallOpts = buildDownstreamProxyServiceInstallOptions({
      cfg,
      os,
      home,
      mitmdumpBin,
      sslEnv,
      corpProxy,
      winManager,
      installPlan,
    });

    // mitmproxy service on port 8888 — intercepts Copilot TLS for compression
    try {
      const mitmResult = await applyMitmServiceInstallPlan({
        cfg,
        os,
        home,
        winManager,
        mitmOpts: downstreamProxyInstallOpts.mitmOpts,
      });
      if (mitmResult.installed) {
        const mitmOpts = downstreamProxyInstallOpts.mitmOpts;
        ok(`mitmproxy service registered (port ${mitmOpts.port}${mitmOpts.egressPort ? ` + egress ${mitmOpts.egressPort}` : ''})`);
      }
      if (mitmResult.removed) ok('disabled mitmproxy service registration removed');
    } catch (e) {
      warn(`mitmproxy service registration failed: ${e.message}`);
    }

    // Watchdog: macOS uses a launchd poller; Windows can opt into a
    // Scheduled Task health checker for the same second-layer recovery role
    // — only meaningful once windows_service.manager is 'winsw' (there's no
    // WinSW service for a registry-based install's watchdog to restart).
    try {
      const { installWatchdog } = await import('./service/index.mjs');
      const installed = await installWatchdog(downstreamProxyInstallOpts.watchdogOpts);
      if (installed) {
        const cadence = os === 'windows'
          ? `every ${downstreamProxyInstallOpts.watchdogOpts.intervalMinutes} minute${downstreamProxyInstallOpts.watchdogOpts.intervalMinutes === 1 ? '' : 's'}`
          : 'every 90s';
        ok(`watchdog installed — auto-revives dropped services ${cadence}`);
      }
    } catch (e) {
      warn(`watchdog install failed: ${e.message}`);
    }
  } else {
    step('[4/7] Service: skipped');
  }

  // 5. Config files
  step('[5/7] Configuration files...');
  assertInstallMutationFence();

  // ~/.myelin/config.yaml
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    await writeConfig(mergeDeep(DEFAULT_CONFIG, {
      proxy: { headroom: { port, corporate_proxy: corpProxy } },
      index_tier: flags['index-tier'],
    }), DEFAULT_CONFIG_PATH);
    ok(`config.yaml created`);
  } else { skip('config.yaml already exists'); }

  // Claude Code settings.json
  // Resolve tool binary paths at install time — needed for Windows where PATH isn't set when Copilot spawns MCPs
  const toolPaths = {};
  for (const t of ['serena', 'semble', 'uvx', ...(codegraphReady ? ['codegraph'] : [])]) {
    try {
      const p = execSync(os === 'windows' ? `where.exe ${t}` : `which ${t}`, { stdio: 'pipe' })
        .toString().trim().split('\n')[0].trim();
      toolPaths[t] = p || t;
    } catch { toolPaths[t] = t; }
  }

  // Write serena wrapper that detects git root from CWD at spawn time
  const serenaWrapper = writeSerenaWrapper(home, toolPaths.serena);
  toolPaths.serenaWrapper = serenaWrapper;
  if (codegraphReady) {
    toolPaths.codegraphWrapper = writeCodegraphWrapper(home, toolPaths.codegraph);
  }

  const memoryFile = joinManaged(managed.root, 'memory.jsonl');
  const gitExtraEnabled = existingCfg.code_discovery?.mcp_git_extra !== false;
  const gitExtraServer = gitExtraEnabled
    ? {
        command: os === 'windows' ? 'python' : 'python3',
        args: [runtimeBridge.gitExtraPath],
      }
    : undefined;

  const claudeMcpServers = {
    serena: { command: serenaWrapper, args: [] },
    semble: { command: toolPaths.semble, args: [] },
    // Explicit `undefined` (not a conditional spread) so a previously-written
    // entry gets actively removed by mergeJsonFile once codegraph is
    // disabled again — see codegraphReady comment above.
    codegraph: toolPaths.codegraphWrapper ? { command: toolPaths.codegraphWrapper, args: [] } : undefined,
    'mcp-git': { command: toolPaths.uvx, args: ['mcp-server-git'] },
    'git-extra': gitExtraServer,
    memory: { command: 'npx', args: ['-y', '--registry', 'https://registry.npmjs.org', '@modelcontextprotocol/server-memory'], env: { MEMORY_FILE_PATH: memoryFile } },
    cairn: { command: toolPaths.uvx, args: ['--python', '3.12', 'agentcairn'] },
  };

  const copilotMcpServers = {
    serena: { type: 'local', command: serenaWrapper, args: [], env: {}, tools: ['*'] },
    semble: { type: 'local', command: toolPaths.semble, args: [], env: {}, tools: ['*'] },
    codegraph: toolPaths.codegraphWrapper ? { type: 'local', command: toolPaths.codegraphWrapper, args: [], env: {}, tools: ['*'] } : undefined,
    'mcp-git': { type: 'local', command: toolPaths.uvx, args: ['mcp-server-git'], env: {}, tools: ['*'] },
    'git-extra': gitExtraServer ? { type: 'local', ...gitExtraServer, env: {}, tools: ['*'] } : undefined,
    memory: { type: 'local', command: 'npx', args: ['-y', '--registry', 'https://registry.npmjs.org', '@modelcontextprotocol/server-memory'], env: { MEMORY_FILE_PATH: memoryFile }, tools: ['*'] },
    cairn: { type: 'local', command: toolPaths.uvx, args: ['--python', '3.12', 'agentcairn'], env: {}, tools: ['*'] },
  };

  if (claudeCC) {
    mergeJsonFile(join(home, '.claude', 'settings.json'), {
      env: {
        ...resolveClaudeProxyEnv(selectedProxyPort),
        ENABLE_PROMPT_CACHING_1H: '1',
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50',
        CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-4-6',
        ...sslEnv,
      },
      mcpServers: claudeMcpServers,
    }, {});
    ok('~/.claude/settings.json (MCPs + proxy env)');
  }

  // Copilot CLI mcp-config.json
  if (copilot) {
    const mcp = join(home, '.copilot', 'mcp-config.json');
    if (existsSync(mcp)) {
      mergeJsonFile(mcp, { mcpServers: copilotMcpServers });
      ok('~/.copilot/mcp-config.json (MCPs)');
    } else { skip('~/.copilot/mcp-config.json not found'); }
  }

  // CLAUDE.md managed section
  let installCfg = await loadConfig(DEFAULT_CONFIG_PATH);

  if (claudeCC) {
    const claudeBlock = renderManagedBlock({
      target: 'global',
      provider: 'claude',
      model: installCfg.copilot?.model,
      cfg: installCfg,
      extraSections: [`## Session\n- /compact when context > 50%.${selectedProxyPort != null ? ` Headroom proxy on port ${selectedProxyPort}.` : ' Compression backend disabled — Claude runs unproxied.'}`],
    });
    writeManagedSection(join(home, '.claude', 'CLAUDE.md'), `\n${claudeBlock}`);
    ok('~/.claude/CLAUDE.md managed section');
  }

  const rtkEnabledInConfig = installCfg.shell_compression?.rtk !== false;
  if (!flags['no-rtk'] && rtkEnabledInConfig && tools.rtk.installed) {
    const rtkInitPlans = [];
    const copilotMcpPath = join(home, '.copilot', 'mcp-config.json');
    if (copilot && existsSync(copilotMcpPath)) {
      rtkInitPlans.push({
        label: 'Copilot',
        args: ['init', '--global', '--copilot', '--auto-patch'],
      });
    }
    if (claudeCC) {
      // Plain `rtk init -g` defaults to "N" for settings.json patching in
      // non-interactive installs, so use --auto-patch to ensure hook wiring.
      rtkInitPlans.push({
        label: 'Claude Code',
        args: ['init', '--global', '--auto-patch'],
      });
    }
    // RTK 0.43.0 exposes no subcommand-level rewrite exclusions via `init`,
    // `hook`, `rewrite`, or the generated filters template, so we keep broad
    // shell rewrites even when Headroom intercept_tool_results is enabled.
    for (const plan of rtkInitPlans) {
      const result = runRtkInit(plan.args);
      if (result.ok) {
        ok(`rtk ${plan.args.slice(1).join(' ')} (${plan.label})`);
      } else {
        const summary = result.error || result.output.split('\n').filter(Boolean).at(-1) || `exit ${result.status}`;
        warn(`rtk ${plan.args.slice(1).join(' ')} (${plan.label}) failed: ${summary}`);
      }
    }
    // Intentionally do not auto-run `rtk trust`: project-local .rtk/filters.toml
    // must remain explicit opt-in.
  } else if (!flags['no-rtk'] && !rtkEnabledInConfig) {
    skip('rtk hook wiring disabled by shell_compression.rtk=false');
  }

  // The global RTK Copilot hook MUST be fail-open. `rtk init --copilot` writes a
  // raw `rtk hook copilot` preToolUse hook, which fail-CLOSES every tool call in
  // every session when rtk isn't on Copilot's hook PATH (the Windows brick).
  // Replace it with a guarded, always-exit-0 wrapper (or remove it if RTK is
  // off) — this also heals machines a previous install already bricked. See
  // src/cli/rtk-guard.mjs.
  if (copilot) {
    try {
      const rtkActive = !flags['no-rtk'] && rtkEnabledInConfig && tools.rtk.installed;
      const res = ensureSafeRtkCopilotHook({
        home,
        nodePath: process.execPath,
        repoRoot: runtimeBridge.root,
        mode: rtkActive ? 'active' : 'inactive',
      });
      if (res.action === 'wrote-guarded') ok('~/.copilot/hooks/rtk-rewrite.json (fail-open guard)');
      else if (res.action === 'removed-unsafe') ok('removed unsafe RTK Copilot hook (RTK disabled)');
    } catch (e) {
      warn(`could not secure RTK Copilot hook: ${e.message.split('\n')[0]}`);
    }
  }

  // Slash commands — lets `myelin init` be re-run from inside a live agent
  // chat session (e.g. after pulling repo updates) without dropping to a
  // shell. Copilot CLI: global skill folder (~/.copilot/skills/<name>/SKILL.md,
  // invoked as /myelin-init — skill names are flat, no ':' namespacing).
  // Claude Code: global command file under a `myelin/` subdirectory, which
  // Claude Code treats as a namespace (invoked as /myelin:init).
  {
    const initSkillBody = `# Myelin Init

Run the Myelin installer's init command to (re)configure the token-efficiency
stack (Serena + Semble registration/indexing for the current git repo).

## Instructions

1. Run \`myelin init $ARGUMENTS\` via the terminal/Bash tool. If the \`myelin\`
   alias isn't on PATH yet in this session, fall back to
   \`"${managedRuntime.commandPath}" init $ARGUMENTS\`.
2. Stream the command's output back to the user.
3. If it reports warnings or failures, summarize them clearly and suggest
   \`myelin verify\` as a follow-up health check.
4. Do not pass \`--yes\`/\`--recursive\` unless the user explicitly asked for
   auto-accept or a recursive multi-repo init.
`;
    if (copilot) {
      const skillDir = join(home, '.copilot', 'skills', 'myelin-init');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: myelin-init
description: Runs \`myelin init\` to initialize or refresh the Myelin token-efficiency stack (Serena + Semble) for the current repo.
argument-hint: "[--yes] [--recursive] [--depth <n>]"
---

${initSkillBody}`);
      ok('~/.copilot/skills/myelin-init (invoke: /myelin-init)');
    }
    if (claudeCC) {
      const cmdDir = join(home, '.claude', 'commands', 'myelin');
      mkdirSync(cmdDir, { recursive: true });
      writeFileSync(join(cmdDir, 'init.md'), `---
description: Runs \`myelin init\` to initialize or refresh the Myelin token-efficiency stack (Serena + Semble) for the current repo.
argument-hint: [--yes] [--recursive] [--depth <n>]
allowed-tools: [Bash]
---

${initSkillBody}`);
      ok('~/.claude/commands/myelin/init.md (invoke: /myelin:init)');
    }
  }

  // Myelin skills — myelin-compact and myelin-constitution
  installCopilotSkills({
    home,
    copilot,
    repoRoot: runtimeBridge.root,
    managedRuntimeCommandPath: managedRuntime.commandPath,
    os,
  });

  // Shell profile
  const profilePath = shellProfilePath(os, shell);
  if (profilePath) {
    if (os === 'windows') mkdirSync(join(profilePath, '..'), { recursive: true });
    const existing = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : '';
    const certLines = Object.entries(sslEnv)
      .map(([k, v]) => `export ${k}=${posixSingleQuote(v)}`)
      .join('\n');
    const certBlock = certLines ? `\n${certLines}` : '';
    const copilotAlias = buildCopilotWrapper({ os });
    const claudeAlias = buildClaudeWrapper({ os, headroomPort: selectedProxyPort });
    const myelinCmd = managedMyelinCommandLine({ os, commandPath: managedRuntime.commandPath });
    const profilePathBlock = managedProfilePathBlock({ os, home });
    const extraPath = profilePathBlock.posixExport;
    const myelinDirExport = profilePathBlock.posixMyelinDirExport;

    // On Windows, add key bin dirs to process.env.PATH now so tool invocations work
    if (os === 'windows') {
      const winPaths = [
        join(home, '.local', 'bin'),
        managed.binDir,
        join(home, 'AppData', 'Roaming', 'uv', 'bin'),
        join(home, 'AppData', 'Local', 'uv', 'bin'),
        join(home, 'AppData', 'Roaming', 'npm'),
        join(home, 'AppData', 'Roaming', 'Python', 'Scripts'),
        ...[...Array(8)].map((_, i) => join(home, 'AppData', 'Roaming', 'Python', `Python3${10+i}`, 'Scripts')),
        ...[...Array(8)].map((_, i) => join(home, 'AppData', 'Local', 'Programs', 'Python', `Python3${10+i}`, 'Scripts')),
      ];
      for (const p of winPaths) {
        if (!process.env.PATH?.includes(p)) process.env.PATH = p + ';' + process.env.PATH;
      }
      // Also add node.exe's own directory (covers nvm4w, portable node)
      const nodeDir = join(process.execPath, '..');
      if (!process.env.PATH?.includes(nodeDir)) process.env.PATH = nodeDir + ';' + process.env.PATH;
    }
    let block;
    if (os === 'windows') {
      // NOTE: provider-specific env vars (ANTHROPIC_BASE_URL, HTTPS_PROXY) are
      // deliberately NOT set in $PROFILE — they live only inside the _copilot
      // and _claude wrappers so they can't cross-contaminate each other.
      const psEnv = selectedProxyPort != null ? `$env:HEADROOM_PORT = "${selectedProxyPort}"` : '';
      // Only a genuinely relocated root persists $env:MYELIN_DIR (escaped,
      // native Windows form) so a new PowerShell session resolves the same
      // managed root the baked-in PATH points at. A default install emits none.
      const psMyelinDir = profilePathBlock.windowsMyelinDirExport
        ? `${profilePathBlock.windowsMyelinDirExport}\n`
        : '';
      const psCert = Object.entries(sslEnv).map(([k, v]) => `$env:${k} = ${powershellSingleQuote(v)}`).join('\n');
      const psPaths = renderWindowsProfilePathLines(profilePathBlock.windowsPathDirs);
      block = `\n# >>> myelin managed >>>\n${psEnv}\n${psMyelinDir}${psCert}\n${psPaths}\n${myelinCmd}\n${copilotAlias}\n${claudeAlias}\n# <<< myelin managed <<<\n`;
    } else {
      // NOTE: no ANTHROPIC_BASE_URL export — see _claude wrapper below. When the
      // backend is disabled (selectedProxyPort == null) HEADROOM_PORT is omitted
      // entirely so nothing points at a nonexistent proxy.
      const headroomExport = selectedProxyPort != null ? `export HEADROOM_PORT=${selectedProxyPort}` : '';
      block = `\n# >>> myelin managed >>>\n${headroomExport}${myelinDirExport}${certBlock}${extraPath}\n${myelinCmd}\n${copilotAlias}\n${claudeAlias}\n# <<< myelin managed <<<\n`;
    }
    const updated = existing.includes('myelin managed')
      ? existing.replace(/\n?# >>> myelin managed >>>[\s\S]*?# <<< myelin managed <<<\n?/, block)
      : existing + block;
    if (updated !== existing) {
      writeFileSync(profilePath, updated, 'utf8');
      ok(`${profilePath} (proxy, alias${certLines ? ', CA bundle env vars' : ''}, PATH, _copilot + _claude wrappers)`);
      if (os === 'windows') {
        const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
        if (installWindowsAutoloadModule(appData, profilePath)) {
          ok('PowerShell module autoload registered (myelin/_copilot/_claude load in new windows)');
        } else {
          warn('Could not register PowerShell autoload module — run manually: Import-Module MyelinAutoload');
        }
      }
    } else {
      skip(`${profilePath} already configured`);
      if (os === 'windows') {
        const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
        const moduleFile = join(appData, 'Microsoft', 'Windows', 'PowerShell', 'Modules', 'MyelinAutoload', 'MyelinAutoload.psm1');
        if (!existsSync(moduleFile)) {
          if (installWindowsAutoloadModule(appData, profilePath)) {
            ok('PowerShell module autoload registered (myelin/_copilot/_claude load in new windows)');
          } else {
            warn('Could not register PowerShell autoload module — run manually: Import-Module MyelinAutoload');
          }
        }
      }
    }
  }

  // Global bin — expose `myelin` via npm's own bin-linking mechanism
  // (package.json's "bin" field), the standard way to ship a Node CLI,
  // additionally to the shell alias/function above. Still just executes
  // the same source files (no bundling), so self-update via `git pull`
  // keeps working unchanged. Gracefully skipped if the npm global bin dir
  // isn't writable (some corp machines) — the shell alias/PS module above
  // remains the reliable baseline either way.
  {
    const linkResult = linkGlobalBin({ home, os });
    if (linkResult.linked) {
      ok(`myelin linked globally via npm (${linkResult.binDir})`);
    } else {
      skip(`npm global bin link skipped (${linkResult.reason}) — using shell alias only`);
    }
  }

  // Windows: additionally persist env vars to the registry (HKCU\Environment)
  // so new windows opened from Explorer (Start Menu, taskbar) pick them up
  // immediately, even before any $PROFILE-equivalent runs — verified live
  // that Explorer-spawned processes see this, unlike SSH-spawned ones,
  // which cache their own session environment separately. Purely additive:
  // the PowerShell module above remains the primary, proven mechanism.
  //
  // CRITICAL: DO NOT add provider-specific env vars (ANTHROPIC_BASE_URL,
  // HTTPS_PROXY, ENABLE_PROMPT_CACHING_1H) to this registry map. Anything
  // set here is global to every Windows process — including Copilot CLI,
  // which respects ANTHROPIC_BASE_URL via its embedded Anthropic SDK when
  // routing Claude models. Global ANTHROPIC_BASE_URL made Copilot bypass
  // mitmproxy and hit api.anthropic.com directly (blocked by network
  // filters → 418). Provider env vars live only in _copilot / _claude
  // wrappers so they can't cross-contaminate.
  if (os === 'windows') {
    const _winCfg = await loadConfig(DEFAULT_CONFIG_PATH);
    const interceptEnabled = _winCfg.proxy?.headroom?.intercept_tool_results !== false;
    const registryVars = {
      ...(selectedProxyPort != null ? { HEADROOM_PORT: String(selectedProxyPort) } : {}),
      // Use env var instead of --intercept-tool-results CLI flag to avoid startup hang:
      // the flag triggers ensure_tools() which downloads ast-grep and blocks in restricted networks.
      ...(interceptEnabled ? { HEADROOM_INTERCEPT_ENABLED: '1' } : {}),
      // Persist the NATIVE Windows form of a relocated MYELIN_DIR so new
      // Explorer-spawned windows resolve the same managed root. Under WSL the
      // running process sees a mounted `/mnt/<drive>/…` path; the registry (a
      // Windows-native store) must carry `<Drive>:\…`, never the raw POSIX mount
      // path. Only a genuinely relocated root is persisted — a default install
      // leaves MYELIN_DIR unset so services fall back to `~/.myelin`.
      ...managedRegistryMyelinDirVar({ os, home, env: process.env }),
      ...sslEnv,
    };
    if (setUserEnvVars(registryVars)) {
      ok('Env vars persisted to registry (new windows pick them up without $PROFILE)');
    } else {
      warn('Could not persist env vars to registry — relying on PowerShell module only');
    }
    // P3: clean up stale OPENAI_TARGET_URL left by old myelin versions (was
    // incorrectly set to http://127.0.0.1:8787 — circular — instead of the
    // correct upstream URL). Only remove if it points at localhost.
    try {
      execSync(
        String.raw`powershell -Command "$v = [Environment]::GetEnvironmentVariable('OPENAI_TARGET_URL','User'); if ($v -and $v -like '*127.0.0.1*') { [Environment]::SetEnvironmentVariable('OPENAI_TARGET_URL', $null, 'User'); Write-Host '[myelin] removed stale OPENAI_TARGET_URL' }"`,
        { stdio: 'inherit' }
      );
    } catch {}
    // Clean up stale OPENAI_TARGET_API_URL from prior installs. Provider target
    // URLs belong only to the specific service process that needs them, never
    // in the global User environment where Copilot CLI could inherit them.
    try {
      execSync(
        String.raw`powershell -Command "$v = [Environment]::GetEnvironmentVariable('OPENAI_TARGET_API_URL','User'); if ($v) { [Environment]::SetEnvironmentVariable('OPENAI_TARGET_API_URL', $null, 'User'); Write-Host '[myelin] removed stale OPENAI_TARGET_API_URL User env' }"`,
        { stdio: 'inherit' }
      );
    } catch {}
    // Clean up stale ANTHROPIC_BASE_URL from prior myelin installs — earlier
    // versions persisted it here globally, which made Copilot CLI bypass
    // mitmproxy. It now lives only inside the _claude wrapper.
    try {
      execSync(
        String.raw`powershell -Command "$v = [Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL','User'); if ($v -and $v -like '*127.0.0.1*') { [Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $null, 'User'); Write-Host '[myelin] removed stale ANTHROPIC_BASE_URL User env (Copilot must go through HTTPS_PROXY -> mitmproxy; Claude uses _claude wrapper)' }"`,
        { stdio: 'inherit' }
      );
    } catch {}
  }

  // 6. Hooks
  if (claudeCC) {
    step('[6/7] Hooks: managed per-project by `myelin init`');
  } else { step('[6/7] Hooks: skipped (--copilot-only)'); }

  // 7. Summary
  step('[7/7] Complete! \ud83e\uddec\n' + '\u2500'.repeat(55));
  console.log(`  Headroom port: ${selectedProxyPort ?? 'disabled (unproxied)'}`);
  console.log(`  Mitmproxy:     8888  (Copilot compression + cache)`);
  if (selectedInstallEngine === 'headroom') {
    console.log(`  Headroom:      ${headroomBinPath()}`);
  } else {
    console.log('  Headroom:      headroom-lite');
  }
  console.log(`  Config:        ${DEFAULT_CONFIG_PATH}`);
  if (caBundles.length) console.log(`  Corporate SSL: ${caBundles[0].path}`);
  console.log('\n  myelin verify          \u2192 health check');
  console.log('  myelin config show     \u2192 view settings');
  console.log('  myelin update --check  \u2192 available updates');
  console.log('\u2500'.repeat(55) + '\n');
  _closeRL();

  // Reload shell profiles in all open terminals
  const { runReload } = await import('./cli/reload.mjs');
  await runReload();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(e => { _closeRL(); console.error(e); process.exit(1); });
}
