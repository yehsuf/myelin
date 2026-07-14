import { detectAll } from '../detect/tools.mjs';
import { execSync, spawnSync } from 'node:child_process';
import { detectOS, powerShellExecutable } from '../detect/os.mjs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_CONFIG_PATH, readUserConfig } from '../config/reader.mjs';
import { DEFAULT_CONFIG, listUnknownKeyPaths } from '../config/schema.mjs';
import { stageMainRuntime } from '../runtime/stage-main.mjs';
import { writeManagedLauncher } from '../runtime/launcher.mjs';
import { managedHeadroomPidPath } from '../service/windows.mjs';
import { managedPaths, joinManaged, resolveMyelinRoot, isManagedRootRelocated } from '../shared/myelin-paths.mjs';

const MANAGED_MAIN_REPO_URL = 'https://github.com/yehsuf/myelin';

function upgradeCommands(os, { home = homedir(), env = process.env } = {}) {
  // Resolve the managed venv through managedPaths so a relocated MYELIN_DIR is
  // honored — headroom lives in the managed root's venv, not a hardcoded
  // ~/.myelin/venv.
  const venv = managedPaths({ home, env, platform: os }).venvPath;
  return {
    uv:       { upgrade: 'uv self update' },
    // headroom installed via uv pip in venv, not uv tool
    headroom: { upgrade: `uv pip install --python "${venv}" --upgrade "headroom-ai[all]"` },
    // serena installed via uv tool as 'serena-agent'
    // No --python flag on upgrade: reuse whatever Python is in the existing env.
    // --python 3.12 is only used on fresh install (install.mjs) to avoid the
    // "Ignoring existing environment: interpreter mismatch" rebuild on every update.
    serena:   { upgrade: 'uv tool install --force "serena-agent @ git+https://github.com/oraios/serena.git"' },
    semble:   { upgrade: 'uv tool install --force "semble[mcp]"' },
    rtk: {
      upgrade: os === 'darwin' ? 'brew upgrade rtk'
             : os === 'windows' ? null   // GitHub release — handled separately
             : 'uv tool upgrade rtk',
    },
    astgrep: {
      upgrade: os === 'darwin' ? 'brew upgrade ast-grep'
             : os === 'windows' ? 'npm update -g @ast-grep/cli'
             : 'npm update -g @ast-grep/cli',
    },
  };
}

const _UPGRADE_STOP_PROCESS = {
  headroom: ['headroom'],
  serena: ['serena-agent'],
  semble: ['semble'],
};

/**
 * Resolve the persisted, Myelin-managed PID file for a tool whose file lock must
 * be released before a Windows in-place upgrade. Only `headroom` runs as a
 * Myelin-managed service with a PID we persisted and can verify ownership of;
 * `serena`/`semble` are `uv` tools with no managed PID file, so they return
 * `null` and {@link _stopForUpgrade} never touches a same-named process.
 */
function managedUpgradePidPath(name, { home } = {}) {
  return name === 'headroom' ? managedHeadroomPidPath({ home }) : null;
}

/**
 * Read a live process's command line / executable path / start time by PID via a
 * Win32_Process CIM query. Mirrors install.mjs `legacyProcessInfo` so the
 * ownership guard here matches the migration-shutdown guard exactly.
 */
