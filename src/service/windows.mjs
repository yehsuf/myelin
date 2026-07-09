import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, win32 as pathWin32 } from 'node:path';
import { headroomHealthUrl } from '../tools/headroom.mjs';
import { installWinsw } from '../tools/winsw.mjs';

const REG_RUN = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const HEADROOM_KEY = 'MyelinHeadroom';
const MITM_KEY = 'MyelinMitmproxy';
const COPILOT_HEADROOM_KEY = 'MyelinCopilotHeadroom';

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

function runPs(script, { stdio = 'pipe' } = {}) {
  const stateDir = join(homedir(), '.myelin', 'state');
  mkdirSync(stateDir, { recursive: true });
  const tmp = join(stateDir, `myelin-${process.pid}-${Date.now()}.ps1`);
  writeFileSync(tmp, script, 'utf8');
  try {
    execSync(`powershell -ExecutionPolicy Bypass -File "${tmp}"`, { stdio });
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

function xmlEscape(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function defaultWindowsHome(home = process.env.USERPROFILE ?? homedir()) {
  return windowsPath(home);
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

function buildHeadroomArgumentString({ port, interceptToolResults }) {
  return `proxy --port ${port}${interceptToolResults ? ' --intercept-tool-results' : ''}`;
}

function buildCopilotHeadroomArgumentString({ port, mode }) {
  return `proxy --port ${port} --mode ${mode ?? 'cache'} --connect-timeout-seconds 10`;
}

function buildMitmArgumentString({ mitmdumpBin, port, addonPath, envVars = {}, egressPort, upstreamProxy }) {
  const args = egressPort
    ? ['--mode', `regular@${port}`, '--mode', `regular@${egressPort}`, '-s', windowsPath(addonPath)]
    : ['--listen-port', String(port), '-s', windowsPath(addonPath)];

  const proxy = upstreamProxy || envVars.HTTPS_PROXY || envVars.https_proxy || '';
  if (proxy && !proxy.includes('127.0.0.1') && !proxy.includes('localhost')) {
    args.push('--mode', `upstream:${proxy}`);
  }

  const caBundle = envVars.SSL_CERT_FILE || envVars.REQUESTS_CA_BUNDLE ||
                   envVars.NODE_EXTRA_CA_CERTS || envVars.HEADROOM_CA_BUNDLE || '';
  if (caBundle) args.push('--set', `ssl_verify_upstream_trusted_ca=${windowsPath(caBundle)}`);

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
function stopByPortScript(processExeName, port) {
  return `Get-CimInstance Win32_Process -Filter "Name = '${processExeName}'" | Where-Object { $_.CommandLine -like '*--port ${port}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
}

export function winswServiceDir({ id, home = process.env.USERPROFILE ?? homedir() } = {}) {
  return pathWin32.join(defaultWindowsHome(home), '.myelin', 'services', id);
}

export function winswExecutablePath({ id, home = process.env.USERPROFILE ?? homedir() } = {}) {
  return pathWin32.join(winswServiceDir({ id, home }), `${id}.exe`);
}

export function winswConfigPath({ id, home = process.env.USERPROFILE ?? homedir() } = {}) {
  return pathWin32.join(winswServiceDir({ id, home }), `${id}.xml`);
}

export function windowsWatchdogTaskName({ id }) {
  if (id === COPILOT_HEADROOM_SERVICE_ID) return 'Myelin Copilot Headroom Watchdog';
  return 'Myelin Headroom Watchdog';
}

function winswWatchdogScriptPath({ id, home = process.env.USERPROFILE ?? homedir() } = {}) {
  return pathWin32.join(winswServiceDir({ id, home }), 'watchdog.ps1');
}

function winswWatchdogLogPath({ id, home = process.env.USERPROFILE ?? homedir() } = {}) {
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
  home = process.env.USERPROFILE ?? homedir(),
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

export function winswServiceStatus({ id, home = process.env.USERPROFILE ?? homedir() } = {}) {
  const serviceExePath = winswExecutablePath({ id, home });
  const configPath = winswConfigPath({ id, home });
  if (!existsSync(serviceExePath) || !existsSync(configPath)) {
    return { running: false, state: 'Missing', label: id, raw: '' };
  }

  let raw = '';
  try {
    raw = execSync(`powershell -Command "& ${psQuote(serviceExePath)} status ${psQuote(configPath)}"`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
  } catch (error) {
    raw = `${error?.stdout?.toString?.() ?? ''}${error?.stderr?.toString?.() ?? ''}`.trim();
  }

  return { ...parseWinswServiceStatus(raw), label: id };
}

export function restartWinswService({ id, home = process.env.USERPROFILE ?? homedir() } = {}) {
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

export function uninstallWinswService({ id, home = process.env.USERPROFILE ?? homedir() } = {}) {
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
export function generateHeadroomRunScript({ headroomBin, port, interceptToolResults }) {
  const bin = windowsPath(headroomBin);
  const exeName = bin.split('\\').pop();
  const args = buildHeadroomArgumentString({ port, interceptToolResults });
  // Kill only the existing instance on this exact port, start fresh hidden, persist via registry
  return `
${stopByPortScript(exeName, port)}
Start-Sleep -Milliseconds 500
Start-Process -FilePath '${bin}' -ArgumentList '${args}' -WindowStyle Hidden
Set-ItemProperty -Path '${REG_RUN}' -Name '${HEADROOM_KEY}' -Value '"${bin}" ${args}'
Write-Host "[myelin] headroom started (hidden)"
`;
}

export async function installService({ headroomBin, port, envVars = {}, logPath, home, interceptToolResults, manager = 'registry' }) {
  if (manager !== 'winsw') {
    runPs(generateHeadroomRunScript({ headroomBin, port, interceptToolResults }));
    return { ok: true, manager: 'registry' };
  }
  return installWinswService({
    id: HEADROOM_SERVICE_ID,
    name: 'Myelin Headroom',
    description: 'Myelin token-efficiency proxy (Headroom)',
    executable: headroomBin,
    arguments: buildHeadroomArgumentString({ port, interceptToolResults }),
    envVars,
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
  return `
${envLines}
New-Item -ItemType Directory -Force -Path '${workDir}' | Out-Null
${stopByPortScript(exeName, port)}
Start-Sleep -Milliseconds 500
Start-Process -FilePath '${bin}' -ArgumentList '${args}' -WorkingDirectory '${workDir}' -WindowStyle Hidden
Set-ItemProperty -Path '${REG_RUN}' -Name '${COPILOT_HEADROOM_KEY}' -Value '"${bin}" ${args}'
Write-Host "[myelin] copilot-headroom started (hidden)"
`;
}

export async function installCopilotHeadroomService({ headroomBin, port, envVars = {}, logPath, home, manager = 'registry' }) {
  if (manager !== 'winsw') {
    const workingDirectory = join(home ?? process.env.USERPROFILE ?? '.', '.myelin', 'copilot-headroom');
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

export function copilotHeadroomServiceStatus({ manager = 'registry' } = {}) {
  if (manager !== 'winsw') {
    try {
      const out = execSync(`powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'headroom.exe'\\" | Where-Object { $_.CommandLine -like '*copilot-headroom*' -or $_.CommandLine -like '*--port 8788*' } | Select-Object -First 1 -ExpandProperty ProcessId"`, { stdio: 'pipe' }).toString().trim();
      return { running: !!out, state: out ? 'Running' : 'Stopped' };
    } catch {
      return { running: false, state: 'Unknown' };
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

export function generateMitmRunScript({ mitmdumpBin, port, addonPath, envVars = {}, egressPort }) {
  const bin = windowsPath(mitmdumpBin);
  const addon = windowsPath(addonPath);
  const ca = windowsPath(envVars.SSL_CERT_FILE || envVars.REQUESTS_CA_BUNDLE || envVars.NODE_EXTRA_CA_CERTS || '');
  const caArg = ca ? ` --set ssl_verify_upstream_trusted_ca="${ca}"` : '';
  const proxyArg = (envVars.HTTPS_PROXY && !envVars.HTTPS_PROXY.includes('127.0.0.1') && !envVars.HTTPS_PROXY.includes('localhost')) ? ` --mode upstream:${envVars.HTTPS_PROXY}` : '';
  const listenArg = egressPort ? `--mode regular@${port} --mode regular@${egressPort}` : `--listen-port ${port}`;
  const args = `${listenArg} -s "${addon}"${proxyArg}${caArg}`;
  const envLines = Object.entries({
    ...(egressPort ? { MYELIN_EGRESS_PORT: String(egressPort) } : {}),
    ...envVars,
  })
    // PowerShell single-quoted strings are literal - backslashes never need
    // escaping there (only a literal single-quote doubles: ' -> ''). This
    // line previously doubled every backslash unconditionally, which is
    // wrong on its own, and because this script persists to the registry
    // (User scope) and gets read back as input on the next run, it silently
    // compounded across restarts: one clean path became doubled, then
    // quadrupled, then octupled backslashes over successive `myelin
    // restart`/install runs - observed live as a NetFree CA path corrupted
    // to 8 backslashes per separator. collapseRedundantBackslashes() both
    // stops the bug and self-heals any value that was already corrupted by
    // it in a prior run.
    .map(([k, v]) => `[System.Environment]::SetEnvironmentVariable('${k}', '${collapseRedundantBackslashes(v).replace(/'/g, "''")}', 'User')`)
    .join('\n');
  return `
${envLines}
Stop-Process -Name mitmdump -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Start-Process -FilePath '${bin}' -ArgumentList '${args}' -WindowStyle Hidden
Set-ItemProperty -Path '${REG_RUN}' -Name '${MITM_KEY}' -Value '"${bin}" ${args}'
Write-Host "[myelin] mitmproxy started (hidden)"
`;
}

export async function installMitmService({ mitmdumpBin, port, addonPath, envVars = {}, logPath, home, upstreamProxy, egressPort, manager = 'registry' }) {
  if (manager !== 'winsw') {
    // Registry path: byte-for-byte the original behavior (no --ignore-hosts,
    // no upstreamProxy support — those never existed on the Windows registry
    // path before WinSW; kept exclusive to buildMitmArgumentString below so
    // the default install is unchanged).
    runPs(generateMitmRunScript({ mitmdumpBin, port, addonPath, envVars, egressPort }));
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

export function mitmServiceStatus({ manager = 'registry' } = {}) {
  if (manager !== 'winsw') {
    try {
      const out = execSync(`powershell -Command "Get-Process mitmdump -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"`, { stdio: 'pipe' }).toString().trim();
      return { running: !!out, state: out ? 'Running' : 'Stopped' };
    } catch {
      return { running: false, state: 'Unknown' };
    }
  }
  return winswServiceStatus({ id: MITM_SERVICE_ID });
}

export function serviceStatus({ manager = 'registry' } = {}) {
  if (manager !== 'winsw') {
    try {
      const out = execSync(`powershell -Command "Get-Process headroom -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"`, { stdio: 'pipe' }).toString().trim();
      return { running: !!out, state: out ? 'Running' : 'Stopped' };
    } catch {
      return { running: false, state: 'Unknown' };
    }
  }
  return winswServiceStatus({ id: HEADROOM_SERVICE_ID });
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
  home = process.env.USERPROFILE ?? homedir(),
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
  headroomPort = 8787,
  copilotHeadroomPort,
  intervalMinutes = 2,
} = {}) {
  if (!enabled) return null;
  const tasks = [
    installWindowsWatchdogTask({
      id: HEADROOM_SERVICE_ID,
      serviceName: 'Myelin Headroom',
      healthUrl: headroomHealthUrl(headroomPort),
      intervalMinutes,
      home,
    }),
  ];
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
