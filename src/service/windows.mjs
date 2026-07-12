import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, win32 as pathWin32 } from 'node:path';
import { headroomHealthUrl } from '../tools/headroom.mjs';
import { installWinsw } from '../tools/winsw.mjs';
import { powerShellExecutable } from '../detect/os.mjs';
import { isWsl } from '../detect/wsl.mjs';
import { buildServiceEnvUnsetLines } from './wrappers.mjs';

const REG_RUN = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const HEADROOM_KEY = 'MyelinHeadroom';
const MITM_KEY = 'MyelinMitmproxy';
const COPILOT_HEADROOM_KEY = 'MyelinCopilotHeadroom';
const WSL_SYSTEM_PROFILE_NAMES = new Set(['public', 'all users', 'default', 'default user', 'windows', 'wpsystem']);
const nodeExecSync = execSync;
const nodeExistsSync = existsSync;
const nodeReaddirSync = readdirSync;

export const HEADROOM_SERVICE_ID = 'myelin-headroom';
export const MITM_SERVICE_ID = 'myelin-mitmproxy';
export const COPILOT_HEADROOM_SERVICE_ID = 'myelin-copilot-headroom';

const MITM_IGNORE_HOSTS = [
  String.raw`.*\.akamai\.com`,
  String.raw`.*\.corp\.akamai\.com`,
  String.raw`.*\.akamaized\.net`,
  String.raw`.*\.akamaihd\.net`,
  String.raw`api\.github\.com`,
  String.raw`.*\.github\.com`,
].join('|');

function withPowerShell(args, powershellExe = powerShellExecutable()) {
  return `${powershellExe} ${args}`;
}

