import { detectAll } from '../detect/tools.mjs';
import { execSync, execFileSync } from 'node:child_process';
import { detectOS, powerShellExecutable } from '../detect/os.mjs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_CONFIG_PATH, readUserConfig } from '../config/reader.mjs';
import { DEFAULT_CONFIG, listUnknownKeyPaths } from '../config/schema.mjs';
import { HEADROOM_AI_SPEC } from '../tools/headroom.mjs';
import { managedHeadroomPidPath } from '../service/windows.mjs';
import { managedPaths, resolveMyelinRoot } from '../shared/myelin-paths.mjs';
import { resolveCompressionConfig } from '../update/engine-selection.mjs';
import { loadConfig } from '../config/reader.mjs';
import { runUpdate as runAtomicUpdate } from '../update/update-orchestrator.mjs';



function upgradeCommands(os, { home = homedir(), env = process.env, compressionBackend } = {}) {
  // Resolve the managed venv through managedPaths so a relocated MYELIN_DIR is
  // honored — headroom lives in the managed root's venv, not a hardcoded
  // ~/.myelin/venv.
  const venv = managedPaths({ home, env, platform: os }).venvPath;
  const cmds = {
    uv:       { upgrade: 'uv self update' },
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
  // Include headroom upgrade only when headroom-original is the active backend.
  // Omitting the entry lets the existing `if (!cmd) continue` guard skip it —
  // preventing `uv pip install headroom-ai[proxy]` from running for headroom-lite
  // users where litellm requires Rust/maturin to build from source on Windows
  // (WIN-LITELLM-001). When compressionBackend is null/undefined (config unreadable)
  // we include headroom to preserve backward-compatible behaviour.
  if (compressionBackend == null || compressionBackend === 'headroom-original') {
    cmds.headroom = {
      // headroom installed via uv pip in venv, not uv tool. The managed venv path
      // is MYELIN_DIR-derived (arbitrary user-supplied), so it is executed as an
      // argument-array (never a shell string) — an arg element is not shell-parsed,
      // so a `$(...)`/quote/space in the relocated root can never inject. `display`
      // is a human-readable dry-run rendering only; it is never handed to a shell.
      upgrade: {
        file: 'uv',
        args: ['pip', 'install', '--python', venv, HEADROOM_AI_SPEC],
        display: `uv pip install --python "${venv}" "${HEADROOM_AI_SPEC}"`,
      },
    };
  }
  return cmds;
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

export async function runToolUpdates(options = {}, deps = {}) {
  const { check = false } = options;
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  const os = deps.os ?? (deps.detectOSFn ?? detectOS)();
  // Load config to determine active backend. Used in upgradeCommands to omit
  // headroom when headroom-lite is active — prevents uv pip install of
  // headroom-ai[proxy] which requires Rust/maturin on Windows (WIN-LITELLM-001).
  let compressionBackend;
  try {
    const config = await (deps.loadConfigFn ?? loadConfig)();
    compressionBackend = resolveCompressionConfig(config).backend;
  } catch { /* unreadable config: fall through, upgradeCommands will include headroom */ }

  const tools = await (deps.detectAllFn ?? detectAll)({ compressionBackend });
  const exec = deps.execSyncFn ?? execSync;
  const execFile = deps.execFileSyncFn ?? execFileSync;
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const cmds = upgradeCommands(os, { home, env, compressionBackend });
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
      try { runUpgrade(cmd.upgrade, { exec, execFile }); log('    ✓ done'); }
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
      log(`    → ${formatUpgradeForDisplay(cmd.upgrade)}`);
    }
  }
  log('─'.repeat(55));
  if (check) {
    log('  Run without --check to apply updates.\n');
    log('  Run: myelin verify to confirm.\n');
  }
}

/**
 * Run one tool's upgrade action. A plain STRING is a shell command (execSync);
 * an `{ file, args }` object is an argument-array exec (execFileSync) — used when
 * the command must embed a MYELIN_DIR-derived managed path (e.g. the venv), so
 * the path is passed as a literal argument that is never shell-parsed.
 */
function runUpgrade(upgrade, { exec, execFile }) {
  if (upgrade && typeof upgrade === 'object') {
    return execFile(upgrade.file, upgrade.args, { stdio: 'inherit' });
  }
  return exec(upgrade, { stdio: 'inherit' });
}

/** Human-readable dry-run rendering of an upgrade action (never executed). */
function formatUpgradeForDisplay(upgrade) {
  if (!upgrade) return '(manual)';
  if (typeof upgrade === 'object') return upgrade.display ?? [upgrade.file, ...upgrade.args].join(' ');
  return upgrade;
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

export async function detectUpdateTools({
  config,
  loadConfigImpl = loadConfig,
  detectAllImpl = detectAll,
} = {}) {
  const resolvedConfig = config ?? await loadConfigImpl();
  const selected = resolveCompressionConfig(resolvedConfig);
  return detectAllImpl({ compressionBackend: selected.backend });
}

export function filterSelectedUpdateEntries(tools, entries) {
  return Object.entries(tools).filter(([name, result]) => (
    !result.skipped && Boolean(entries[name])
  ));
}

export function formatUpdateCheckReport(report) {
  const plan = report.plan;
  const componentVersions = plan.components
    .map(({ name, current }) => `${name}@${current}`)
    .join(', ') || 'none';
  return [
    `Myelin update check (${plan.channel})`,
    `  active release: ${plan.releaseSnapshot.current ?? 'none'}`,
    `  target release: ${plan.target.version}`,
    `  backend: ${plan.backend}`,
    `  pinned components: ${componentVersions}`,
    `  config migration: ${report.config.migrationRequired ? 'required' : 'not required'}`,
    `  global lock: ${report.lock?.held ? `held by PID ${report.lock.owner?.pid ?? 'unknown'}` : 'available'}`,
    `  update journal: ${report.journal?.phase ?? 'none'}`,
  ].join('\n');
}

export async function runUpdate(options = {}, deps = {}) {
  const report = deps.report ?? (options.check
    ? value => console.log(formatUpdateCheckReport(value))
    : undefined);
  const result = await runAtomicUpdate(options, {
    ...deps,
    ...(report ? { report } : {}),
  });
  if (!options.check && result.ok) {
    console.log(`Myelin update ${result.status}.`);
  }
  return result;
}