function defaultUpgradeProcessInfo(pid, { execSyncFn = execSync, powershellExe } = {}) {
  try {
    const ps = powershellExe ?? powerShellExecutable({ windowsInterop: true });
    const script = [
      `$proc = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
      'if (-not $proc) { return }',
      '@{ command = $proc.CommandLine; executablePath = $proc.ExecutablePath; startTime = if ($proc.CreationDate) { $proc.CreationDate.ToString("o") } else { "" } } | ConvertTo-Json -Compress',
    ].join('; ');
    const out = execSyncFn(`${ps} -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().replace(/^\uFEFF/, '').trim();
    return out ? JSON.parse(out) : null;
  } catch {
    return null;
  }
}

/**
 * Ownership gate: only a LIVE process (StartTime present) whose command line or
 * executable path runs FROM the managed root is ours. A same-named process
 * installed elsewhere can never satisfy this, so it is left untouched. Mirrors
 * install.mjs `legacyManagedProcessIsOwned` / restart.mjs
 * `headroomLiteMatchesManagedPid`.
 */
function managedUpgradeProcessIsOwned(processInfo, managedRoot) {
  const needle = String(managedRoot ?? '').toLowerCase();
  if (!needle || !processInfo) return false;
  if (!processInfo.startTime) return false;
  return [processInfo.command, processInfo.executablePath].some((value) =>
    String(value ?? '').toLowerCase().includes(needle)
  );
}

function defaultStopUpgradePid(pid, { execSyncFn = execSync, powershellExe } = {}) {
  const ps = powershellExe ?? powerShellExecutable({ windowsInterop: true });
  // Stop strictly by PID — NEVER by process name.
  execSyncFn(`${ps} -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction Stop"`, { stdio: 'pipe' });
}

function readManagedUpgradePid(pidPath, { existsSyncFn = existsSync, readFileSyncFn = readFileSync } = {}) {
  try {
    if (!existsSyncFn(pidPath)) return null;
    const pid = Number(
      String(readFileSyncFn(pidPath, 'utf8') ?? '')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? '',
    );
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Release a managed tool's file lock before a Windows in-place upgrade WITHOUT
 * ever name-killing. It stops ONLY the Myelin-managed instance identified by our
 * persisted PID file, and only after verifying (StartTime + command-path)
 * ownership under the managed root. When no managed PID is found — the common
 * case for `serena`/`semble`, or a headroom that isn't running — it does
 * nothing, so a user's own unrelated same-named process is never killed.
 */
export function _stopForUpgrade(name, {
  home = homedir(),
  env = process.env,
  pidPathFn = managedUpgradePidPath,
  existsSyncFn = existsSync,
  readFileSyncFn = readFileSync,
  processInfoFn = defaultUpgradeProcessInfo,
  stopPidFn = defaultStopUpgradePid,
  managedRoot = resolveMyelinRoot({ home, env }),
} = {}) {
  if (!_UPGRADE_STOP_PROCESS[name]) return;
  const pidPath = pidPathFn(name, { home, env });
  if (!pidPath) return;

  const pid = readManagedUpgradePid(pidPath, { existsSyncFn, readFileSyncFn });
  if (!pid) return;

  let info = null;
  try { info = processInfoFn(pid); } catch { return; }
  if (!managedUpgradeProcessIsOwned(info, managedRoot)) return;

  try {
    stopPidFn(pid);
    const start = Date.now();
    while (Date.now() - start < 500) {}
  } catch {}
}

function repoDirFromMetaUrl(metaUrl = import.meta.url) {
  return join(dirname(fileURLToPath(metaUrl)), '..', '..');
}

export async function checkStaleConfigKeys({
  configPath = DEFAULT_CONFIG_PATH,
  warn = console.warn,
  existsSyncFn = existsSync,
  readUserConfigFn = readUserConfig,
  schema = DEFAULT_CONFIG,
} = {}) {
  if (!existsSyncFn(configPath)) return { exists: false, staleKeys: [] };

  const rawUserConfig = await readUserConfigFn(configPath, warn);
  const staleKeys = listUnknownKeyPaths(rawUserConfig, schema);
  if (staleKeys.length === 0) return { exists: true, staleKeys };

  warn(`ℹ Your ${configPath} has ${staleKeys.length} stale config key(s) no longer used by this version.`);
  warn('  Run: myelin config prune --dry-run to preview, or myelin config prune to clean them up.');
  return { exists: true, staleKeys };
}

export async function runUpdate(options = {}, deps = {}) {
  const { check = false } = options;
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  const os = deps.os ?? (deps.detectOSFn ?? detectOS)();
  const tools = await (deps.detectAllFn ?? detectAll)();
  const exec = deps.execSyncFn ?? execSync;
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const cmds = upgradeCommands(os, { home, env });
  const repoDir = repoDirFromMetaUrl();
  const installerCmd = `node "${join(repoDir, 'src', 'install.mjs')}" --yes`;
  log(`\nMyelin Update ${check ? '(dry-run)' : ''}\n${'─'.repeat(55)}`);
  for (const [name, r] of Object.entries(tools)) {
    const cmd = cmds[name];
    if (!cmd) continue;
    const icon = r.installed ? '↑' : '+';
    const label = name === 'headroom' ? 'headroom proxy' : name;
    const status = r.installed ? `${r.version ?? 'installed'}` : 'not installed';
    log(`  ${icon} ${label.padEnd(14)} ${status}`);
    if (!check) {
      if (!cmd.upgrade) { log(`    · no auto-update — reinstall: ${installerCmd}`); continue; }
      if (os === 'windows') _stopForUpgrade(name, { home, env });
      try { exec(cmd.upgrade, { stdio: 'inherit' }); log('    ✓ done'); }
      catch (e) {
        const msg = e?.message ?? String(e);
        const isLocked = /os error (32|5)|Access is denied|cannot access the file/i.test(msg);
        if (os === 'windows' && isLocked) {
          warn('    ✗ failed: file locked — close Claude Code / Copilot sessions and re-run: myelin update');
        } else {
          warn(`    ✗ failed: ${msg.split('\n')[0]}`);
        }
      }
    } else {
      log(`    → ${cmd.upgrade ?? '(manual)'}`);
    }
  }
  log('─'.repeat(55));
  if (check) {
    log('  Run without --check to apply updates.\n');
    log('  Run: myelin verify to confirm.\n');
  }
}

export function runManagedInstaller({
  runtimeRoot,
  args = ['--yes'],
  env = process.env,
  spawnSyncFn = spawnSync,
} = {}) {
  const installerPath = joinManaged(runtimeRoot, 'src', 'install.mjs');
  const result = spawnSyncFn(process.execPath, [installerPath, ...args], {
    stdio: 'inherit',
    env,
  });
  return { status: result?.status ?? 1 };
}

/**
 * The single public update entrypoint. It stages and activates the managed
 * main-channel runtime, re-runs the integration installer against the newly
 * activated runtime, reports stale config, upgrades external tools, and
 * restarts services.
 *
 * `--download-only` stages and validates a candidate but never activates it
 * (no launcher, installer, tool, or restart side effects). `--check` is a
 * non-mutating preview of external-tool updates only — it never stages or
 * activates a runtime.
 */
export async function runManagedUpdate({ downloadOnly = false, check = false } = {}, deps = {}) {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  const rootDir = deps.rootDir;
  const os = deps.os ?? (deps.detectOSFn ?? detectOS)();
  const repoUrl = deps.repoUrl ?? MANAGED_MAIN_REPO_URL;

  const stageMainRuntimeFn = deps.stageMainRuntimeFn ?? stageMainRuntime;
  const writeManagedLauncherFn = deps.writeManagedLauncherFn ?? writeManagedLauncher;
  const runInstallerFn = deps.runInstallerFn ?? runManagedInstaller;
  const checkStaleConfigKeysFn = deps.checkStaleConfigKeysFn ?? checkStaleConfigKeys;
  const runToolUpdatesFn = deps.runToolUpdatesFn
    ?? ((options) => runUpdate(options, { home, env, os, log, warn }));
  const runRestartFn = deps.runRestartFn ?? (async () => {
    const { runRestart } = await import('./restart.mjs');
    return runRestart();
  });

  // M2: `--check` and `--download-only` are mutually exclusive. `--check` is a
  // non-mutating external-tool preview that never stages a candidate, while
  // `--download-only` stages (but does not activate) one — combining them would
  // silently drop `--download-only`. Fail loudly instead of silently overriding.
  if (check && downloadOnly) {
    throw new Error(
      '`--check` and `--download-only` are mutually exclusive: `--check` only previews '
      + 'external-tool updates (no staging), while `--download-only` stages a candidate. '
      + 'Run one at a time.',
    );
  }

  if (check) {
    // Non-mutating preview of external-tool updates; never stages or activates.
    await runToolUpdatesFn({ check: true });
    return { status: 'checked', check: true, downloadOnly: false };
  }

  if (downloadOnly) {
    log('\n🧬 Myelin Update (download-only)\n' + '─'.repeat(40));
    const staged = stageMainRuntimeFn({ home, rootDir, repoUrl, activate: false });
    log(`  ✓ Staged release: ${staged.releaseId}`);
    log(`  ↳ Retained at: ${staged.runtimeRoot}`);
    log('  ℹ Active runtime unchanged — run `myelin update` to activate.\n');
    return {
      status: 'downloaded',
      downloadOnly: true,
      releaseId: staged.releaseId,
      runtimeRoot: staged.runtimeRoot,
    };
  }

  log('\n🧬 Myelin Update\n' + '─'.repeat(40));
  const staged = stageMainRuntimeFn({ home, rootDir, repoUrl, activate: true });
  log(`  ✓ Activated release: ${staged.releaseId}`);
  writeManagedLauncherFn({ home, rootDir, os });

  const installer = await runInstallerFn({
    runtimeRoot: staged.runtimeRoot,
    args: ['--yes'],
    // I1: only forward MYELIN_DIR when the managed root is GENUINELY relocated.
    // resolveMyelinRoot never returns blank, so unconditionally injecting it made
    // the child installer read MYELIN_DIR=<home>/.myelin and mistake a default
    // install for a relocation — rewriting the shell profile to a hardcoded
    // absolute path on every update. A default install forwards no MYELIN_DIR.
    env: isManagedRootRelocated({ home, env, rootDir })
      ? { ...env, MYELIN_DIR: resolveMyelinRoot({ home, env, rootDir }) }
      : { ...env },
  });
  if (installer && installer.status !== 0) {
    warn(`  ✗ Installer integration failed (exit ${installer.status}). The active runtime already points at ${staged.releaseId}.\n`);
    return {
      status: 'failed',
      downloadOnly: false,
      releaseId: staged.releaseId,
      runtimeRoot: staged.runtimeRoot,
      installerStatus: installer.status,
    };
  }

  const { staleKeys = [] } = await checkStaleConfigKeysFn();
  await runToolUpdatesFn({});
  await runRestartFn();

  return {
    status: 'updated',
    downloadOnly: false,
    releaseId: staged.releaseId,
    runtimeRoot: staged.runtimeRoot,
    staleKeys,
  };
}

export function runDeprecatedSelfUpdate({ error = console.error } = {}) {
  const message = '`myelin update --self` is deprecated; run `myelin update`.';
  error(message);
  return { status: 'deprecated', exitCode: 1, message };
}

export function runDeprecatedNestedSelfUpdate({ error = console.error } = {}) {
  const message = '`myelin self update` is deprecated; run `myelin update`.';
  error(message);
  return { status: 'deprecated', exitCode: 1, message };
}