function runPs(script, { stdio = 'pipe', powershellExe = powerShellExecutable() } = {}) {
  const stateDir = join(homedir(), '.myelin', 'state');
  mkdirSync(stateDir, { recursive: true });
  const tmp = join(stateDir, `myelin-${process.pid}-${Date.now()}.ps1`);
  writeFileSync(tmp, script, 'utf8');
  try {
    execSync(withPowerShell(`-ExecutionPolicy Bypass -File "${tmp}"`, powershellExe), { stdio });
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

function escapePs(value = '') {
  return String(value ?? '').replace(/'/g, "''");
}

function psQuote(value = '') {
  return `'${escapePs(value)}'`;
}

function windowsPath(value = '') {
  return String(value ?? '').replace(/\//g, '\\');
}

export function normalizeWindowsFilesystemPath(value = '') {
  const raw = String(value ?? '');
  if (!raw) return raw;
  if (isWindowsAbsolutePath(raw)) return collapseRedundantBackslashes(windowsPath(raw));
  if (/^\/mnt\/[a-zA-Z](?:\/|$)/u.test(raw)) {
    return collapseRedundantBackslashes(windowsPath(wslMountToWindowsPath(raw)));
  }
  return collapseRedundantBackslashes(windowsPath(raw));
}

function taskEnvValue(key, value = '') {
  const raw = String(value ?? '');
  return /(_DIR|_PATH|^HOME$|^USERPROFILE$|^APPDATA$|^LOCALAPPDATA$)/u.test(key)
    ? windowsPath(raw)
    : raw;
}

function trimPowershellOutput(value = '') {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .split('\n')[0]
    .trim();
}

function wslMountToWindowsPath(value = '') {
  const match = String(value ?? '').match(/^\/mnt\/([a-zA-Z])\/?(.*)$/u);
  if (!match) return value;
  const [, drive, rest = ''] = match;
  return rest ? `${drive.toUpperCase()}:/${rest}` : `${drive.toUpperCase()}:/`;
}

function xmlEscape(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function resolveWslWindowsHome({
  execSync = nodeExecSync,
  existsSync = nodeExistsSync,
  readdirSync = nodeReaddirSync,
  powershellExe = powerShellExecutable({ windowsInterop: true }),
} = {}) {
  const scopes = ['User', 'Machine'];
  for (const scope of scopes) {
    try {
      const home = trimPowershellOutput(execSync(
        withPowerShell(`-NoProfile -NonInteractive -Command "[Environment]::GetEnvironmentVariable('USERPROFILE','${scope}')"`, powershellExe)
      ));
      if (home) return home;
    } catch {}
  }

  try {
    if (!existsSync('/mnt/c/Users')) return null;
    const candidates = readdirSync('/mnt/c/Users', { withFileTypes: true })
      .filter(entry => {
        const name = typeof entry === 'string' ? entry : entry.name;
        const isDirectory = typeof entry === 'string' ? true : entry.isDirectory();
        return isDirectory && !WSL_SYSTEM_PROFILE_NAMES.has(name.toLowerCase());
      })
      .map(entry => typeof entry === 'string' ? entry : entry.name);
    if (candidates.length === 1) return `/mnt/c/Users/${candidates[0]}`;
  } catch {}

  return null;
}

export function defaultWindowsHome(
  home,
  {
    isWslImpl = isWsl,
    resolveWslWindowsHomeImpl = resolveWslWindowsHome,
    homedirImpl = homedir,
  } = {},
) {
  const wsl = isWslImpl();
  const explicitHome = home ?? process.env.USERPROFILE ?? null;
  const shouldResolveWindowsHome = wsl
    && explicitHome
    && !/^[a-zA-Z]:[\\/]/u.test(explicitHome)
    && !String(explicitHome).startsWith('\\\\');
  const resolvedHome = shouldResolveWindowsHome
    ? (resolveWslWindowsHomeImpl() ?? explicitHome)
    : (explicitHome ?? (wsl ? resolveWslWindowsHomeImpl() : null) ?? homedirImpl());
  return windowsPath(wsl ? wslMountToWindowsPath(resolvedHome) : resolvedHome);
}

function defaultServiceEnv({ home, envVars = {} } = {}) {
  const winHome = defaultWindowsHome(home);
  return {
    HOME: winHome,
    USERPROFILE: winHome,
    APPDATA: pathWin32.join(winHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: pathWin32.join(winHome, 'AppData', 'Local'),
    ...envVars,
  };
}

function quoteWindowsArgument(value = '') {
  const str = String(value ?? '');
  if (str === '') return '""';
  if (!/[\s"]/u.test(str)) return str;
  return `"${str.replace(/"/g, '\\"')}"`;
}

function joinArguments(args = []) {
  return args.map(quoteWindowsArgument).join(' ');
}

function buildHeadroomArgumentString({ port }) {
  // Note: --intercept-tool-results is deliberately NOT included here.
  // That flag calls `ensure_tools()` at startup which downloads ast-grep if not
  // found — this hangs in restricted-network Task Scheduler sessions (e.g. NetFree).
  // Instead, set HEADROOM_INTERCEPT_ENABLED=1 in the process env (see installService).
  return `proxy --port ${port}`;
}

function buildCopilotHeadroomArgumentString({ port, mode }) {
  return `proxy --port ${port} --mode ${mode ?? 'cache'} --connect-timeout-seconds 10`;
}

function buildMitmArgumentString({ mitmdumpBin, port, addonPath, envVars = {}, egressPort, upstreamProxy }) {
  const normalizedAddonPath = normalizeWindowsFilesystemPath(addonPath);
  const args = egressPort
    ? ['--mode', `regular@${port}`, '--mode', `regular@127.0.0.1:${egressPort}`, '-s', normalizedAddonPath]
    : ['--listen-port', String(port), '-s', normalizedAddonPath];

  const proxy = upstreamProxy || envVars.HTTPS_PROXY || envVars.https_proxy || '';
  if (proxy && !proxy.includes('127.0.0.1') && !proxy.includes('localhost')) {
    args.push('--mode', `upstream:${proxy}`);
  }

  const caBundle = envVars.SSL_CERT_FILE || envVars.REQUESTS_CA_BUNDLE ||
                   envVars.NODE_EXTRA_CA_CERTS || envVars.HEADROOM_CA_BUNDLE || '';
  if (caBundle) args.push('--set', `ssl_verify_upstream_trusted_ca=${normalizeWindowsFilesystemPath(caBundle)}`);

  args.push('--ignore-hosts', MITM_IGNORE_HOSTS);
  return joinArguments(args);
}

function legacyRunKeyForService(id) {
  if (id === HEADROOM_SERVICE_ID) return HEADROOM_KEY;
  if (id === MITM_SERVICE_ID) return MITM_KEY;
  if (id === COPILOT_HEADROOM_SERVICE_ID) return COPILOT_HEADROOM_KEY;
  return null;
}

function winswLogDir({ id, home, logPath } = {}) {
  if (!logPath) return pathWin32.join(winswServiceDir({ id, home }), 'logs');
  const normalized = windowsPath(logPath);
  return pathWin32.extname(normalized) ? pathWin32.dirname(normalized) : normalized;
}

function generateWinswInstallScript({ serviceExePath, configPath, legacyRunKey }) {
  const cleanupRunKey = legacyRunKey
    ? `Remove-ItemProperty -Path ${psQuote(REG_RUN)} -Name ${psQuote(legacyRunKey)} -ErrorAction SilentlyContinue`
    : '';
  return `
try { & ${psQuote(serviceExePath)} stop ${psQuote(configPath)} --force --no-wait | Out-Null } catch {}
try { & ${psQuote(serviceExePath)} uninstall ${psQuote(configPath)} | Out-Null } catch {}
Start-Sleep -Seconds 1
& ${psQuote(serviceExePath)} install ${psQuote(configPath)} | Out-Null
& ${psQuote(serviceExePath)} start ${psQuote(configPath)} | Out-Null
${cleanupRunKey}
`;
}

function generateWinswUninstallScript({ serviceExePath, configPath, legacyRunKey }) {
  const cleanupRunKey = legacyRunKey
    ? `Remove-ItemProperty -Path ${psQuote(REG_RUN)} -Name ${psQuote(legacyRunKey)} -ErrorAction SilentlyContinue`
    : '';
  return `
try { & ${psQuote(serviceExePath)} stop ${psQuote(configPath)} --force --no-wait | Out-Null } catch {}
try { & ${psQuote(serviceExePath)} uninstall ${psQuote(configPath)} | Out-Null } catch {}
${cleanupRunKey}
`;
}

/** Build a PowerShell snippet that stops only the process instance whose
 *  command line matches a specific --port value (not all processes sharing
 *  the same binary name) — needed once more than one headroom instance can
 *  run at once (Claude-Headroom + Copilot-Headroom both run headroom.exe).
 *  NOT live-tested on Windows (Mac is this project's primary dev/test
 *  platform) — review carefully before relying on it in production.
 */
function escapePsRegex(value = '') {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stopByPortScript(processExeName, port, { requiredArgs = [], requiredExecutablePath = '' } = {}) {
  const clauses = [
    `$_.CommandLine`,
    ...requiredArgs.map((arg) => `$_.CommandLine -match '${escapePsRegex(arg)}'`),
    `$_.CommandLine -match '(^|\\s)--port\\s+${port}(\\s|$)'`,
    ...(requiredExecutablePath ? [`$_.ExecutablePath -eq '${escapePs(requiredExecutablePath)}'`] : []),
  ];
  return `Get-CimInstance Win32_Process -Filter "Name = '${processExeName}'" | Where-Object { ${clauses.join(' -and ')} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
}

function portFromArgString(argStr = '') {
  const match = String(argStr ?? '').match(/(?:^|\s)--port\s+(\d+)(?:\s|$)/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

export function managedHeadroomLauncherPath({ home } = {}) {
  return pathWin32.join(winswServiceDir({ id: HEADROOM_SERVICE_ID, home }), 'start-headroom.ps1');
}

export function managedHeadroomPidPath({ home } = {}) {
  return pathWin32.join(winswServiceDir({ id: HEADROOM_SERVICE_ID, home }), 'headroom.pid');
}

export function managedMitmLauncherPath({ home } = {}) {
  return pathWin32.join(winswServiceDir({ id: MITM_SERVICE_ID, home }), 'start-mitmproxy.ps1');
}

export function managedMitmPidPath({ home } = {}) {
  return pathWin32.join(winswServiceDir({ id: MITM_SERVICE_ID, home }), 'mitm.pid');
}

export function buildManagedHeadroomStopScript({ port, processExeName = 'headroom.exe', pidFilePath, launcherPath } = {}) {
  const pidPath = windowsPath(pidFilePath ?? managedHeadroomPidPath());
  const managedLauncherPath = windowsPath(launcherPath ?? managedHeadroomLauncherPath());
  const launcherRegex = escapePs(escapePsRegex(managedLauncherPath));
  return [
    `$pidPath = '${escapePs(pidPath)}'`,
    `$launcherRegex = '${launcherRegex}'`,
    `if (Test-Path $pidPath) {`,
    `  $managedPid = (Get-Content -Path $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1)`,
    `  if ($managedPid -and $managedPid.ToString().Trim() -match '^[0-9]+$') {`,
    `    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue`,
    `    if (-not $proc) {`,
    `      Remove-Item -Path $pidPath -ErrorAction SilentlyContinue`,
    `    } elseif ($proc.Name -ieq '${processExeName}' -and $proc.CommandLine -match 'proxy') {`,
    `      $parent = if ($proc.ParentProcessId) { Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }`,
    `      $matchesManagedLauncher = $parent -and $parent.CommandLine -match $launcherRegex`,
    `      if ($matchesManagedLauncher) {`,
    `        Stop-Process -Id $managedPid -Force -ErrorAction SilentlyContinue`,
    `      }`,
    `      Remove-Item -Path $pidPath -ErrorAction SilentlyContinue`,
    `    } else {`,
    `      Remove-Item -Path $pidPath -ErrorAction SilentlyContinue`,
    `    }`,
    `  } else {`,
    `    Remove-Item -Path $pidPath -ErrorAction SilentlyContinue`,
    `  }`,
    `}`,
  ].join('\n');
}

function parseLegacyManagedHeadroomRunKeyValue({ runKeyValue = '' } = {}) {
  const value = String(runKeyValue ?? '');
  if (/start-headroom\.ps1/i.test(value) || !/headroom(?:\.exe)?/i.test(value) || !/proxy/i.test(value)) return null;
  const trimmed = String(runKeyValue ?? '').trim();
  const quoted = trimmed.match(/^"([^"]+headroom(?:\.exe)?)"\s+([\s\S]*)$/i);
  const bare = trimmed.match(/^([^"\s]+headroom(?:\.exe)?)\s+([\s\S]*)$/i);
  const match = quoted ?? bare;
  if (!match) return null;
  const argStr = match[2].trim();
  if (!/^proxy\b/i.test(argStr)) return null;
  const port = portFromArgString(argStr);
  if (!port) return null;
  return { executablePath: match[1], argStr, port };
}

export function isLegacyManagedHeadroomRunKeyValue({ port, runKeyValue = '' } = {}) {
  const parsed = parseLegacyManagedHeadroomRunKeyValue({ runKeyValue });
  if (!parsed) return false;
  const requestedPort = Number(port);
  return Number.isInteger(requestedPort) ? parsed.port === requestedPort : true;
}

function isWindowsAbsolutePath(filePath = '') {
  return /^(?:[a-z]:\\|\\\\)/i.test(windowsPath(filePath));
}

function readWindowsFileText(filePath, {
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  powershellExe = powerShellExecutable(),
} = {}) {
  if (!filePath) return '';
  try {
    if (existsSyncImpl(filePath)) {
      return String(readFileSyncImpl(filePath, 'utf8') ?? '');
    }
  } catch {}
  if (!isWindowsAbsolutePath(filePath)) return '';
  try {
    return execSyncImpl(
      withPowerShell(`-NoProfile -Command "if (Test-Path '${escapePs(windowsPath(filePath))}') { Get-Content -Path '${escapePs(windowsPath(filePath))}' -Raw }"`, powershellExe),
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString().replace(/^\uFEFF/, '').replace(/\r/g, '');
  } catch {
    return '';
  }
}

function readWindowsScriptText(scriptPath, opts = {}) {
  return readWindowsFileText(scriptPath, opts);
}

function parseLauncherStartProcess(script = '') {
  const match = String(script ?? '').match(/Start-Process -FilePath '((?:''|[^'])+)' -ArgumentList '((?:''|[^'])+)'/m);
  if (!match) return null;
  return {
    executablePath: match[1].replace(/''/g, "'"),
    argStr: match[2].replace(/''/g, "'"),
  };
}

function parseCopilotHeadroomRunKeyValue(runKeyValue = '') {
  const value = String(runKeyValue ?? '').trim();
  const launcherMatch = value.match(/-File\s+"([^"]*start-copilot-headroom\.ps1)"/i);
  if (launcherMatch) return { launcherPath: launcherMatch[1] };
  const quoted = value.match(/^"([^"]+headroom(?:\.exe)?)"\s+([\s\S]*)$/i);
  if (quoted) return { executablePath: quoted[1], argStr: quoted[2].trim() };
  const bare = value.match(/^(\S+headroom(?:\.exe)?)\s+([\s\S]*)$/i);
  if (bare) return { executablePath: bare[1], argStr: bare[2].trim() };
  return null;
}

function buildManagedHeadroomStatusScript({ pid, executablePath, argStr, launcherPath, port, processExeName = 'headroom.exe' } = {}) {
  const effectivePort = Number(port);
  const commandClauses = [
    `$_.CommandLine`,
    `$_.CommandLine -match 'proxy'`,
    argStr
      ? `$_.CommandLine -match '${escapePs(escapePsRegex(argStr))}$'`
      : `$_.CommandLine -match '(^|\\\\s)--port\\\\s+${effectivePort}(\\\\s|$)'`,
    ...(executablePath ? [`$_.ExecutablePath -eq '${escapePs(windowsPath(executablePath))}'`] : []),
  ];
  const exeName = escapePs((executablePath ? windowsPath(executablePath) : processExeName).split('\\').pop() ?? processExeName);
  if (pid && /^[0-9]+$/u.test(String(pid))) {
    const launcherRegex = escapePs(escapePsRegex(windowsPath(launcherPath)));
    return [
      `$managedPid = ${pid}`,
      `$proc = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue`,
      `if ($proc -and $proc.Name -ieq '${exeName}' -and ${commandClauses.map((clause) => clause.replace(/\$_/g, '$proc')).join(' -and ')}) {`,
      `  $parent = if ($proc.ParentProcessId) { Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }`,
      `  if ($parent -and $parent.CommandLine -match '${launcherRegex}') {`,
      `    'Running'`,
      `    return`,
      `  }`,
      `}`,
      `'Stopped'`,
    ].join('\n');
  }
  if (launcherPath) {
    const launcherRegex = escapePs(escapePsRegex(windowsPath(launcherPath)));
    return [
      `Get-CimInstance Win32_Process -Filter "Name = '${exeName}'" | ForEach-Object {`,
      `  if (${commandClauses.join(' -and ')}) {`,
      `    $parent = if ($_.ParentProcessId) { Get-CimInstance Win32_Process -Filter "ProcessId = $($_.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }`,
      `    if ($parent -and $parent.CommandLine -match '${launcherRegex}') {`,
      `      'Running'`,
      `      return`,
      `    }`,
      `  }`,
      `}`,
      `'Stopped'`,
    ].join('\n');
  }
  return [
    `$proc = Get-CimInstance Win32_Process -Filter "Name = '${exeName}'" | Where-Object { ${commandClauses.join(' -and ')} } | Select-Object -First 1`,
    `if ($proc) { 'Running' } else { 'Stopped' }`,
  ].join('\n');
}

export function stopManagedHeadroomProcess({
  port,
  processExeName = 'headroom.exe',
  home,
  execSyncImpl = execSync,
  headroomRunKeyStatusImpl = headroomRunKeyStatus,
  powershellExe = powerShellExecutable(),
} = {}) {
  const runKeyStatus = headroomRunKeyStatusImpl({ execSyncImpl, powershellExe });
  let script = buildManagedHeadroomStopScript({
    port,
    processExeName,
    pidFilePath: managedHeadroomPidPath({ home }),
    launcherPath: managedHeadroomLauncherPath({ home }),
  });
  const legacyRunKey = parseLegacyManagedHeadroomRunKeyValue({ runKeyValue: runKeyStatus?.raw });
  if (legacyRunKey?.executablePath && legacyRunKey?.port) {
    script += `\n${stopByPortScript(processExeName, legacyRunKey.port, {
      requiredArgs: ['proxy'],
      requiredExecutablePath: windowsPath(legacyRunKey.executablePath),
    })}\nRemove-ItemProperty -Path ${psQuote(REG_RUN)} -Name ${psQuote(HEADROOM_KEY)} -ErrorAction SilentlyContinue`;
  }
  script = script.replace(/"/g, '\\"');
  execSyncImpl(withPowerShell(`-NoProfile -Command "& { ${script} }"`, powershellExe), { stdio: 'pipe' });
}

export function stopHeadroomProcessByExecutablePath({
  port,
  executablePath,
  processExeName = 'headroom.exe',
  execSyncImpl = execSync,
  powershellExe = powerShellExecutable(),
} = {}) {
  const script = stopByPortScript(processExeName, port, {
    requiredArgs: ['proxy'],
    requiredExecutablePath: windowsPath(executablePath),
  }).replace(/"/g, '\\"');
  execSyncImpl(withPowerShell(`-NoProfile -Command "& { ${script} }"`, powershellExe), { stdio: 'pipe' });
}

export function winswServiceDir({ id, home } = {}) {
  return pathWin32.join(defaultWindowsHome(home), '.myelin', 'services', id);
}

export function winswExecutablePath({ id, home } = {}) {
  return pathWin32.join(winswServiceDir({ id, home }), `${id}.exe`);
}

export function winswConfigPath({ id, home } = {}) {
  return pathWin32.join(winswServiceDir({ id, home }), `${id}.xml`);
}

export function windowsWatchdogTaskName({ id }) {
  if (id === COPILOT_HEADROOM_SERVICE_ID) return 'Myelin Copilot Headroom Watchdog';
  return 'Myelin Headroom Watchdog';
}

function winswWatchdogScriptPath({ id, home } = {}) {
  return pathWin32.join(winswServiceDir({ id, home }), 'watchdog.ps1');
}

function winswWatchdogLogPath({ id, home } = {}) {
  return pathWin32.join(winswServiceDir({ id, home }), 'watchdog.log');
}

export function generateWinswConfigXml({
  id,
  name,
  description,
  executable,
  arguments: serviceArguments,
  logPath,
  envVars = {},
  onFailureDelays = ['5 sec', '30 sec'],
  resetFailure = '1 hour',
  hideWindow = true,
}) {
  const envEntries = Object.entries(envVars)
    .map(([key, value]) => `  <env name="${xmlEscape(key)}" value="${xmlEscape(value)}"/>`)
    .join('\n');
  const failureEntries = (onFailureDelays.length ? onFailureDelays : ['30 sec'])
    .map((delay) => `  <onfailure action="restart" delay="${xmlEscape(delay)}"/>`)
    .join('\n');
  const hideWindowEntry = hideWindow ? '\n  <hidewindow>true</hidewindow>' : '';
  const envBlock = envEntries ? `${envEntries}\n` : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<service>
  <id>${xmlEscape(id)}</id>
  <name>${xmlEscape(name)}</name>
  <description>${xmlEscape(description)}</description>
${envBlock}  <executable>${xmlEscape(executable)}</executable>
  <arguments>${xmlEscape(serviceArguments)}</arguments>
  <startmode>Automatic</startmode>
  <logpath>${xmlEscape(logPath)}</logpath>
  <log mode="roll"></log>${hideWindowEntry}
${failureEntries}
  <resetfailure>${xmlEscape(resetFailure)}</resetfailure>
</service>`;
}

export function parseWinswServiceStatus(raw = '') {
  const text = String(raw ?? '').trim();
  if (text.startsWith('Active')) return { running: true, state: text, raw: text };
  if (text.startsWith('Inactive')) return { running: false, state: text, raw: text };
  if (text.startsWith('NonExistent')) return { running: false, state: 'NonExistent', raw: text };
  return { running: false, state: text || 'Unknown', raw: text };
}

export function generateWindowsWatchdogHealthcheckScript({
  serviceName,
  healthUrl,
  winswExePath,
  winswConfigPath: configPath,
  logPath,
  timeoutSeconds = 10,
}) {
  return `
$ErrorActionPreference = 'Stop'
$ServiceName = ${psQuote(serviceName)}
$HealthUrl = ${psQuote(healthUrl)}
$WinswExe = ${psQuote(winswExePath)}
$WinswConfig = ${psQuote(configPath)}
$LogPath = ${psQuote(logPath)}
$LogDir = Split-Path -Parent $LogPath
if ($LogDir) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

try {
  $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec ${timeoutSeconds}
  if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { exit 0 }
  throw "Unexpected health status: $($response.StatusCode)"
} catch {
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $LogPath -Value "[watchdog] $timestamp $ServiceName unhealthy at $HealthUrl — $($_.Exception.Message)"
  try {
    & $WinswExe restart $WinswConfig | Out-Null
    Add-Content -Path $LogPath -Value "[watchdog] $timestamp $ServiceName restarted via WinSW restart"
  } catch {
    try { & $WinswExe stop $WinswConfig --force --no-wait | Out-Null } catch {}
    Start-Sleep -Seconds 2
    & $WinswExe start $WinswConfig | Out-Null
    Add-Content -Path $LogPath -Value "[watchdog] $timestamp $ServiceName restarted via WinSW stop/start"
  }
}
`;
}

export function generateWindowsWatchdogTaskCreateScript({ taskName, scriptPath, intervalMinutes = 2 }) {
  const cadence = Number(intervalMinutes);
  if (!Number.isFinite(cadence) || cadence < 1 || cadence > 1439) {
    throw new Error('intervalMinutes must be between 1 and 1439');
  }
  const taskAction = `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${windowsPath(scriptPath)}"`;
  return `
$TaskName = ${psQuote(taskName)}
$TaskAction = ${psQuote(taskAction)}
schtasks.exe /create /tn $TaskName /sc minute /mo ${cadence} /tr $TaskAction /ru System /rl HIGHEST /f | Out-Null
`;
}

export async function installWinswService({
  id,
  name,
  description,
  executable,
  arguments: serviceArguments,
  envVars = {},
  logPath,
  home,
  onFailureDelays = ['5 sec', '30 sec'],
  resetFailure = '1 hour',
}) {
  const winHome = defaultWindowsHome(home);
  const serviceDir = winswServiceDir({ id, home: winHome });
  const serviceExePath = winswExecutablePath({ id, home: winHome });
  const configPath = winswConfigPath({ id, home: winHome });
  const logDir = winswLogDir({ id, home: winHome, logPath });
  const legacyRunKey = legacyRunKeyForService(id);

  mkdirSync(serviceDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  if (existsSync(serviceExePath)) {
    try {
      runPs(generateWinswUninstallScript({ serviceExePath, configPath, legacyRunKey }));
    } catch {}
  }

  const winsw = await installWinsw({ home: winHome });
  copyFileSync(winsw.path, serviceExePath);

  const xml = generateWinswConfigXml({
    id,
    name,
    description,
    executable: windowsPath(executable),
    arguments: serviceArguments,
    logPath: windowsPath(logDir),
    envVars: defaultServiceEnv({ home: winHome, envVars }),
    onFailureDelays,
    resetFailure,
  });
  writeFileSync(configPath, xml, 'utf8');
  runPs(generateWinswInstallScript({ serviceExePath, configPath, legacyRunKey }));
  return { id, serviceExePath, configPath, logDir };
}

export function winswServiceStatus({ id, home, execSyncImpl = execSync, powershellExe = powerShellExecutable() } = {}) {
  const serviceExePath = winswExecutablePath({ id, home });
  const configPath = winswConfigPath({ id, home });
  if (!existsSync(serviceExePath) || !existsSync(configPath)) {
    return { running: false, state: 'Missing', label: id, raw: '' };
  }

  let raw = '';
  try {
    raw = execSyncImpl(withPowerShell(`-Command "& ${psQuote(serviceExePath)} status ${psQuote(configPath)}"`, powershellExe), {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
  } catch (error) {
    raw = `${error?.stdout?.toString?.() ?? ''}${error?.stderr?.toString?.() ?? ''}`.trim();
  }

  return { ...parseWinswServiceStatus(raw), label: id };
}

export function restartWinswService({ id, home } = {}) {
  const serviceExePath = winswExecutablePath({ id, home });
  const configPath = winswConfigPath({ id, home });
  if (!existsSync(serviceExePath) || !existsSync(configPath)) return false;
  try {
    runPs(`& ${psQuote(serviceExePath)} restart ${psQuote(configPath)} | Out-Null`);
    return true;
  } catch {
    try {
      runPs(`
try { & ${psQuote(serviceExePath)} stop ${psQuote(configPath)} --force --no-wait | Out-Null } catch {}
Start-Sleep -Seconds 1
& ${psQuote(serviceExePath)} start ${psQuote(configPath)} | Out-Null
`);
      return true;
    } catch {
      return false;
    }
  }
}

export function uninstallWinswService({ id, home } = {}) {
  const serviceExePath = winswExecutablePath({ id, home });
  const configPath = winswConfigPath({ id, home });
  const legacyRunKey = legacyRunKeyForService(id);
  if (!existsSync(serviceExePath)) {
    if (legacyRunKey) {
      try {
        runPs(`Remove-ItemProperty -Path ${psQuote(REG_RUN)} -Name ${psQuote(legacyRunKey)} -ErrorAction SilentlyContinue`);
      } catch {}
    }
    return false;
  }
  try {
    runPs(generateWinswUninstallScript({ serviceExePath, configPath, legacyRunKey }));
    return true;
  } catch {
    return false;
  }
}

/** Pure builder — returns the PowerShell script text without executing it. */
/**
 * Build a block of `$env:KEY = 'value'` lines from an object.
 * Only non-empty values are emitted. Single quotes in values are escaped.
 */
function buildEnvSetLines(envVars = {}) {
  return Object.entries(envVars)
    .filter(([, v]) => v != null && String(v).length > 0)
    .map(([k, v]) => `$env:${k} = '${escapePs(String(v))}'`)
    .join('\n');
}

function generateManagedHeadroomLauncherScript({ headroomBin, argStr, envVars = {}, pidPath }) {
  const unsetBlock = buildServiceEnvUnsetLines({ os: 'windows' });
  const envBlock = buildEnvSetLines(envVars);
  return `
$ErrorActionPreference = 'Stop'
${unsetBlock}
${envBlock}
try { Remove-Item -Path '${escapePs(pidPath)}' -ErrorAction SilentlyContinue } catch {}
$proc = Start-Process -FilePath '${escapePs(headroomBin)}' -ArgumentList '${escapePs(argStr)}' -WindowStyle Hidden -PassThru
Set-Content -Path '${escapePs(pidPath)}' -Value $proc.Id -Encoding ASCII
Wait-Process -Id $proc.Id
Remove-Item -Path '${escapePs(pidPath)}' -ErrorAction SilentlyContinue
`.trim();
}

const MANAGED_MITM_ENV_KEYS = [
  'MYELIN_HEADROOM_PORT',
  'MYELIN_EGRESS_PORT',
  'MYELIN_COPILOT_HEADROOM_PORT',
  'MYELIN_COMPRESS',
  'MYELIN_BLOCK_BYPASS',
  'MYELIN_BLOCK_MARKER',
  'MYELIN_OVERRIDE_PROXY',
  'MYELIN_VPN_DOMAINS_FILE',
  'MYELIN_EXTRA_PROVIDERS',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
  'HEADROOM_CA_BUNDLE',
];

function buildManagedMitmEnvLines(envVars = {}) {
  const keys = new Set([...MANAGED_MITM_ENV_KEYS, ...Object.keys(envVars)]);
  return Array.from(keys)
    .map((key) => {
      const value = envVars[key];
      if (value == null || String(value).length === 0) {
        return `[System.Environment]::SetEnvironmentVariable('${key}', $null, 'Process')`;
      }
      return `[System.Environment]::SetEnvironmentVariable('${key}', '${escapePs(collapseRedundantBackslashes(String(value)))}', 'Process')`;
    })
    .join('\n');
}

function buildManagedMitmCommandClauses({ executablePath, argStr, processVar = '$_' } = {}) {
  const exeName = windowsPath(executablePath).split('\\').pop();
  const clauses = [
    `${processVar}.CommandLine`,
    `${processVar}.CommandLine -match '${escapePs(escapePsRegex(argStr))}$'`,
  ];
  if (executablePath) {
    clauses.push(`(${processVar}.ExecutablePath -eq '${escapePs(windowsPath(executablePath))}' -or ${processVar}.Name -ieq '${escapePs(exeName)}')`);
  }
  return clauses;
}

export function parseManagedMitmLauncherScript(script = '') {
  const text = String(script ?? '');
  const match = text.match(/Start-Process -FilePath '((?:''|[^'])+)' -ArgumentList '((?:''|[^'])+)' -WindowStyle Hidden -PassThru/m);
  if (!match) return null;
  return {
    executablePath: match[1].replace(/''/g, "'"),
    argumentList: match[2].replace(/''/g, "'"),
  };
}

function readManagedMitmIdentity({
  home,
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  powershellExe = powerShellExecutable(),
} = {}) {
  const launcherPath = managedMitmLauncherPath({ home });
  const launcherScript = readWindowsScriptText(launcherPath, {
    execSyncImpl,
    existsSyncImpl,
    readFileSyncImpl,
    powershellExe,
  });
  if (!launcherScript) return null;
  const parsed = parseManagedMitmLauncherScript(launcherScript);
  if (!parsed) return null;
  return { ...parsed, launcherPath };
}

export function buildManagedMitmStatusScript({ pid, executablePath, argStr, launcherPath } = {}) {
  const exeName = windowsPath(executablePath).split('\\').pop();
  const launcherRegex = escapePs(escapePsRegex(windowsPath(launcherPath)));
  return [
    `$managedPid = ${pid}`,
    `$proc = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue`,
    `if ($proc -and $proc.Name -ieq '${escapePs(exeName)}' -and $proc.ExecutablePath -eq '${escapePs(windowsPath(executablePath))}' -and $proc.CommandLine -match '${escapePs(escapePsRegex(argStr))}$') {`,
    `  $parent = if ($proc.ParentProcessId) { Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }`,
    `  if ($parent -and $parent.CommandLine -match '${launcherRegex}') {`,
    `    'Running'`,
    `    return`,
    `  }`,
    `}`,
    `'Stopped'`,
  ].join('\n');
}

export function parseManagedMitmStatus(raw = '') {
  const text = trimPowershellOutput(raw);
  if (/^Running$/i.test(text)) {
    return { running: true, state: 'Running', raw: text };
  }
  if (/^Stopped$/i.test(text)) {
    return { running: false, state: 'Stopped', raw: text };
  }
  return { running: false, state: text || 'Unknown', raw: text };
}

function parseManagedHeadroomStatus(raw = '') {
  return parseManagedMitmStatus(raw);
}

function parseManagedHeadroomRunKeyValue(runKeyValue = '') {
  const value = String(runKeyValue ?? '').trim();
  const launcherMatch = value.match(/-File\s+"([^"]*start-headroom\.ps1)"/i);
  if (launcherMatch) return { launcherPath: launcherMatch[1] };
  return parseLegacyManagedHeadroomRunKeyValue({ runKeyValue: value });
}

function readManagedHeadroomIdentity({
  home = defaultWindowsHome(),
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  runKeyStatusImpl = headroomRunKeyStatus,
  powershellExe = powerShellExecutable(),
} = {}) {
  const runKeyStatus = runKeyStatusImpl({ execSyncImpl, powershellExe });
  const parsedRunKey = parseManagedHeadroomRunKeyValue(runKeyStatus?.raw) ?? {};
  if (!parsedRunKey.launcherPath && !parsedRunKey.executablePath && !parsedRunKey.argStr) return null;
  let executablePath = parsedRunKey.executablePath ?? '';
  let argStr = parsedRunKey.argStr ?? '';
  const launcherPath = parsedRunKey.launcherPath ?? '';
  const launcherScript = readWindowsScriptText(launcherPath, {
    execSyncImpl,
    existsSyncImpl,
    readFileSyncImpl,
    powershellExe,
  });
  if (launcherScript) {
    const parsedLauncher = parseLauncherStartProcess(launcherScript);
    executablePath = parsedLauncher?.executablePath ?? executablePath;
    argStr = parsedLauncher?.argStr ?? argStr;
  }
  return {
    launcherPath,
    executablePath,
    argStr,
    pidPath: managedHeadroomPidPath({ home }),
    port: portFromArgString(argStr),
  };
}

function readManagedCopilotHeadroomIdentity({
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  runKeyStatusImpl = copilotHeadroomRunKeyStatus,
  powershellExe = powerShellExecutable(),
} = {}) {
  const runKeyStatus = runKeyStatusImpl({ execSyncImpl, powershellExe });
  const parsedRunKey = parseCopilotHeadroomRunKeyValue(runKeyStatus?.raw) ?? {};
  let executablePath = parsedRunKey.executablePath ?? '';
  let argStr = parsedRunKey.argStr ?? '';
  const launcherScript = readWindowsScriptText(parsedRunKey.launcherPath, {
    execSyncImpl,
    existsSyncImpl,
    readFileSyncImpl,
    powershellExe,
  });
  if (launcherScript) {
    const parsedLauncher = parseLauncherStartProcess(launcherScript);
    executablePath = parsedLauncher?.executablePath ?? executablePath;
    argStr = parsedLauncher?.argStr ?? argStr;
  }
  return {
    launcherPath: parsedRunKey.launcherPath ?? '',
    executablePath,
    argStr,
    port: portFromArgString(argStr),
  };
}

function buildManagedMitmStopScript({ mitmdumpBin, argStr, launcherPath, pidFilePath } = {}) {
  const pidPath = windowsPath(pidFilePath ?? managedMitmPidPath());
  const commandClauses = buildManagedMitmCommandClauses({
    executablePath: mitmdumpBin,
    argStr,
    processVar: '$proc',
  });
  const fallbackClauses = buildManagedMitmCommandClauses({
    executablePath: mitmdumpBin,
    argStr,
  });
  const launcherRegex = escapePs(escapePsRegex(windowsPath(launcherPath)));
  const exeName = escapePs(windowsPath(mitmdumpBin).split('\\').pop());
  return [
    `$pidPath = '${escapePs(pidPath)}'`,
    `if (Test-Path $pidPath) {`,
    `  $managedPid = (Get-Content -Path $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1)`,
    `  if ($managedPid -and $managedPid.ToString().Trim() -match '^[0-9]+$') {`,
    `    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue`,
    `    if ($proc) {`,
    `      $parent = if ($proc.ParentProcessId) { Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }`,
    `      $matchesManagedLauncher = $parent -and $parent.CommandLine -match '${launcherRegex}'`,
    `      if ($matchesManagedLauncher -and ${commandClauses.join(' -and ')}) {`,
    `        Stop-Process -Id $managedPid -Force -ErrorAction SilentlyContinue`,
    `      }`,
    `    }`,
    `  }`,
    `  Remove-Item -Path $pidPath -ErrorAction SilentlyContinue`,
    `}`,
    `Get-CimInstance Win32_Process -Filter "Name = '${exeName}'" | ForEach-Object {`,
    `  $parent = if ($_.ParentProcessId) { Get-CimInstance Win32_Process -Filter "ProcessId = $($_.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }`,
    `  if (${fallbackClauses.join(' -and ')} -and $parent -and $parent.CommandLine -match '${launcherRegex}') {`,
    `    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue`,
    `  }`,
    `}`,
  ].join('\n');
}

function generateManagedMitmLauncherScript({ mitmdumpBin, argStr, envVars = {}, pidPath }) {
  const unsetBlock = buildServiceEnvUnsetLines({ os: 'windows' });
  const envBlock = buildManagedMitmEnvLines(envVars);
  return `
$ErrorActionPreference = 'Stop'
${unsetBlock}
${envBlock}
try { Remove-Item -Path '${escapePs(pidPath)}' -ErrorAction SilentlyContinue } catch {}
$proc = Start-Process -FilePath '${escapePs(windowsPath(mitmdumpBin))}' -ArgumentList '${escapePs(argStr)}' -WindowStyle Hidden -PassThru
Set-Content -Path '${escapePs(pidPath)}' -Value $proc.Id -Encoding ASCII
Wait-Process -Id $proc.Id
Remove-Item -Path '${escapePs(pidPath)}' -ErrorAction SilentlyContinue
`.trim();
}

export function generateHeadroomRunScript({ headroomBin, port, interceptToolResults, envVars = {}, home } = {}) {
  const bin = windowsPath(headroomBin);
  const exeName = bin.split('\\').pop();
  const args = buildHeadroomArgumentString({ port, interceptToolResults });
  const launcherPath = managedHeadroomLauncherPath({ home });
  const pidPath = managedHeadroomPidPath({ home });
  const launcherDir = pathWin32.dirname(launcherPath);
  const launcher = windowsPath(launcherPath);
  const launcherContent = generateManagedHeadroomLauncherScript({
    headroomBin: bin,
    argStr: args,
    envVars,
    pidPath: windowsPath(pidPath),
  });
  return `
New-Item -ItemType Directory -Force -Path '${escapePs(windowsPath(launcherDir))}' | Out-Null
Set-Content -Path '${escapePs(launcher)}' -Value @'
${launcherContent}
'@ -Encoding UTF8
${buildManagedHeadroomStopScript({ port, processExeName: exeName, pidFilePath: pidPath })}
Start-Sleep -Milliseconds 500
Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${escapePs(launcher)}"' -WindowStyle Hidden
Set-ItemProperty -Path '${REG_RUN}' -Name '${HEADROOM_KEY}' -Value 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${escapePs(launcher)}"'
Write-Host "[myelin] headroom started (hidden)"
`;
}

/**
 * Start a process that survives SSH session closure.
 *
 * `Start-Process -WindowStyle Hidden` spawns a child inside the SSH session's
 * Windows Job Object. When the SSH session ends, Windows terminates all
 * processes in that job. Task Scheduler bypasses this by scheduling the
 * process under the user's *interactive* Windows session (session 1), which
 * is independent of any SSH/script context.
 *
 * Falls back to Start-Process (with User-scope env var loading) when Task
 * Scheduler registration fails (e.g. headless/non-interactive machine).
 *
 * @param {string}   taskName  Unique task name (alphanumeric + _-)
 * @param {string}   exe       Absolute path to the executable
 * @param {string}   argStr    Argument string (may contain spaces and quoted paths)
 * @param {object}   [deps]    Injected dependencies for testing
 */
export function spawnDetachedService(taskName, exe, argStr, { runPsFn = runPs, taskEnv = {} } = {}) {
  const safeName = taskName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeExe  = escapePs(exe);
  const safeArgs = escapePs(argStr);
  // User-scope env vars to pre-load in the fallback path (SSH sessions don't inherit them)
  const envKeys = ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'HEADROOM_CA_BUNDLE',
                   'NODE_EXTRA_CA_CERTS', 'OPENAI_TARGET_URL', 'ANTHROPIC_BASE_URL'];
  const loadEnvFallback = envKeys
    .map(k => `$v = [Environment]::GetEnvironmentVariable('${k}','User'); if ($v) { Set-Item -Path 'Env:${k}' -Value $v }`)
    .join('\n');

  // Task-specific env vars (e.g. HEADROOM_WORKSPACE_DIR for state isolation).
  // New-ScheduledTaskAction has no -Environment param in PS 5.1.
  // We write a .bat launcher that sets the vars before starting the exe,
  // then use that .bat as the scheduled task action — simple and debuggable.
  const hasTaskEnv = Object.keys(taskEnv).length > 0;
  const stateDir = join(homedir(), '.myelin', 'state');
  const launcherBat = join(stateDir, `${safeName}-launcher.bat`);
  const safeLauncher = escapePs(launcherBat);

  let preLaunchLines = [];
  let actLine;
  if (hasTaskEnv) {
    const batLines = [
      '@echo off',
      ...Object.entries(taskEnv).map(([k, v]) => `set "${k}=${taskEnvValue(k, v)}"`),
      `"${windowsPath(exe)}" ${argStr}`,
    ];
    preLaunchLines = [
      `New-Item -ItemType Directory -Force -Path '${escapePs(stateDir)}' | Out-Null`,
      `Set-Content -Path '${safeLauncher}' -Value @'
${batLines.join('\r\n')}
'@ -Encoding ASCII`,
    ];
    actLine = `$act = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/C "${windowsPath(launcherBat)}"'`;
  } else {
    actLine = `$act = New-ScheduledTaskAction -Execute $exe -Argument $argStr`;
  }
  const fallbackEnvLines = hasTaskEnv
    ? Object.entries(taskEnv).map(([k, v]) => `Set-Item -Path 'Env:${k}' -Value '${escapePs(taskEnvValue(k, v))}'`).join('\n')
    : '';

  runPsFn([
    `$tn = '${safeName}'`,
    `$exe = '${safeExe}'`,
    `$argStr = '${safeArgs}'`,
    ...preLaunchLines,
    `Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue`,
    actLine,
    `$pri = New-ScheduledTaskPrincipal -UserId ([Environment]::UserName) -LogonType Interactive -RunLevel Limited`,
    `$set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)`,
    `$reg = Register-ScheduledTask -TaskName $tn -Action $act -Principal $pri -Settings $set -Force -ErrorAction SilentlyContinue`,
    `if ($reg) {`,
    `  Start-ScheduledTask -TaskName $tn`,
    `  Start-Sleep -Seconds 5`,
    `  Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue`,
    `} else {`,
    loadEnvFallback,
    ...(fallbackEnvLines ? [fallbackEnvLines] : []),
    `  Start-Process -FilePath $exe -ArgumentList $argStr.Split(' ') -WindowStyle Hidden`,
    `}`,
  ].join('\n'));
}


export async function installService({ headroomBin, port, envVars = {}, logPath, home, interceptToolResults, manager = 'registry' }) {
  // Move --intercept-tool-results from CLI flag to env var to avoid startup hang
  // (the CLI flag triggers ensure_tools() which downloads ast-grep; env var bypasses it)
  const mergedEnv = interceptToolResults ? { HEADROOM_INTERCEPT_ENABLED: '1', ...envVars } : envVars;
  if (manager !== 'winsw') {
    runPs(generateHeadroomRunScript({ headroomBin, port, interceptToolResults: false, envVars: mergedEnv, home }));
    return { ok: true, manager: 'registry' };
  }
  return installWinswService({
    id: HEADROOM_SERVICE_ID,
    name: 'Myelin Headroom',
    description: 'Myelin token-efficiency proxy (Headroom)',
    executable: headroomBin,
    arguments: buildHeadroomArgumentString({ port }),
    envVars: mergedEnv,
    logPath,
    home,
  });
}

/**
 * Pure builder — returns the PowerShell script text for the dedicated
 * Copilot-Headroom instance (distinct from the Claude-Headroom instance
 * above). Gives it its own working directory (via Set-Location before
 * Start-Process) so its memory/cache/stats state never collides with the
 * Claude-Headroom instance's own state (headroom has no dedicated
 * HEADROOM_HOME-style env var — WorkingDirectory/cwd is the isolation
 * mechanism, matching the launchd.mjs implementation).
 * NOT live-tested on Windows — review carefully before relying on it.
 */
export function generateCopilotHeadroomRunScript({ headroomBin, port, mode, workingDirectory, envVars = {} }) {
  const bin = windowsPath(headroomBin);
  const exeName = bin.split('\\').pop();
  const workDir = windowsPath(workingDirectory ?? '');
  const args = buildCopilotHeadroomArgumentString({ port, mode });
  const envLines = Object.entries(envVars)
    .map(([k, v]) => `[System.Environment]::SetEnvironmentVariable('${k}', '${String(v ?? '').replace(/'/g, "''")}', 'Process')`)
    .join('\n');
  const unsetBlock = buildServiceEnvUnsetLines({ os: 'windows' });
  const launcherPath = pathWin32.join(workDir, 'start-copilot-headroom.ps1');
  const launcher = windowsPath(launcherPath);
  const launcherContent = `
# Managed by myelin. Keeps Copilot-Headroom env scoped to this process tree.
${unsetBlock}
${envLines}
Start-Process -FilePath '${bin}' -ArgumentList '${args}' -WorkingDirectory '${workDir}' -WindowStyle Hidden
`.trim();
  return `
# Clear client-side provider env vars from Process scope before starting the
# dedicated copilot-headroom instance — its own routing target is set below
# via envVars, so it must not inherit stray ANTHROPIC_BASE_URL etc.
${unsetBlock}
${envLines}
New-Item -ItemType Directory -Force -Path '${workDir}' | Out-Null
Set-Content -Path '${launcher}' -Value @'
${launcherContent}
'@ -Encoding UTF8
${stopByPortScript(exeName, port)}
Start-Sleep -Milliseconds 500
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File '${launcher}'
Set-ItemProperty -Path '${REG_RUN}' -Name '${COPILOT_HEADROOM_KEY}' -Value 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${launcher}"'
Write-Host "[myelin] copilot-headroom started (hidden)"
`;
}

export async function installCopilotHeadroomService({ headroomBin, port, envVars = {}, logPath, home, manager = 'registry' }) {
  if (manager !== 'winsw') {
    const workingDirectory = pathWin32.join(defaultWindowsHome(home), '.myelin', 'copilot-headroom');
    runPs(generateCopilotHeadroomRunScript({ headroomBin, port, mode: envVars.HEADROOM_MODE, workingDirectory, envVars }));
    return { ok: true, manager: 'registry' };
  }
  return installWinswService({
    id: COPILOT_HEADROOM_SERVICE_ID,
    name: 'Myelin Copilot Headroom',
    description: 'Myelin dedicated Copilot CLI proxy (Headroom)',
    executable: headroomBin,
    arguments: buildCopilotHeadroomArgumentString({ port, mode: envVars.HEADROOM_MODE }),
    envVars,
    logPath,
    home,
  });
}

function copilotHeadroomRunKeyStatus({ execSyncImpl = execSync, powershellExe = powerShellExecutable() } = {}) {
  try {
    const raw = trimPowershellOutput(execSyncImpl(
      withPowerShell(`-NoProfile -Command "(Get-ItemProperty -Path '${REG_RUN}' -Name '${COPILOT_HEADROOM_KEY}' -ErrorAction SilentlyContinue).'${COPILOT_HEADROOM_KEY}'"`, powershellExe),
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString());
    return { registered: !!raw, raw };
  } catch {
    return { registered: false, raw: '' };
  }
}

export function copilotHeadroomServiceStatus({
  manager = 'registry',
  port = 8788,
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  runKeyStatusImpl = copilotHeadroomRunKeyStatus,
  powershellExe = powerShellExecutable(),
} = {}) {
  if (manager !== 'winsw') {
    try {
      const identity = readManagedCopilotHeadroomIdentity({
        execSyncImpl,
        existsSyncImpl,
        readFileSyncImpl,
        runKeyStatusImpl,
        powershellExe,
      });
      const configuredPort = Number(port);
      const effectivePort = identity?.port ?? (Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 8788);
      const script = buildManagedHeadroomStatusScript({
        executablePath: identity?.executablePath,
        argStr: identity?.argStr,
        launcherPath: identity?.launcherPath,
        port: effectivePort,
      }).replace(/"/g, '\\"');
      const raw = trimPowershellOutput(execSyncImpl(
        withPowerShell(`-NoProfile -Command "& { ${script} }"`, powershellExe),
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ).toString());
      return parseManagedHeadroomStatus(raw);
    } catch {
      return { running: false, state: 'Unknown', raw: '' };
    }
  }
  return winswServiceStatus({ id: COPILOT_HEADROOM_SERVICE_ID });
}

/** Pure builder — returns the PowerShell script text without executing it.
 *  When egressPort is provided, mitmdump gets a SECOND --mode regular@PORT
 *  listener (egress-only leg for a dedicated Copilot-Headroom instance's
 *  own outbound calls) instead of --listen-port. See launchd.mjs for the
 *  same dual-listener design on macOS.
 */
/**
 * Undo any accumulated backslash-doubling corruption before persisting a
 * value via SetEnvironmentVariable, without breaking a legitimate UNC path
 * prefix (`\\server\share`, which genuinely starts with two backslashes).
 * Collapses any run of 2+ consecutive backslashes elsewhere in the string
 * down to exactly one. Self-healing: if a previously-corrupted value is
 * ever read back out of the registry and re-persisted through this path,
 * it gets fixed rather than doubled again.
 */
export function collapseRedundantBackslashes(value) {
  const str = String(value ?? '');
  const uncPrefix = str.startsWith('\\\\') ? '\\\\' : '';
  const rest = str.slice(uncPrefix.length);
  return uncPrefix + rest.replace(/\\{2,}/g, '\\');
}

export function generateMitmRunScript({ mitmdumpBin, port, addonPath, envVars = {}, egressPort, home } = {}) {
  const bin = normalizeWindowsFilesystemPath(mitmdumpBin);
  const addon = normalizeWindowsFilesystemPath(addonPath);
  const ca = normalizeWindowsFilesystemPath(envVars.SSL_CERT_FILE || envVars.REQUESTS_CA_BUNDLE || envVars.NODE_EXTRA_CA_CERTS || '');
  const caArg = ca ? ` --set ssl_verify_upstream_trusted_ca="${ca}"` : '';
  const proxyArg = (envVars.HTTPS_PROXY && !envVars.HTTPS_PROXY.includes('127.0.0.1') && !envVars.HTTPS_PROXY.includes('localhost')) ? ` --mode upstream:${envVars.HTTPS_PROXY}` : '';
  const listenArg = egressPort ? `--mode regular@${port} --mode regular@127.0.0.1:${egressPort}` : `--listen-port ${port}`;
  const args = `${listenArg} -s "${addon}"${proxyArg}${caArg}`;
  const normalizedHome = normalizeWindowsFilesystemPath(home);
  const launcherPath = managedMitmLauncherPath({ home: normalizedHome });
  const pidPath = managedMitmPidPath({ home: normalizedHome });
  const launcherDir = pathWin32.dirname(launcherPath);
  const launcher = windowsPath(launcherPath);
  const managedEnv = {
    ...(egressPort ? { MYELIN_EGRESS_PORT: String(egressPort) } : {}),
    ...envVars,
  };
  const launcherContent = generateManagedMitmLauncherScript({
    mitmdumpBin: bin,
    argStr: args,
    envVars: managedEnv,
    pidPath: windowsPath(pidPath),
  });
  return `
New-Item -ItemType Directory -Force -Path '${escapePs(windowsPath(launcherDir))}' | Out-Null
Set-Content -Path '${escapePs(launcher)}' -Value @'
${launcherContent}
'@ -Encoding UTF8
${buildManagedMitmStopScript({ mitmdumpBin: bin, argStr: args, launcherPath, pidFilePath: pidPath })}
Start-Sleep -Milliseconds 500
Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${escapePs(launcher)}"' -WindowStyle Hidden
Set-ItemProperty -Path '${REG_RUN}' -Name '${MITM_KEY}' -Value 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${escapePs(launcher)}"'
Write-Host "[myelin] mitmproxy started (hidden)"
`;
}

export async function installMitmService({ mitmdumpBin, port, addonPath, envVars = {}, logPath, home, upstreamProxy, egressPort, manager = 'registry' }) {
  if (manager !== 'winsw') {
    runPs(generateMitmRunScript({ mitmdumpBin, port, addonPath, envVars, egressPort, home }));
    return { ok: true, manager: 'registry' };
  }
  return installWinswService({
    id: MITM_SERVICE_ID,
    name: 'Myelin Mitmproxy',
    description: 'Myelin mitmproxy LLM compression proxy',
    executable: mitmdumpBin,
    arguments: buildMitmArgumentString({ mitmdumpBin, port, addonPath, envVars, egressPort, upstreamProxy }),
    envVars: { ...(egressPort ? { MYELIN_EGRESS_PORT: String(egressPort) } : {}), ...envVars },
    logPath,
    home,
  });
}

export function mitmServiceStatus({
  manager = 'registry',
  home,
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  powershellExe = powerShellExecutable(),
} = {}) {
  if (manager !== 'winsw') {
    try {
      const identity = readManagedMitmIdentity({
        home,
        execSyncImpl,
        existsSyncImpl,
        readFileSyncImpl,
        powershellExe,
      });
      const pidText = identity
        ? trimPowershellOutput(readWindowsFileText(managedMitmPidPath({ home }), {
            execSyncImpl,
            existsSyncImpl,
            readFileSyncImpl,
            powershellExe,
          }))
        : '';
      if (!identity || !pidText || !/^[0-9]+$/u.test(pidText)) {
        return { running: false, state: 'Stopped', raw: '' };
      }
      const script = buildManagedMitmStatusScript({
        pid: pidText,
        executablePath: identity.executablePath,
        argStr: identity.argumentList,
        launcherPath: identity.launcherPath,
      }).replace(/"/g, '\\"');
      const raw = execSyncImpl(withPowerShell(`-NoProfile -Command "& { ${script} }"`, powershellExe), { stdio: 'pipe' }).toString();
      return parseManagedMitmStatus(raw);
    } catch {
      return { running: false, state: 'Unknown' };
    }
  }
  return winswServiceStatus({ id: MITM_SERVICE_ID });
}

export function serviceStatus({
  manager = 'registry',
  home = defaultWindowsHome(),
  port = 8787,
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  runKeyStatusImpl = headroomRunKeyStatus,
  powershellExe = powerShellExecutable(),
} = {}) {
  if (manager !== 'winsw') {
    try {
      const identity = readManagedHeadroomIdentity({
        home,
        execSyncImpl,
        existsSyncImpl,
        readFileSyncImpl,
        runKeyStatusImpl,
        powershellExe,
      });
      const hasLegacyIdentity = !!identity?.executablePath && !!identity?.argStr && !identity?.launcherPath;
      const hasManagedLauncherIdentity = !!identity?.launcherPath && !!identity?.executablePath && !!identity?.argStr;
      if (!hasLegacyIdentity && !hasManagedLauncherIdentity) {
        return { running: false, state: 'Stopped', raw: '' };
      }
      const configuredPort = Number(port);
      const effectivePort = identity.port ?? (Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 8787);
      let script;
      if (hasManagedLauncherIdentity) {
        const pidText = trimPowershellOutput(readWindowsFileText(identity.pidPath, {
          execSyncImpl,
          existsSyncImpl,
          readFileSyncImpl,
          powershellExe,
        }));
        if (!pidText || !/^[0-9]+$/u.test(pidText)) {
          return { running: false, state: 'Stopped', raw: '' };
        }
        script = buildManagedHeadroomStatusScript({
          pid: pidText,
          executablePath: identity.executablePath,
          argStr: identity.argStr,
          launcherPath: identity.launcherPath,
          port: effectivePort,
        }).replace(/"/g, '\\"');
      } else {
        script = buildManagedHeadroomStatusScript({
          executablePath: identity.executablePath,
          argStr: identity.argStr,
          port: effectivePort,
        }).replace(/"/g, '\\"');
      }
      const raw = trimPowershellOutput(execSyncImpl(
        withPowerShell(`-NoProfile -Command "& { ${script} }"`, powershellExe),
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ).toString());
      return parseManagedHeadroomStatus(raw);
    } catch {
      return { running: false, state: 'Unknown', raw: '' };
    }
  }
  return winswServiceStatus({ id: HEADROOM_SERVICE_ID });
}

export function headroomRunKeyStatus({ execSyncImpl = execSync, powershellExe = powerShellExecutable() } = {}) {
  try {
    const raw = trimPowershellOutput(execSyncImpl(
      withPowerShell(`-NoProfile -Command "(Get-ItemProperty -Path '${REG_RUN}' -Name '${HEADROOM_KEY}' -ErrorAction SilentlyContinue).'${HEADROOM_KEY}'"`, powershellExe),
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString());
    return { registered: !!raw, raw };
  } catch {
    return { registered: false, raw: '' };
  }
}

export function readUserEnvVars(keys = [], { execSyncImpl = execSync, powershellExe = powerShellExecutable() } = {}) {
  const env = {};
  for (const key of keys) {
    try {
      const value = trimPowershellOutput(execSyncImpl(
        withPowerShell(`-NoProfile -NonInteractive -Command "[Environment]::GetEnvironmentVariable('${key}','User')"`, powershellExe),
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ).toString());
      if (value) env[key] = value;
    } catch {}
  }
  return env;
}

/**
 * Pure builder — returns PowerShell script text that persists environment
 * variables via the registry (HKCU\Environment, through .NET's
 * [Environment]::SetEnvironmentVariable(..., 'User')). This is what lets
 * new PowerShell/cmd windows pick up HEADROOM_PORT/ANTHROPIC_BASE_URL/CA
 * bundle vars automatically WITHOUT ever touching $PROFILE — critical on
 * machines where Windows Defender's Controlled Folder Access blocks writes
 * into Documents\WindowsPowerShell (confirmed live: $PROFILE always
 * resolves there, and CFA silently blocks New-Item/Add-Content into it
 * with no thrown error, even with full NTFS control). A registry write
 * via .NET isn't a protected-folder filesystem write, so CFA doesn't apply.
 *
 * Only single-quotes need escaping in PowerShell single-quoted strings
 * (double them) — backslashes are literal and must NOT be doubled (a
 * mistake made and fixed earlier in this same file's history).
 */
export function generateSetUserEnvVarsScript(vars) {
  return Object.entries(vars)
    // collapseRedundantBackslashes here too so a value corrupted by the
    // sibling generateMitmRunScript bug (fixed above) self-heals wherever
    // it happens to be re-persisted from, not just at its original source.
    .map(([k, v]) => `[Environment]::SetEnvironmentVariable('${k}', '${collapseRedundantBackslashes(v).replace(/'/g, "''")}', 'User')`)
    .join('\n') + '\n';
}

/** Persist env vars to the registry so new sessions inherit them without $PROFILE. */
export function setUserEnvVars(vars) {
  try {
    runPs(generateSetUserEnvVarsScript(vars));
    return true;
  } catch {
    return false;
  }
}

export function installWindowsWatchdogTask({
  id,
  taskName = windowsWatchdogTaskName({ id }),
  serviceName = taskName.replace(/ Watchdog$/, ''),
  healthUrl,
  intervalMinutes = 2,
  winswConfigPath: configPathOverride,
  home,
} = {}) {
  const winHome = defaultWindowsHome(home);
  const serviceExePath = winswExecutablePath({ id, home: winHome });
  const configPath = configPathOverride ?? winswConfigPath({ id, home: winHome });
  if (!existsSync(serviceExePath) || !existsSync(configPath)) {
    throw new Error(`WinSW service assets missing for ${id}`);
  }

  const scriptPath = winswWatchdogScriptPath({ id, home: winHome });
  const logPath = winswWatchdogLogPath({ id, home: winHome });
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, generateWindowsWatchdogHealthcheckScript({
    serviceName,
    healthUrl,
    winswExePath: serviceExePath,
    winswConfigPath: configPath,
    logPath,
  }), 'utf8');
  runPs(generateWindowsWatchdogTaskCreateScript({ taskName, scriptPath, intervalMinutes }));
  return { taskName, scriptPath, logPath };
}

/**
 * Windows gets a second-layer health watchdog only for HTTP-serving Headroom
 * instances. WinSW already handles crash/exit restarts for all services;
 * this Scheduled Task layer specifically catches the "process still exists
 * but /health stopped responding" class of failure that a pure supervisor
 * cannot see.
 */
export function installWatchdog({
  home,
  enabled = false,
  headroomPort,
  copilotHeadroomPort,
  intervalMinutes = 2,
} = {}) {
  if (!enabled) return null;
  const tasks = [];
  if (headroomPort != null) {
    tasks.push(installWindowsWatchdogTask({
      id: HEADROOM_SERVICE_ID,
      serviceName: 'Myelin Headroom',
      healthUrl: headroomHealthUrl(headroomPort),
      intervalMinutes,
      home,
    }));
  }
  if (copilotHeadroomPort) {
    tasks.push(installWindowsWatchdogTask({
      id: COPILOT_HEADROOM_SERVICE_ID,
      serviceName: 'Myelin Copilot Headroom',
      healthUrl: headroomHealthUrl(copilotHeadroomPort),
      intervalMinutes,
      home,
    }));
  }
  return tasks;
}
