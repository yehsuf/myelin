import { execSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, win32 as pathWin32 } from 'node:path';
import { chmodSync, mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { detectOS, powerShellExecutable } from '../detect/os.mjs';
import { buildEngineInstancePlan } from '../config/engine-runtime.mjs';
import { headroomBinPath } from '../tools/headroom.mjs';
import { loadConfig } from '../config/reader.mjs';
import { buildServiceEnvUnsetLines } from '../service/wrappers.mjs';
import { defaultWindowsHome, normalizeWindowsFilesystemPath } from '../service/windows.mjs';
import {
  installCopilotHeadroomService,
  installEngineInstance,
  installMitmService,
  installService,
  installWatchdog,
  removeEngineInstance,
} from '../service/index.mjs';
import {
  buildCopilotHeadroomServiceInstallOptions,
  buildMitmServiceInstallOptions,
  detectMitmdump,
  ensureManagedHeadroomService,
  managedHeadroomRegistrationStatus,
} from '../install.mjs';

const COPILOT_HEADROOM_RUN_KEY = 'MyelinCopilotHeadroom';
const REG_RUN = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const HEADROOM_LITE_STATE_DIR = ['.myelin', 'state', 'headroom-lite'];

function escapePs(value = '') {
  return String(value ?? '').replace(/'/g, "''");
}

function windowsPath(value = '') {
  return String(value ?? '').replace(/\//g, '\\');
}

function isWindowsAbsolutePath(value = '') {
  const text = String(value ?? '');
  return /^[a-zA-Z]:[\\/]/u.test(text) || text.startsWith('\\\\');
}

function joinManagedPath(home = '', ...parts) {
  return isWindowsAbsolutePath(home) ? pathWin32.join(home, ...parts) : join(home, ...parts);
}

export function buildManagedHeadroomEnv(cfg, baseEnv = process.env) {
  const env = {
    HEADROOM_PORT: String(cfg?.proxy?.headroom?.port ?? 8787),
    OPENAI_TARGET_API_URL: cfg?.proxy?.headroom?.openai_target_url ?? 'https://api.githubcopilot.com',
    HEADROOM_MODE: cfg?.proxy?.headroom?.mode ?? 'cache',
  };
  const configuredCorporateProxy = cfg?.proxy?.headroom?.corporate_proxy?.trim?.() ?? '';
  if (configuredCorporateProxy) env.HTTPS_PROXY = configuredCorporateProxy;
  const loopbackProxyPattern = /^https?:\/\/(?:127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d+)?\/?$/i;
  for (const key of ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'HEADROOM_CA_BUNDLE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
    if ((key === 'HTTPS_PROXY' || key === 'HTTP_PROXY') && loopbackProxyPattern.test(String(baseEnv[key] ?? ''))) {
      continue;
    }
    if (baseEnv[key] && !env[key]) env[key] = baseEnv[key];
  }
  return env;
}

function headroomLiteStateDir(home = homedir()) {
  return joinManagedPath(home, ...HEADROOM_LITE_STATE_DIR);
}

export function headroomLitePidPath({ home = homedir() } = {}) {
  return joinManagedPath(headroomLiteStateDir(home), 'headroom-lite.pid');
}

export function headroomLiteLauncherPath({ home = homedir(), osKind } = {}) {
  return joinManagedPath(headroomLiteStateDir(home), osKind === 'windows' ? 'start-headroom-lite.ps1' : 'start-headroom-lite.sh');
}

function trimShellValue(value = '') {
  return String(value ?? '').replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n').map(v => v.trim()).find(Boolean) ?? '';
}

function windowsInteropPowerShell() {
  return powerShellExecutable({ windowsInterop: true });
}

function resolveManagedWindowsHome(home, osKind, defaultWindowsHomeImpl = defaultWindowsHome) {
  return osKind === 'windows' ? defaultWindowsHomeImpl(home) : home;
}

function normalizeManagedWindowsPath(value, osKind, normalizeWindowsFilesystemPathImpl = normalizeWindowsFilesystemPath) {
  return osKind === 'windows' ? normalizeWindowsFilesystemPathImpl(value) : value;
}

function readManagedStateFile(filePath, {
  osKind,
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  powershellExe = windowsInteropPowerShell(),
} = {}) {
  if (!filePath) return '';
  try {
    if (existsSyncImpl(filePath)) {
      return String(readFileSyncImpl(filePath, 'utf8') ?? '');
    }
  } catch {}
  if (osKind !== 'windows' || !isWindowsAbsolutePath(filePath)) return '';
  try {
    return execSyncImpl(
      withPowerShell(`-NoProfile -Command "if (Test-Path '${escapePs(windowsPath(filePath))}') { Get-Content -Path '${escapePs(windowsPath(filePath))}' -Raw }"`, powershellExe),
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString().replace(/^\uFEFF/, '').replace(/\r/g, '');
  } catch {
    return '';
  }
}

function removeManagedStateFile(filePath, {
  osKind,
  execSyncImpl = execSync,
  unlinkSyncImpl = unlinkSync,
  powershellExe = windowsInteropPowerShell(),
} = {}) {
  if (!filePath) return;
  try {
    unlinkSyncImpl(filePath);
    return;
  } catch {}
  if (osKind !== 'windows' || !isWindowsAbsolutePath(filePath)) return;
  try {
    execSyncImpl(
      withPowerShell(`-NoProfile -Command "Remove-Item -Path '${escapePs(windowsPath(filePath))}' -ErrorAction SilentlyContinue"`, powershellExe),
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {}
}

function psSingleQuote(value = '') {
  return `'${escapePs(value)}'`;
}

function shSingleQuote(value = '') {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function withPowerShell(args, powershellExe = powerShellExecutable()) {
  return `${powershellExe} ${args}`;
}

function resolveHeadroomLiteBinary(
  osKind,
  execSyncImpl = execSync,
  {
    powershellExe = windowsInteropPowerShell(),
    normalizeWindowsFilesystemPathImpl = normalizeWindowsFilesystemPath,
  } = {},
) {
  try {
    const command = osKind === 'windows'
      ? withPowerShell(`-NoProfile -Command "(Get-Command headroom-lite -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)"`, powershellExe)
      : 'command -v headroom-lite';
    const options = osKind === 'windows'
      ? { stdio: ['ignore', 'pipe', 'pipe'] }
      : { stdio: ['ignore', 'pipe', 'pipe'], shell: '/bin/bash' };
    const resolved = trimShellValue(execSyncImpl(command, options).toString());
    if (!resolved) return null;
    return osKind === 'windows' ? normalizeWindowsFilesystemPathImpl(resolved) : resolved;
  } catch {
    return null;
  }
}

function headroomLitePortOwnerPid(port, osKind, execSyncImpl = execSync, { powershellExe = windowsInteropPowerShell() } = {}) {
  try {
    const command = osKind === 'windows'
      ? withPowerShell(`-NoProfile -Command "(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)"`, powershellExe)
      : `lsof -nP -tiTCP:${port} -sTCP:LISTEN 2>/dev/null`;
    const options = osKind === 'windows'
      ? { stdio: ['ignore', 'pipe', 'pipe'] }
      : { stdio: ['ignore', 'pipe', 'pipe'], shell: '/bin/bash' };
    const pid = Number(trimShellValue(execSyncImpl(command, options).toString()));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function headroomLiteProcessInfo(pid, osKind, execSyncImpl = execSync, { powershellExe = windowsInteropPowerShell() } = {}) {
  try {
    if (osKind === 'windows') {
      const script = [
        `$proc = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
        'if (-not $proc) { return }',
        '$parent = if ($proc.ParentProcessId) { Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }',
        '$grandparent = if ($parent -and $parent.ParentProcessId) { Get-CimInstance Win32_Process -Filter "ProcessId = $($parent.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }',
        '@{',
        '  command = $proc.CommandLine',
        '  executablePath = $proc.ExecutablePath',
        '  parentCommand = if ($parent) { $parent.CommandLine } else { "" }',
        '  grandparentCommand = if ($grandparent) { $grandparent.CommandLine } else { "" }',
        '} | ConvertTo-Json -Compress',
      ].join('; ');
      const out = trimShellValue(execSyncImpl(withPowerShell(`-NoProfile -Command "${script.replace(/"/g, '\\"')}"`, powershellExe), {
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString());
      return out ? JSON.parse(out) : null;
    }
    const command = trimShellValue(execSyncImpl(`ps -p ${pid} -o command=`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: '/bin/bash',
    }).toString());
    if (!command) return null;
    const parentPid = trimShellValue(execSyncImpl(`ps -p ${pid} -o ppid=`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: '/bin/bash',
    }).toString());
    const parentCommand = parentPid
      ? trimShellValue(execSyncImpl(`ps -p ${parentPid} -o command=`, {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: '/bin/bash',
        }).toString())
      : '';
    const grandparentPid = parentPid
      ? trimShellValue(execSyncImpl(`ps -p ${parentPid} -o ppid=`, {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: '/bin/bash',
        }).toString())
      : '';
    const grandparentCommand = grandparentPid
      ? trimShellValue(execSyncImpl(`ps -p ${grandparentPid} -o command=`, {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: '/bin/bash',
        }).toString())
      : '';
    return { command, executablePath: '', parentCommand, grandparentCommand };
  } catch {
    return null;
  }
}

function headroomLiteMatchesManagedLauncher(processInfo, launcherPath) {
  const needle = String(launcherPath ?? '').toLowerCase();
  if (!needle) return false;
  return [processInfo?.command, processInfo?.parentCommand, processInfo?.grandparentCommand].some((value) =>
    String(value ?? '').toLowerCase().includes(needle)
  );
}

function headroomLiteMatchesManagedPid(processInfo, binaryPath) {
  const needles = [String(binaryPath ?? ''), 'headroom-lite']
    .map((value) => value.toLowerCase())
    .filter(Boolean);
  return needles.some((needle) =>
    [processInfo?.command, processInfo?.parentCommand, processInfo?.executablePath].some((value) =>
      String(value ?? '').toLowerCase().includes(needle)
    )
  );
}

function readManagedHeadroomLitePid(pidPath, {
  osKind,
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  powershellExe = windowsInteropPowerShell(),
} = {}) {
  try {
    const pid = Number(trimShellValue(readManagedStateFile(pidPath, {
      osKind,
      execSyncImpl,
      existsSyncImpl,
      readFileSyncImpl,
      powershellExe,
    })));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function defaultStopPid(pid, osKind, execSyncImpl = execSync, { powershellExe = windowsInteropPowerShell() } = {}) {
  if (osKind === 'windows') {
    execSyncImpl(withPowerShell(`-NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction Stop"`, powershellExe), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return;
  }
  process.kill(pid, 'SIGTERM');
}

function buildHeadroomLiteLauncherScript({ binaryPath, port, pidPath, osKind }) {
  if (osKind === 'windows') {
    const headroomLiteCmd = windowsPath(binaryPath);
    const cmdArgs = `/d /s /c ""${headroomLiteCmd}""`;
    return `
$ErrorActionPreference = 'Stop'
${buildServiceEnvUnsetLines({ os: 'windows' })}
[System.Environment]::SetEnvironmentVariable('HTTPS_PROXY', $null, 'Process')
[System.Environment]::SetEnvironmentVariable('HTTP_PROXY', $null, 'Process')
[System.Environment]::SetEnvironmentVariable('NO_PROXY', $null, 'Process')
[System.Environment]::SetEnvironmentVariable('HEADROOM_LITE_PORT', '${escapePs(String(port))}', 'Process')
try { Remove-Item -Path ${psSingleQuote(windowsPath(pidPath))} -ErrorAction SilentlyContinue } catch {}
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList ${psSingleQuote(cmdArgs)} -WindowStyle Hidden -PassThru
$trackedPid = $proc.Id
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 200
  $child = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ParentProcessId -eq $proc.Id -and ($_.CommandLine -match 'headroom-lite' -or $_.ExecutablePath -match 'node(?:\\.exe)?$')
  } | Select-Object -First 1
  if ($child) { $trackedPid = $child.ProcessId; break }
}
Set-Content -Path ${psSingleQuote(windowsPath(pidPath))} -Value $trackedPid -Encoding ASCII
Wait-Process -Id $proc.Id
Remove-Item -Path ${psSingleQuote(windowsPath(pidPath))} -ErrorAction SilentlyContinue
`.trim();
  }
  return `#!/bin/sh
${buildServiceEnvUnsetLines({ os: 'darwin' })}
unset HTTPS_PROXY HTTP_PROXY NO_PROXY
export HEADROOM_LITE_PORT=${shSingleQuote(String(port))}
rm -f ${shSingleQuote(pidPath)}
${shSingleQuote(binaryPath)} >/dev/null 2>&1 &
child=$!
printf '%s\n' "$child" > ${shSingleQuote(pidPath)}
wait "$child"
rm -f ${shSingleQuote(pidPath)}
`;
}

function persistWindowsHeadroomLiteLauncher({
  launcherPath,
  launcherScript,
  execSyncImpl = execSync,
  powershellExe = windowsInteropPowerShell(),
} = {}) {
  const managedLauncherPath = windowsPath(launcherPath);
  const launcherDir = pathWin32.dirname(managedLauncherPath);
  const script = [
    `New-Item -ItemType Directory -Force -Path '${escapePs(launcherDir)}' | Out-Null`,
    `Set-Content -Path '${escapePs(managedLauncherPath)}' -Value @'`,
    launcherScript,
    `@' -Encoding UTF8`,
  ].join('\n');
  execSyncImpl(
    withPowerShell(`-NoProfile -Command "& { ${script.replace(/"/g, '\\"')} }"`, powershellExe),
    { stdio: 'pipe' },
  );
}

export async function stopManagedHeadroomLite({
  port,
  osKind,
  home = homedir(),
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  unlinkSyncImpl = unlinkSync,
  powershellExe = windowsInteropPowerShell(),
  defaultWindowsHomeImpl = defaultWindowsHome,
  normalizeWindowsFilesystemPathImpl = normalizeWindowsFilesystemPath,
  stopPidImpl = (pid) => defaultStopPid(pid, osKind, execSyncImpl, { powershellExe }),
  waitImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  binaryPath = resolveHeadroomLiteBinary(osKind, execSyncImpl, {
    powershellExe,
    normalizeWindowsFilesystemPathImpl,
  }),
} = {}) {
  const managedHome = resolveManagedWindowsHome(home, osKind, defaultWindowsHomeImpl);
  const pidPath = headroomLitePidPath({ home: managedHome });
  const launcherPath = headroomLiteLauncherPath({ home: managedHome, osKind });
  const managedBinaryPath = normalizeManagedWindowsPath(binaryPath, osKind, normalizeWindowsFilesystemPathImpl);
  const ownerPid = headroomLitePortOwnerPid(port, osKind, execSyncImpl, { powershellExe });
  const managedPid = readManagedHeadroomLitePid(pidPath, {
    osKind,
    execSyncImpl,
    existsSyncImpl,
    readFileSyncImpl,
    powershellExe,
  });
  const managedProcessInfo = managedPid ? headroomLiteProcessInfo(managedPid, osKind, execSyncImpl, { powershellExe }) : null;
  const trackedPidOwned = !!managedPid
    && headroomLiteMatchesManagedPid(managedProcessInfo, managedBinaryPath)
    && headroomLiteMatchesManagedLauncher(managedProcessInfo, launcherPath);

  if (!ownerPid) {
    if (managedPid && managedProcessInfo) {
      if (!trackedPidOwned) {
        removeManagedStateFile(pidPath, { osKind, execSyncImpl, unlinkSyncImpl, powershellExe });
        return { stopped: false, conflict: false, running: false };
      }
      try {
        stopPidImpl(managedPid);
      } catch (error) {
        return {
          stopped: false,
          conflict: true,
          running: true,
          ownerPid: managedPid,
          reason: `failed to stop managed headroom-lite pid ${managedPid}: ${error?.message?.split?.('\n')?.[0] ?? error}`,
        };
      }
      await waitImpl(400);
      removeManagedStateFile(pidPath, { osKind, execSyncImpl, unlinkSyncImpl, powershellExe });
      return { stopped: true, conflict: false, running: true, ownerPid: managedPid };
    }
    if (managedPid) {
      removeManagedStateFile(pidPath, { osKind, execSyncImpl, unlinkSyncImpl, powershellExe });
    }
    return { stopped: false, conflict: false, running: false };
  }

  const processInfo = headroomLiteProcessInfo(ownerPid, osKind, execSyncImpl, { powershellExe });
  const matchesLauncher = headroomLiteMatchesManagedLauncher(processInfo, launcherPath);
  const matchesManagedPid = headroomLiteMatchesManagedPid(processInfo, managedBinaryPath);

  if (!matchesManagedPid || !matchesLauncher) {
    if (managedPid && managedPid === ownerPid) {
      removeManagedStateFile(pidPath, { osKind, execSyncImpl, unlinkSyncImpl, powershellExe });
    }
    return {
      stopped: false,
      conflict: true,
      running: true,
      ownerPid,
      reason: `headroom-lite port ${port} is owned by an unmanaged process (pid ${ownerPid})`,
    };
  }

  try {
    stopPidImpl(ownerPid);
  } catch (error) {
    return {
      stopped: false,
      conflict: true,
      running: true,
      ownerPid,
      reason: `failed to stop managed headroom-lite pid ${ownerPid}: ${error?.message?.split?.('\n')?.[0] ?? error}`,
    };
  }

  await waitImpl(400);
  removeManagedStateFile(pidPath, { osKind, execSyncImpl, unlinkSyncImpl, powershellExe });
  return { stopped: true, conflict: false, running: true, ownerPid };
}

/**
 * Start (or restart) headroom-lite on the given port.
 *
 * Uses a managed launcher + pid file so restarts and cleanup only ever stop a
 * Myelin-owned Lite process. Any unrelated port owner is surfaced as a
 * conflict and left untouched.
 */
export async function restartHeadroomLite(port, osKind, _cfg, {
  home = homedir(),
  execSyncImpl = execSync,
  spawnImpl = spawn,
  mkdirSyncImpl = mkdirSync,
  writeFileSyncImpl = writeFileSync,
  chmodSyncImpl = chmodSync,
  stopManagedHeadroomLiteImpl = stopManagedHeadroomLite,
  waitForHeadroomLiteImpl = waitForHeadroomLite,
  powershellExe = windowsInteropPowerShell(),
  defaultWindowsHomeImpl = defaultWindowsHome,
  normalizeWindowsFilesystemPathImpl = normalizeWindowsFilesystemPath,
  log = console.log,
  warn = console.warn,
} = {}) {
  const managedHome = resolveManagedWindowsHome(home, osKind, defaultWindowsHomeImpl);
  const binaryPath = resolveHeadroomLiteBinary(osKind, execSyncImpl, {
    powershellExe,
    normalizeWindowsFilesystemPathImpl,
  });
  if (!binaryPath) {
    log('  ↷ headroom-lite not installed — run: npm i -g @yehsuf/headroom-lite');
    return false;
  }

  const stopResult = await stopManagedHeadroomLiteImpl({
    port,
    osKind,
    home: managedHome,
    execSyncImpl,
    binaryPath,
    powershellExe,
  });
  if (stopResult?.conflict) {
    warn(`  ⚠ ${stopResult.reason}`);
    return false;
  }

  const launcherPath = headroomLiteLauncherPath({ home: managedHome, osKind });
  const pidPath = headroomLitePidPath({ home: managedHome });
  const launcherScript = buildHeadroomLiteLauncherScript({ binaryPath, port, pidPath, osKind });
  if (osKind === 'windows') {
    persistWindowsHeadroomLiteLauncher({
      launcherPath,
      launcherScript,
      execSyncImpl,
      powershellExe,
    });
  } else {
    mkdirSyncImpl(headroomLiteStateDir(managedHome), { recursive: true });
    writeFileSyncImpl(launcherPath, launcherScript, 'utf8');
    chmodSyncImpl(launcherPath, 0o755);
  }

  try {
    const child = osKind === 'windows'
      ? spawnImpl(powershellExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherPath], {
          detached: true,
          stdio: 'ignore',
        })
      : spawnImpl(launcherPath, [], {
          detached: true,
          stdio: 'ignore',
        });
    child.unref();
    log(`  ✓ headroom-lite started (:${port})`);
  } catch (e) {
    warn(`  ⚠ headroom-lite start failed: ${e?.message?.split('\n')[0] ?? e}`);
    return false;
  }

  const healthy = await waitForHeadroomLiteImpl(port, 5000);
  if (healthy) {
    log(`  ✓ headroom-lite healthy on :${port}`);
  } else {
    log(`  ↷ headroom-lite still starting — run: myelin verify to confirm`);
  }
  return healthy;
}

/** Reuse waitForHeadroom's polling loop but target headroom-lite's /health path. */
async function waitForHeadroomLite(port, timeoutMs = 5000) {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

export function buildCopilotHeadroomTaskEnv({
  home = homedir(),
  copilotPort = 8788,
  egressPort = 8889,
  mode = 'cache',
} = {}) {
  const loopbackTarget = `http://127.0.0.1:${egressPort}`;
  return {
    HEADROOM_WORKSPACE_DIR: joinManagedPath(home, '.myelin', `headroom-copilot-${copilotPort}`),
    ANTHROPIC_TARGET_API_URL: loopbackTarget,
    OPENAI_TARGET_API_URL: loopbackTarget,
    HEADROOM_MODE: mode,
    NO_PROXY: '127.0.0.1,localhost,::1',
  };
}

function copilotHeadroomLauncherScript({ headroomBin, argStr, workingDirectory, envVars }) {
  const envLines = Object.entries(envVars)
    .filter(([, value]) => value != null && String(value).length > 0)
    .map(([key, value]) => `[System.Environment]::SetEnvironmentVariable('${key}', '${escapePs(String(value))}', 'Process')`)
    .join('\n');
  return `
# Managed by myelin. Keeps Copilot-Headroom env scoped to this process tree.
${buildServiceEnvUnsetLines({ os: 'windows' })}
${envLines}
Start-Process -FilePath '${escapePs(windowsPath(headroomBin))}' -ArgumentList '${escapePs(argStr)}' -WorkingDirectory '${escapePs(windowsPath(workingDirectory))}' -WindowStyle Hidden
`.trim();
}

function buildCopilotHeadroomArgString({ port, mode }) {
return `proxy --port ${port} --mode ${mode ?? 'cache'} --connect-timeout-seconds 10`;
}

function persistCopilotHeadroomLauncher({ headroomBin, argStr, taskEnv, execSyncImpl = execSync }) {
  const workingDirectory = windowsPath(taskEnv.HEADROOM_WORKSPACE_DIR);
  const launcherPath = windowsPath(pathWin32.join(workingDirectory, 'start-copilot-headroom.ps1'));
  const launcherScript = copilotHeadroomLauncherScript({
    headroomBin,
    argStr,
    workingDirectory,
    envVars: taskEnv,
  });
  const runValue = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${windowsPath(launcherPath)}"`;
  const script = [
    `New-Item -ItemType Directory -Force -Path '${escapePs(workingDirectory)}' | Out-Null`,
    `Set-Content -Path '${escapePs(launcherPath)}' -Value @'`,
    launcherScript,
    `@' -Encoding UTF8`,
    `Set-ItemProperty -Path '${REG_RUN}' -Name '${COPILOT_HEADROOM_RUN_KEY}' -Value '${escapePs(runValue)}'`,
  ].join('\n');
  execSyncImpl(
    withPowerShell(`-NoProfile -Command "& { ${script.replace(/"/g, '\\"')} }"`),
    { stdio: 'pipe' },
  );
  return { exe: 'powershell.exe', args: `-NoProfile -ExecutionPolicy Bypass -File "${windowsPath(launcherPath)}"` };
}

function parseCopilotHeadroomRunKeyValue(runKeyValue = '') {
  const value = String(runKeyValue ?? '').trim();
  const launcherMatch = value.match(/-File\s+"([^"]*start-copilot-headroom\.ps1)"/i);
  if (launcherMatch) return { launcherPath: launcherMatch[1] };
  const quoted = value.match(/^"([^"]+headroom(?:\.exe)?)"\s+([\s\S]*)$/i);
  if (quoted) return { executablePath: quoted[1], argStr: quoted[2].trim() };
  const bare = value.match(/^(\S+headroom(?:\.exe)?)\s+([\s\S]*)$/i);
  if (bare) return { executablePath: bare[1], argStr: bare[2].trim() };
  return {};
}

function parseLauncherStartProcess(script = '') {
  const match = String(script ?? '').match(/Start-Process -FilePath '((?:''|[^'])+)' -ArgumentList '((?:''|[^'])+)'/m);
  if (!match) return null;
  return {
    executablePath: match[1].replace(/''/g, "'"),
    argStr: match[2].replace(/''/g, "'"),
  };
}

function portFromArgString(argStr = '') {
  const match = String(argStr ?? '').match(/(?:^|\s)--port\s+(\d+)(?:\s|$)/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

function readLauncherScriptText(launcherPath, {
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
} = {}) {
  if (!launcherPath) return '';
  try {
    if (existsSyncImpl(launcherPath)) {
      return String(readFileSyncImpl(launcherPath, 'utf8') ?? '');
    }
  } catch {}
  if (!isWindowsAbsolutePath(launcherPath)) return '';
  try {
    return execSyncImpl(
      withPowerShell(`-NoProfile -Command "if (Test-Path '${escapePs(windowsPath(launcherPath))}') { Get-Content -Path '${escapePs(windowsPath(launcherPath))}' -Raw }"`),
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString().replace(/^\uFEFF/, '').replace(/\r/g, '');
  } catch {
    return '';
  }
}

export async function defaultStopManagedCopilotHeadroomProcess({
  runKeyValue,
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  stopHeadroomProcessByExecutablePathImpl,
} = {}) {
  if (!runKeyValue) return false;
  const parsedRunKey = parseCopilotHeadroomRunKeyValue(runKeyValue);
  let executablePath = parsedRunKey.executablePath ?? '';
  let argStr = parsedRunKey.argStr ?? '';
  const launcherScript = readLauncherScriptText(parsedRunKey.launcherPath, {
    execSyncImpl,
    existsSyncImpl,
    readFileSyncImpl,
  });
  if (launcherScript) {
    const parsedLauncher = parseLauncherStartProcess(launcherScript);
    executablePath = parsedLauncher?.executablePath ?? executablePath;
    argStr = parsedLauncher?.argStr ?? argStr;
  }
  const port = portFromArgString(argStr);
  if (!port || !executablePath) return false;
  const { stopHeadroomProcessByExecutablePath } = stopHeadroomProcessByExecutablePathImpl
    ? { stopHeadroomProcessByExecutablePath: stopHeadroomProcessByExecutablePathImpl }
    : await import('../service/windows.mjs');
  stopHeadroomProcessByExecutablePath({
    port,
    executablePath,
    execSyncImpl,
  });
  return true;
}

function stopProcessByPort(port, osKind, execSyncFn = execSync) {
  if (osKind === 'windows') {
    try {
      execSyncFn(
        withPowerShell(`-Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`),
        { stdio: 'pipe' },
      );
    } catch {}
    return;
  }
  try {
    execSyncFn(`lsof -ti :${port} | xargs -r kill -9 2>/dev/null`, { stdio: 'pipe', shell: '/bin/bash' });
  } catch {}
}

export async function stopObsoleteEngine({ engine, os, cfg, winManager, home = homedir(), warn = console.warn }) {
  if (engine === 'headroom_lite') {
    const result = await stopManagedHeadroomLite({
      port: cfg?.proxy?.headroom_lite?.port ?? 8790,
      osKind: os,
      home,
    });
    if (result?.conflict) warn(`  ⚠ ${result.reason}`);
    return result;
  }
  if (engine !== 'headroom') return;
  if (os === 'darwin') {
    try {
      const uid = execSync('id -u').toString().trim();
      execSync(`launchctl bootout gui/${uid}/com.myelin.headroom`, { stdio: 'ignore' });
    } catch {}
    try {
      const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.myelin.headroom.plist');
      if (existsSync(plist)) unlinkSync(plist);
    } catch {}
    return;
  }
  if (os === 'linux') {
    try {
      execSync('systemctl --user disable --now myelin-headroom.service', { stdio: 'pipe' });
    } catch {}
    try {
      const unit = join(homedir(), '.config', 'systemd', 'user', 'myelin-headroom.service');
      if (existsSync(unit)) unlinkSync(unit);
    } catch {}
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {}
    return;
  }
  if (winManager === 'winsw') {
    try {
      const { HEADROOM_SERVICE_ID, uninstallWinswService } = await import('../service/windows.mjs');
      uninstallWinswService({ id: HEADROOM_SERVICE_ID });
    } catch {}
    return;
  }
  try {
    const { stopManagedHeadroomProcess } = await import('../service/windows.mjs');
    stopManagedHeadroomProcess({ port: cfg?.proxy?.headroom?.port ?? 8787 });
  } catch {}
  try {
    execSync(
      withPowerShell(`-NoProfile -Command "Remove-ItemProperty -Path '${REG_RUN}' -Name 'MyelinHeadroom' -ErrorAction SilentlyContinue"`),
      { stdio: 'pipe' },
    );
  } catch {}
}

export async function defaultRestartManagedHeadroom({
  os,
  cfg,
  winManager,
  log,
  warn,
  managedHeadroomRegistrationStatusImpl = managedHeadroomRegistrationStatus,
  ensureManagedHeadroomServiceImpl = ensureManagedHeadroomService,
  installServiceImpl = installService,
  homedirImpl = homedir,
  headroomBinPathImpl = headroomBinPath,
}) {
  try {
    const home = homedirImpl();
    const port = cfg?.proxy?.headroom?.port ?? 8787;
    const envVars = buildManagedHeadroomEnv(cfg);
    const headroomBin = headroomBinPathImpl();
    const interceptToolResults = cfg?.proxy?.headroom?.intercept_tool_results ?? true;
    const registration = await managedHeadroomRegistrationStatusImpl({
      os,
      winManager,
      home,
      headroomPort: port,
    });
    if (!registration.registered) {
      await ensureManagedHeadroomServiceImpl({
        os,
        winManager,
        home,
        headroomBin,
        port,
        envVars,
        interceptToolResults,
        logFn: log,
        warnFn: warn,
      });
      return;
    }
    if (os !== 'windows' || winManager === 'winsw') {
      await installServiceImpl({
        headroomBin,
        port,
        envVars,
        home,
        interceptToolResults,
        logPath: join(home, '.myelin', 'headroom.log'),
        manager: winManager,
      });
      log(`  ✓ headroom service refreshed (:${port})`);
      return;
    }
    const persistedEnv = (os === 'windows' && winManager !== 'winsw')
      ? (await import('../service/windows.mjs')).readUserEnvVars([
          'SSL_CERT_FILE',
          'REQUESTS_CA_BUNDLE',
          'NODE_EXTRA_CA_CERTS',
          'HEADROOM_CA_BUNDLE',
          'HTTPS_PROXY',
          'HTTP_PROXY',
          'NO_PROXY',
        ])
      : {};
    try {
      const { stopManagedHeadroomProcess } = await import('../service/windows.mjs');
      stopManagedHeadroomProcess({ port, home });
    } catch {}
    await new Promise(r => setTimeout(r, 500));
    const { installService } = await import('../service/windows.mjs');
    await installService({
      headroomBin,
      port,
      envVars: buildManagedHeadroomEnv(cfg, { ...process.env, ...persistedEnv }),
      home,
      interceptToolResults,
      manager: 'registry',
    });
    log('  ✓ headroom restarted (registry)');
  } catch (e) {
    warn(`  ⚠ headroom restart failed: ${e.message?.split('\n')[0] ?? e}`);
  }
}

export async function defaultRestartCopilotHeadroom({
  os,
  cfg,
  winManager,
  log,
  warn,
  execSyncImpl = execSync,
  homedirImpl = homedir,
  defaultWindowsHomeImpl = defaultWindowsHome,
  headroomBinPathImpl = headroomBinPath,
  installCopilotHeadroomServiceImpl = installCopilotHeadroomService,
  persistCopilotHeadroomLauncherImpl = persistCopilotHeadroomLauncher,
  stopManagedCopilotHeadroomProcessImpl = defaultStopManagedCopilotHeadroomProcess,
  spawnDetachedServiceImpl,
  waitImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!cfg?.proxy?.copilot_headroom?.enabled) return;
  const port = cfg?.proxy?.copilot_headroom?.port ?? 8788;
  try {
    const home = os === 'windows' ? defaultWindowsHomeImpl(homedirImpl()) : homedirImpl();
    if (os !== 'windows' || winManager === 'winsw') {
      await installCopilotHeadroomServiceImpl(buildCopilotHeadroomServiceInstallOptions({
        cfg,
        headroomBin: headroomBinPathImpl(),
        home,
        manager: winManager,
      }));
      log(`  ✓ copilot-headroom restarted (:${port})`);
      return;
    }
    const regVal = trimShellValue(execSyncImpl(
      withPowerShell(`-Command "(Get-ItemProperty '${REG_RUN}' -Name ${COPILOT_HEADROOM_RUN_KEY} -ErrorAction SilentlyContinue).${COPILOT_HEADROOM_RUN_KEY}"`),
      { stdio: 'pipe' },
    ).toString());
    await stopManagedCopilotHeadroomProcessImpl({
      runKeyValue: regVal,
      execSyncImpl,
    });
    await waitImpl(500);
    const egressPort = cfg?.proxy?.mitm?.egress_port ?? 8889;
    const taskEnv = buildCopilotHeadroomTaskEnv({
      home,
      copilotPort: port,
      egressPort,
      mode: cfg?.proxy?.copilot_headroom?.mode ?? 'cache',
    });
    const launch = persistCopilotHeadroomLauncherImpl({
      headroomBin: headroomBinPathImpl(),
      argStr: buildCopilotHeadroomArgString({
        port,
        mode: cfg?.proxy?.copilot_headroom?.mode ?? 'cache',
      }),
      taskEnv,
      execSyncImpl,
    });
    const { spawnDetachedService } = spawnDetachedServiceImpl
      ? { spawnDetachedService: spawnDetachedServiceImpl }
      : await import('../service/windows.mjs');
    spawnDetachedService('MyelinCopilotHeadroom', launch.exe, launch.args);
    log(`  ✓ copilot-headroom restarted (:${port})`);
  } catch (e) {
    warn(`  ⚠ copilot-headroom restart failed: ${e.message?.split('\n')[0] ?? e}`);
  }
}

export async function defaultRestartMitm({
  os,
  cfg,
  winManager,
  log,
  warn,
  homedirImpl = homedir,
  detectMitmdumpImpl = detectMitmdump,
  buildMitmServiceInstallOptionsImpl = buildMitmServiceInstallOptions,
  installMitmServiceImpl = installMitmService,
} = {}) {
  try {
    const home = homedirImpl();
    const mitmdumpBin = detectMitmdumpImpl(os);
    if (!mitmdumpBin) throw new Error('mitmdump not found — run: myelin install --yes');
    const mitmOpts = buildMitmServiceInstallOptionsImpl({
      cfg,
      os,
      home,
      mitmdumpBin,
      winManager,
    });
    await installMitmServiceImpl(mitmOpts);
    log(`  ✓ mitmproxy service refreshed (port ${mitmOpts.port}${mitmOpts.egressPort ? ` + egress ${mitmOpts.egressPort}` : ''})`);
  } catch (e) {
    warn(`  ⚠ mitmproxy restart failed: ${e.message?.split('\n')[0] ?? e}`);
  }
}

export async function defaultRestartWatchdog({
  os,
  cfg,
  plan,
  winManager,
  log,
  warn,
  homedirImpl = homedir,
  installWatchdogImpl = installWatchdog,
} = {}) {
  try {
    const home = homedirImpl();
    const resolvedPlan = plan ?? buildEngineInstancePlan(cfg);
    const primary = resolvedPlan.instances.find((instance) => instance.role === 'primary');
    const copilot = resolvedPlan.instances.find((instance) => instance.role === 'copilot');
    const intervalMinutes = Number(cfg?.proxy?.windows_service?.watchdog_interval_minutes ?? 2) || 2;
    const installed = await installWatchdogImpl({
      home,
      enabled: winManager === 'winsw' && (cfg?.proxy?.windows_service?.watchdog_enabled ?? false),
      intervalMinutes,
      instances: resolvedPlan.instances,
      headroomPort: resolvedPlan.engine === 'headroom' ? primary?.port : undefined,
      mitmPort: cfg?.proxy?.mitm?.port ?? 8888,
      ...(copilot ? {
        copilotHeadroomPort: copilot.port,
        egressPort: cfg?.proxy?.mitm?.egress_port ?? 8889,
      } : {}),
    });
    if (installed) log('  ✓ watchdog definitions refreshed');
  } catch (e) {
    warn(`  ⚠ watchdog refresh failed: ${e.message?.split('\n')[0] ?? e}`);
  }
}

function cleanupPort(engine, role, cfg = {}) {
  const rawPort = role === 'primary'
    ? (engine === 'headroom_lite'
      ? cfg?.proxy?.headroom_lite?.port ?? 8790
      : cfg?.proxy?.headroom?.port ?? 8787)
    : cfg?.proxy?.copilot_headroom?.port ?? 8788;
  const port = typeof rawPort === 'string' ? Number(rawPort) : rawPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

function ownedEngineRoleInstance(engine, role, home, cfg) {
  const id = `${engine}-${role}`;
  const port = cleanupPort(engine, role, cfg);
  if (port == null) return null;
  return {
    engine,
    role,
    id,
    port,
    stateDir: join(home, '.myelin', 'state', id),
    logPath: join(home, '.myelin', `${id}.log`),
    healthUrl: `http://127.0.0.1:${port}/health`,
  };
}

function ownedEngineRoleInstances(engine, roles, home, cfg, warnFn) {
  return roles.map((role) => {
    const instance = ownedEngineRoleInstance(engine, role, home, cfg);
    if (!instance) warnFn?.(`  ⚠ skipped ${engine}-${role} cleanup: configured port is invalid`);
    return instance;
  }).filter(Boolean);
}

export async function stopObsoleteOwnedInstances({
  selectedEngine,
  cfg,
  winManager,
  home = homedir(),
  warn: warnFn,
  removeEngineInstanceImpl = removeEngineInstance,
  instances,
} = {}) {
  const obsoleteEngine = selectedEngine === 'headroom' ? 'headroom_lite' : 'headroom';
  const ownedInstances = instances ?? ownedEngineRoleInstances(
    obsoleteEngine, ['primary', 'copilot'], home, cfg, warnFn,
  );
  for (const instance of ownedInstances) {
    await removeEngineInstanceImpl(instance, {
      manager: winManager,
      home,
      warn: warnFn,
    });
  }
  return ownedInstances;
}

export async function removeDisabledCopilotInstance({
  plan,
  cfg,
  winManager,
  home = homedir(),
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
  });
  return true;
}

export async function waitForHealthUrl(healthUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function restartEngineInstance(instance, {
  cfg,
  winManager,
  home = homedir(),
  log = console.log,
  warn = console.warn,
  removeEngineInstanceImpl = removeEngineInstance,
  installEngineInstanceImpl = installEngineInstance,
  headroomBinPathImpl = headroomBinPath,
  detectToolImpl,
  waitForHealthUrlImpl = waitForHealthUrl,
} = {}) {
  try {
    const options = { manager: winManager, home };
    await removeEngineInstanceImpl(instance, {
      manager: winManager,
      home,
      warn,
    });
    if (instance.engine === 'headroom') {
      options.headroomBin = headroomBinPathImpl();
      options.envVars = buildManagedHeadroomEnv(cfg);
    } else if (instance.engine === 'headroom_lite') {
      const detectTool = detectToolImpl ?? (await import('../detect/tools.mjs')).detectTool;
      const headroomLite = await detectTool('headroom-lite', '--version');
      if (!headroomLite.installed || !headroomLite.path) {
        throw new Error('headroom-lite selected but not installed');
      }
      options.headroomLiteBin = headroomLite.path;
    } else {
      throw new Error(`Unsupported engine: ${instance.engine}`);
    }

    await installEngineInstanceImpl(instance, options);
    const healthy = await waitForHealthUrlImpl(instance.healthUrl);
    log(healthy
      ? `  ✓ ${instance.id} healthy (${instance.healthUrl})`
      : `  ↷ ${instance.id} still starting — run: myelin verify to confirm`);
    return healthy;
  } catch (error) {
    warn(`  ⚠ ${instance.id} restart failed: ${error.message?.split('\n')[0] ?? error}`);
    return false;
  }
}

export async function runRestart({
  config,
  loadConfigImpl = loadConfig,
  detectOSImpl = detectOS,
  buildEngineInstancePlanImpl = buildEngineInstancePlan,
  stopObsoleteOwnedInstancesImpl = stopObsoleteOwnedInstances,
  removeDisabledCopilotInstanceImpl = removeDisabledCopilotInstance,
  restartEngineInstanceImpl = restartEngineInstance,
  restartMitmImpl = defaultRestartMitm,
  restartWatchdogImpl = defaultRestartWatchdog,
  removeEngineInstanceImpl = removeEngineInstance,
  installEngineInstanceImpl = installEngineInstance,
  headroomBinPathImpl = headroomBinPath,
  detectToolImpl,
  waitForHealthUrlImpl = waitForHealthUrl,
  log = console.log,
  warn = console.warn,
} = {}) {
  const os = detectOSImpl();
  const cfg = config ?? await loadConfigImpl();
  const winManager = cfg?.proxy?.windows_service?.manager ?? 'registry';
  const home = homedir();
  const plan = buildEngineInstancePlanImpl(cfg);
  log('\n🔄 Restarting Myelin services...');

  const obsoleteEngine = plan.engine === 'headroom' ? 'headroom_lite' : 'headroom';
  const obsoleteInstances = ownedEngineRoleInstances(
    obsoleteEngine, ['primary', 'copilot'], home, cfg, warn,
  );
  await stopObsoleteOwnedInstancesImpl({
    selectedEngine: plan.engine,
    instances: obsoleteInstances,
    os,
    cfg,
    winManager,
    home,
    warn,
    removeEngineInstanceImpl,
  });
  await removeDisabledCopilotInstanceImpl({
    plan,
    os,
    cfg,
    winManager,
    home,
    warn,
    removeEngineInstanceImpl,
  });

  for (const instance of plan.instances) {
    await restartEngineInstanceImpl(instance, {
      os,
      cfg,
      winManager,
      home,
      log,
      warn,
      removeEngineInstanceImpl,
      installEngineInstanceImpl,
      headroomBinPathImpl,
      detectToolImpl,
      waitForHealthUrlImpl,
    });
  }

  await restartMitmImpl({ os, cfg, winManager, log, warn });
  await restartWatchdogImpl({ os, cfg, plan, winManager, home, log, warn });
  log();
}
