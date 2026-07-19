import { execFileSync, execSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix as pathPosix, win32 as pathWin32 } from 'node:path';
import { headroomHealthUrl } from '../tools/headroom.mjs';
import { installWinsw, winswFilesystemPath } from '../tools/winsw.mjs';
import { powerShellExecutable } from '../detect/os.mjs';
import { isWsl } from '../detect/wsl.mjs';
import { buildServiceEnvUnsetLines } from './wrappers.mjs';
import { managedPaths, joinManaged, resolveMyelinRoot } from '../shared/myelin-paths.mjs';

const REG_RUN = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const HEADROOM_KEY = 'MyelinCompression';
const MITM_KEY = 'MyelinMitmproxy';
const COPILOT_HEADROOM_KEY = 'MyelinCopilotCompression';
const WSL_SYSTEM_PROFILE_NAMES = new Set(['public', 'all users', 'default', 'default user', 'windows', 'wpsystem']);
const nodeExecFileSync = execFileSync;
const nodeExecSync = execSync;
const nodeExistsSync = existsSync;
const nodeReaddirSync = readdirSync;

export const HEADROOM_SERVICE_ID = 'myelin-compression';
export const MITM_SERVICE_ID = 'myelin-mitmproxy';
export const COPILOT_HEADROOM_SERVICE_ID = 'myelin-copilot-compression';

function engineInstanceIdentity(instance = {}) {
  const { engine, role } = instance;
  if (!['headroom', 'headroom_lite'].includes(engine) || !['primary', 'copilot'].includes(role)) {
    throw new Error(`Unsupported engine instance: ${engine}-${role}`);
  }
  if (instance.legacy) {
    return role === 'primary'
      ? {
          id: HEADROOM_SERVICE_ID,
          runKey: HEADROOM_KEY,
          name: 'Myelin Headroom',
          description: 'Myelin token-efficiency proxy',
          launcherName: 'start-headroom.ps1',
          pidName: 'headroom.pid',
        }
      : {
          id: COPILOT_HEADROOM_SERVICE_ID,
          runKey: COPILOT_HEADROOM_KEY,
          name: 'Myelin Copilot Headroom',
          description: 'Myelin dedicated Copilot CLI proxy',
          launcherName: 'start-copilot-headroom.ps1',
          pidName: 'copilot-headroom.pid',
        };
  }
  const id = `${engine}-${role}`;
  if (instance.id !== id) {
    throw new Error(`Engine instance id must be ${id}`);
  }
  const title = id
    .split(/[-_]/u)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
  return {
    id,
    runKey: `Myelin${id.split(/[-_]/u).map((part) => part[0].toUpperCase() + part.slice(1)).join('')}`,
    name: `Myelin ${title}`,
    description: `Myelin ${title} proxy`,
    launcherName: `start-${id}.ps1`,
    pidName: `${id}.pid`,
  };
}

function engineInstanceCommand(instance = {}, { headroomBin, headroomLiteBin } = {}) {
  if (instance.engine === 'headroom') {
    if (!headroomBin) throw new Error('headroomBin is required for headroom engine instances');
    return {
      executable: headroomBin,
      arguments: `proxy --port ${instance.port}`,
      env: {},
    };
  }

  if (instance.engine === 'headroom_lite') {
    if (!headroomLiteBin) throw new Error('headroomLiteBin is required for headroom_lite engine instances');
    return {
      executable: headroomLiteBin,
      arguments: '',
      env: { HEADROOM_LITE_PORT: String(instance.port) },
    };
  }
  throw new Error(`Unsupported engine instance engine: ${instance.engine}`);
}

function commandForWindowsExecutable(executable, commandArguments = '') {
  const target = String(executable ?? '');
  const isBatchLauncher = /\.(?:cmd|bat)$/iu.test(target);
  if (!isBatchLauncher) {
    return {
      executable: target,
      arguments: commandArguments,
      isBatchLauncher: false,
      batchTarget: '',
    };
  }
  const quotedTarget = `"${target.replace(/"/g, '""')}"`;
  return {
    executable: 'cmd.exe',
    arguments: `/d /s /c "${quotedTarget}${commandArguments ? ` ${commandArguments}` : ''}"`,
    isBatchLauncher: true,
    batchTarget: target,
  };
}

function legacyEngineInstance({
  instance,
  engine = 'headroom',
  role,
  port,
  envVars = {},
  logPath,
  home,
  env = process.env,
} = {}) {
  if (instance) return instance;
  const winHome = defaultWindowsHome(home);
  const root = managedPaths({ home: winHome, env, platform: 'windows' }).root;
  const id = `${engine}-${role}`;
  const stateDir = role === 'primary'
    ? winswServiceDir({ id: HEADROOM_SERVICE_ID, home: winHome, env })
    : joinManaged(root, 'copilot-headroom');
  return {
    engine,
    role,
    port,
    id,
    legacy: true,
    stateDir,
    logPath: logPath ?? joinManaged(root, `${id}.log`),
    healthUrl: `http://127.0.0.1:${port}/health`,
    env: envVars,
  };
}

const MITM_IGNORE_HOSTS = [
  String.raw`.*\.akamai\.com`,
  String.raw`.*\.corp\.akamai\.com`,
  String.raw`.*\.akamaized\.net`,
  String.raw`.*\.akamaihd\.net`,
  String.raw`api\.github\.com`,
  String.raw`.*\.github\.com`,
  // Bare github.com (HTTPS git operations) — see launchd.mjs comment.
  String.raw`github\.com`,
].join('|');

function withPowerShell(args, powershellExe = powerShellExecutable()) {
  return `${powershellExe} ${args}`;
}

export function runPs(script, {
  stdio = 'pipe',
  powershellExe = powerShellExecutable(),
  home = homedir(),
  env = process.env,
  isWslImpl = isWsl,
  defaultWindowsHomeImpl = defaultWindowsHome,
  processId = process.pid,
  nowImpl = Date.now,
  mkdirSyncImpl = mkdirSync,
  writeFileSyncImpl = writeFileSync,
  execSyncImpl = execSync,
  execFileSyncImpl = execFileSync,
  unlinkSyncImpl = unlinkSync,
} = {}) {
  const wsl = isWslImpl();
  const windowsHome = defaultWindowsHomeImpl(home);
  const managedStateDir = managedPaths({
    home: windowsHome,
    env,
    platform: 'windows',
  }).serviceStatePath;
  const nativeStateDir = normalizeWindowsFilesystemPath(managedStateDir, { rejectPosix: true });
  const stateDir = wsl ? winswFilesystemPathFor(nativeStateDir, { isWslImpl }) : nativeStateDir;
  const filename = `myelin-${processId}-${nowImpl()}.ps1`;
  const tmp = wsl ? pathPosix.join(stateDir, filename) : join(stateDir, filename);
  const powershellScriptPath = wsl ? pathWin32.join(nativeStateDir, filename) : tmp;
  mkdirSyncImpl(stateDir, { recursive: true });
  writeFileSyncImpl(tmp, script, 'utf8');
  try {
    // Arg-array exec (never a command STRING): the MYELIN_DIR-derived managed
    // script path is a literal `-File` argument, so neither PowerShell/shell
    // parsing nor cmd.exe %VAR% expansion is ever applied to it.
    execFileSyncImpl(
      powershellExe,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', powershellScriptPath],
      { stdio },
    );
  } finally {
    try { unlinkSyncImpl(tmp); } catch {}
  }
}

/**
 * Injection-safe PowerShell command execution.
 *
 * Runs `powershellExe -NoProfile -Command <command>` via an ARGUMENT ARRAY
 * (execFileSync) — never a shell command STRING. On WSL `process.platform` is
 * `'linux'`, so `execSync('powershell.exe ... -Command "& { <script> }"')` is
 * handed to `/bin/sh -c` FIRST. `/bin/sh` sees the PowerShell single-quoted
 * managed/MYELIN_DIR-derived paths as ordinary text inside its own double
 * quotes and command-substitutes any `$(...)`/backtick sequences in them
 * (both are legal Windows filename chars, survive `escapePs`, and MYELIN_DIR is
 * untrusted) BEFORE PowerShell ever runs — arbitrary code execution. Passing
 * the whole command as ONE literal argv element means no shell (`/bin/sh` on
 * WSL/Linux, or `cmd.exe` on Windows) re-parses it on any platform; only
 * PowerShell interprets it, where the single-quoting is sufficient.
 */
function runPsCommand(command, {
  powershellExe = powerShellExecutable(),
  execFileSyncImpl = execFileSync,
  prefixArgs = ['-NoProfile', '-Command'],
  stdio,
} = {}) {
  const options = stdio === undefined ? {} : { stdio };
  return execFileSyncImpl(powershellExe, [...prefixArgs, command], options);
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

export function normalizeWindowsFilesystemPath(value = '', { rejectPosix = isWsl() } = {}) {
  const raw = String(value ?? '');
  if (!raw) return raw;
  if (isWindowsAbsolutePath(raw)) return collapseRedundantBackslashes(windowsPath(raw));
  if (/^\/mnt\/[a-zA-Z](?:\/|$)/u.test(raw)) {
    return collapseRedundantBackslashes(windowsPath(wslMountToWindowsPath(raw)));
  }
  if (raw.startsWith('/') && rejectPosix) {
    throw new Error(`Cannot use POSIX path in a Windows-service definition: ${raw}. Use a mounted /mnt/<drive>/ path or a native Windows path.`);
  }
  return collapseRedundantBackslashes(windowsPath(raw));
}

function winswFilesystemPathFor(commandPath, { isWslImpl = isWsl } = {}) {
  return winswFilesystemPath(commandPath, { wsl: isWslImpl() });
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

function isNativeWindowsPath(value = '') {
  const path = String(value ?? '').trim();
  return /^[a-zA-Z]:[\\/]/u.test(path)
    || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/u.test(path);
}

function isWslUncPath(value = '') {
  return /^[/\\]{2}wsl(?:\.localhost|\$)?[/\\]/iu.test(String(value ?? '').trim());
}

function isRunnableWindowsExecutable(engine, value = '') {
  const path = String(value ?? '').trim();
  return engine === 'headroom'
    ? /\.exe$/iu.test(path)
    : /\.(?:cmd|exe)$/iu.test(path);
}

function runWindowsExecutableProbe(execFileSyncImpl, executable, args) {
  return trimPowershellOutput(execFileSyncImpl(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }));
}

function probeWindowsExecutable(path, execFileSyncImpl) {
  const script = `$path = ${psQuote(path)}
if (Test-Path -LiteralPath $path -PathType Leaf) {
  [Console]::Out.Write($path)
  exit 0
}
exit 1`;
  return runWindowsExecutableProbe(
    execFileSyncImpl,
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
  );
}

function findWindowsHeadroomLite(execFileSyncImpl) {
  const script = `$names = @('headroom-lite.cmd', 'headroom-lite.exe')
foreach ($name in $names) {
  $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) { continue }
  $path = if ($command.Source) { $command.Source } else { $command.Path }
  if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) {
    [Console]::Out.Write($path)
    exit 0
  }
}
exit 1`;
  return runWindowsExecutableProbe(
    execFileSyncImpl,
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
  );
}

function findWindowsHeadroom(serviceHome, execFileSyncImpl, env = process.env) {
  const resolvedRoot = managedPaths({ home: serviceHome, env, platform: 'windows' }).root;
  // A relocated MYELIN_DIR expressed as a WSL mount (/mnt/<drive>/...) maps to a
  // native Windows path — convert it so the venv probe targets the real Windows
  // venv instead of falling back to the Windows User-scope MYELIN_DIR.
  const root = /^\/mnt\/[a-zA-Z](?:\/|$)/u.test(resolvedRoot)
    ? normalizeWindowsFilesystemPath(resolvedRoot, { rejectPosix: false })
    : resolvedRoot;
  const expectedPath = isNativeWindowsPath(root)
    ? joinManaged(root, 'venv', 'Scripts', 'headroom.exe')
    : null;
  const script = expectedPath
    ? `$path = ${psQuote(expectedPath)}
if (Test-Path -LiteralPath $path -PathType Leaf) {
  [Console]::Out.Write($path)
  exit 0
}
exit 1`
    : `$home = [Environment]::GetFolderPath('UserProfile')
$root = [Environment]::GetEnvironmentVariable('MYELIN_DIR', 'User')
if (-not $root -or -not $root.Trim()) { $root = Join-Path $home '.myelin' }
$path = Join-Path $root 'venv\\Scripts\\headroom.exe'
if (Test-Path -LiteralPath $path -PathType Leaf) {
  [Console]::Out.Write($path)
  exit 0
}
exit 1`;
  return runWindowsExecutableProbe(
    execFileSyncImpl,
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
  );
}

export function resolveWindowsServiceExecutable({
  engine,
  candidate,
  serviceHome,
  servicePlatform,
  wsl,
  env = process.env,
} = {}, {
  execFileSyncImpl = nodeExecFileSync,
} = {}) {
  if (servicePlatform !== 'windows' || !wsl) return candidate;
  if (!['headroom', 'headroom_lite'].includes(engine)) {
    throw new Error(`Unknown selected engine: ${engine}`);
  }

  const rawCandidate = String(candidate ?? '').trim();
  if (!isWslUncPath(rawCandidate) &&
      isNativeWindowsPath(rawCandidate) &&
      isRunnableWindowsExecutable(engine, rawCandidate)) {
    return normalizeWindowsFilesystemPath(rawCandidate);
  }

  if (/^\/mnt\/[a-zA-Z](?:\/|$)/u.test(rawCandidate)) {
    try {
      const converted = runWindowsExecutableProbe(
        execFileSyncImpl,
        'wslpath',
        ['-w', rawCandidate],
      );
      if (!isWslUncPath(converted) &&
          isNativeWindowsPath(converted) &&
          isRunnableWindowsExecutable(engine, converted)) {
        const verified = probeWindowsExecutable(converted, execFileSyncImpl);
        if (verified) return normalizeWindowsFilesystemPath(verified);
      }
    } catch {}
  }

  try {
    const resolved = engine === 'headroom_lite'
      ? findWindowsHeadroomLite(execFileSyncImpl)
      : findWindowsHeadroom(serviceHome, execFileSyncImpl, env);
    if (isNativeWindowsPath(resolved) && isRunnableWindowsExecutable(engine, resolved)) {
      return normalizeWindowsFilesystemPath(resolved);
    }
  } catch {}

  const detail = engine === 'headroom_lite'
    ? 'Install headroom-lite.cmd or headroom-lite.exe in the Windows user PATH.'
    : `Install headroom-ai in the Windows Myelin venv${
      isNativeWindowsPath(serviceHome)
        ? ` at ${joinManaged(managedPaths({ home: serviceHome, env, platform: 'windows' }).root, 'venv', 'Scripts', 'headroom.exe')}`
        : ''
    }.`;
  throw new Error(`Unable to resolve a Windows-service executable for ${engine} from WSL. ${detail}`);
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

export function withForwardedMyelinDir(envVars = {}, env = process.env) {
  const myelinDir = typeof env?.MYELIN_DIR === 'string' && env.MYELIN_DIR.trim()
    ? normalizeWindowsFilesystemPath(env.MYELIN_DIR, { rejectPosix: true })
    : undefined;
  return myelinDir ? { MYELIN_DIR: myelinDir, ...envVars } : { ...envVars };
}

function defaultServiceEnv({ home, env = process.env, envVars = {} } = {}) {
  const winHome = defaultWindowsHome(home);
  return withForwardedMyelinDir({
    HOME: winHome,
    USERPROFILE: winHome,
    APPDATA: pathWin32.join(winHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: pathWin32.join(winHome, 'AppData', 'Local'),
    ...envVars,
  }, env);
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

function winswLogDir({ id, home, logPath, env = process.env } = {}) {
  if (!logPath) return joinManaged(winswServiceDir({ id, home, env }), 'logs');
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
  return joinManaged(winswServiceDir({ id: HEADROOM_SERVICE_ID, home }), 'start-headroom.ps1');
}

export function managedHeadroomPidPath({ home } = {}) {
  return joinManaged(winswServiceDir({ id: HEADROOM_SERVICE_ID, home }), 'headroom.pid');
}

export function managedMitmLauncherPath({ home } = {}) {
  return joinManaged(winswServiceDir({ id: MITM_SERVICE_ID, home }), 'start-mitmproxy.ps1');
}

export function managedMitmPidPath({ home } = {}) {
  return joinManaged(winswServiceDir({ id: MITM_SERVICE_ID, home }), 'mitm.pid');
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
  execFileSyncImpl = execFileSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  powershellExe = powerShellExecutable(),
  isWslImpl = isWsl,
} = {}) {
  if (!filePath) return '';
  const filesystemPath = isWindowsAbsolutePath(filePath)
    ? winswFilesystemPathFor(filePath, { isWslImpl })
    : filePath;
  try {
    if (existsSyncImpl(filesystemPath)) {
      return String(readFileSyncImpl(filesystemPath, 'utf8') ?? '');
    }
  } catch {}
  if (!isWindowsAbsolutePath(filePath)) return '';
  try {
    const command = `if (Test-Path '${escapePs(windowsPath(filePath))}') { Get-Content -Path '${escapePs(windowsPath(filePath))}' -Raw }`;
    return runPsCommand(command, {
      powershellExe,
      execFileSyncImpl,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().replace(/^\uFEFF/, '').replace(/\r/g, '');
  } catch {
    return '';
  }
}

function readWindowsScriptText(scriptPath, opts = {}) {
  return readWindowsFileText(scriptPath, opts);
}

function parseLauncherStartProcess(script = '') {
  const content = String(script ?? '');
  const match = content.match(/Start-Process -FilePath '((?:''|[^'])+)' -ArgumentList '((?:''|[^'])*)'/m);
  if (!match) return null;
  const batchTarget = content.match(/\$myelinBatchTarget = '((?:''|[^'])+)'/m);
  return {
    executablePath: (batchTarget?.[1] ?? match[1]).replace(/''/g, "'"),
    argStr: match[2].replace(/''/g, "'"),
  };
}

function launcherPortFromScript(script = '') {
  const match = String(script ?? '').match(/(?:proxy\s+--port\s+|HEADROOM_LITE_PORT\s*=\s*')(\d+)/im);
  const port = Number(match?.[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
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
  execFileSyncImpl = execFileSync,
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
    // A direct legacy Run-key command is not a durable ownership marker: the
    // same executable, arguments, and port may belong to a user process.
    script += `\nRemove-ItemProperty -Path ${psQuote(REG_RUN)} -Name ${psQuote(HEADROOM_KEY)} -ErrorAction SilentlyContinue`;
  }
  runPsCommand(`& { ${script} }`, { powershellExe, execFileSyncImpl, stdio: 'pipe' });
}

export function stopHeadroomProcessByExecutablePath({
  port,
  executablePath,
  processExeName = 'headroom.exe',
  execFileSyncImpl = execFileSync,
  powershellExe = powerShellExecutable(),
} = {}) {
  const script = stopByPortScript(processExeName, port, {
    requiredArgs: ['proxy'],
    requiredExecutablePath: windowsPath(executablePath),
  });
  runPsCommand(`& { ${script} }`, { powershellExe, execFileSyncImpl, stdio: 'pipe' });
}

export function winswServiceDir({ id, home, env = process.env } = {}) {
  return joinManaged(resolveMyelinRoot({
    home: defaultWindowsHome(home),
    env,
    platform: 'windows',
  }), 'services', id);
}

export function winswExecutablePath({ id, home, env = process.env } = {}) {
  return joinManaged(winswServiceDir({ id, home, env }), `${id}.exe`);
}

export function winswConfigPath({ id, home, env = process.env } = {}) {
  return joinManaged(winswServiceDir({ id, home, env }), `${id}.xml`);
}

export function windowsWatchdogTaskName({ id }) {
  if (id === COPILOT_HEADROOM_SERVICE_ID) return 'Myelin Copilot Headroom Watchdog';
  if (id === HEADROOM_SERVICE_ID) return 'Myelin Headroom Watchdog';
  const title = String(id ?? '')
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
  return `Myelin ${title} Watchdog`;
}

function winswWatchdogScriptPath({ id, home, env = process.env } = {}) {
  return joinManaged(winswServiceDir({ id, home, env }), 'watchdog.ps1');
}

function winswWatchdogLogPath({ id, home, env = process.env } = {}) {
  return joinManaged(winswServiceDir({ id, home, env }), 'watchdog.log');
}

export function generateWinswConfigXml({
  id,
  name,
  description,
  executable,
  arguments: serviceArguments,
  logPath,
  workingDirectory,
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
  const workingDirectoryEntry = workingDirectory
    ? `\n  <workingdirectory>${xmlEscape(workingDirectory)}</workingdirectory>`
    : '';
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
  <log mode="roll"></log>${hideWindowEntry}${workingDirectoryEntry}
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

export function generateWindowsWatchdogTaskDeleteScript({ taskName } = {}) {
  return `
$TaskName = ${psQuote(taskName)}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
`;
}

export function uninstallWindowsWatchdogTask({
  id,
  taskName = windowsWatchdogTaskName({ id }),
  home,
  unlinkSyncImpl = unlinkSync,
  runPsFn = runPs,
  isWslImpl = isWsl,
} = {}) {
  const scriptPath = winswWatchdogScriptPath({ id, home });
  const logPath = winswWatchdogLogPath({ id, home });
  runPsFn(generateWindowsWatchdogTaskDeleteScript({ taskName }), { home });
  for (const path of [
    winswFilesystemPathFor(scriptPath, { isWslImpl }),
    winswFilesystemPathFor(logPath, { isWslImpl }),
  ]) {
    try { unlinkSyncImpl(path); } catch {}
  }
  return { taskName, scriptPath, logPath };
}

export function isWindowsSharingViolation(err) {
  if (!err) return false;
  const code = err.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return true;
  const numeric = [err.winError, err.errno].filter((v) => typeof v === 'number');
  if (numeric.some((v) => v === 32 || v === 5 || v === -32 || v === -5 || v === -4082)) return true;
  const msg = String(err.message ?? '');
  return /(?:error|err)\s*(?:32|5)\b|sharing violation|being used by another process|access is denied|resource busy/i.test(msg);
}

async function replaceFileWithRetry({
  from,
  to,
  renameSyncImpl,
  sleepImpl,
  attempts = 6,
  backoffMs = 200,
}) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSyncImpl(from, to);
      return;
    } catch (err) {
      lastErr = err;
      // Only a Windows sharing violation (the old service still holding the exe
      // handle) is worth polling for — anything else is a hard failure.
      if (!isWindowsSharingViolation(err) || attempt === attempts - 1) throw err;
      await sleepImpl(backoffMs * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * Return true when `port` accepts a TCP connection on 127.0.0.1 within ~200ms.
 * Used to decide whether a WinSW service restart is necessary during install.
 * Windows-safe (no `nc` dependency) — uses Node's own net stack.
 */
export function isPortResponding(port) {
  if (port == null) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const socket = createConnection({ host: '127.0.0.1', port, timeout: 200 });
    socket.on('connect', () => { socket.destroy(); done(true); });
    socket.on('error', () => { socket.destroy(); done(false); });
    socket.on('timeout', () => { socket.destroy(); done(false); });
  });
}

/**
 * Return true when the WinSW config file at `configPath` already contains
 * exactly `content`. A missing/unreadable file returns false (restart needed).
 * `opts.readFile` is injectable for tests.
 */
export function isWinswConfigUnchanged(configPath, content, { readFile = readFileSync } = {}) {
  try {
    return readFile(configPath, 'utf8') === content;
  } catch {
    return false;
  }
}

export async function installWinswService({
  id,
  name,
  description,
  executable,
  arguments: serviceArguments,
  envVars = {},
  logPath,
  workingDirectory,
  home,
  env = process.env,
  port = null,
  forceRestart = false,
  _isPortResponding = isPortResponding,
  _isWinswConfigUnchanged = isWinswConfigUnchanged,
  onFailureDelays = ['5 sec', '30 sec'],
  resetFailure = '1 hour',
  isWslImpl = isWsl,
  installWinswImpl = installWinsw,
  mkdirSyncImpl = mkdirSync,
  existsSyncImpl = existsSync,
  copyFileSyncImpl = copyFileSync,
  writeFileSyncImpl = writeFileSync,
  renameSyncImpl = renameSync,
  unlinkSyncImpl = unlinkSync,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  replaceAttempts = 6,
  replaceBackoffMs = 200,
  runPsFn = runPs,
}) {
  const winHome = defaultWindowsHome(home);
  const serviceDir = winswServiceDir({ id, home: winHome, env });
  const serviceExePath = winswExecutablePath({ id, home: winHome, env });
  const configPath = winswConfigPath({ id, home: winHome, env });
  const logDir = winswLogDir({ id, home: winHome, logPath, env });
  const legacyRunKey = legacyRunKeyForService(id);
  const serviceFilesystemDir = winswFilesystemPathFor(serviceDir, { isWslImpl });
  const serviceFilesystemExePath = winswFilesystemPathFor(serviceExePath, { isWslImpl });
  const configFilesystemPath = winswFilesystemPathFor(configPath, { isWslImpl });
  const logFilesystemDir = winswFilesystemPathFor(logDir, { isWslImpl });

  const xml = generateWinswConfigXml({
    id,
    name,
    description,
    executable: windowsPath(executable),
    arguments: serviceArguments,
    logPath: logDir,
    workingDirectory: workingDirectory ? windowsPath(workingDirectory) : undefined,
    envVars: defaultServiceEnv({ home: winHome, env, envVars }),
    onFailureDelays,
    resetFailure,
  });

  // Skip the restart entirely when the config is byte-identical and the service
  // is already responding — avoids the download/uninstall/reinstall gap that
  // causes ECONNREFUSED during routine reinstalls. forceRestart bypasses it.
  if (!forceRestart
    && _isWinswConfigUnchanged(configFilesystemPath, xml)
    && await _isPortResponding(port)) {
    return { id, serviceExePath, configPath, logDir, skipped: true };
  }

  const stagedExePath = `${serviceFilesystemExePath}.new`;
  const stagedConfigPath = `${configFilesystemPath}.new`;
  const backupExePath = `${serviceFilesystemExePath}.bak`;
  const backupConfigPath = `${configFilesystemPath}.bak`;

  mkdirSyncImpl(serviceFilesystemDir, { recursive: true });
  mkdirSyncImpl(logFilesystemDir, { recursive: true });
  // WinSW sets its process working directory to <workingdirectory> at startup;
  // if the directory doesn't exist the service fails with DirectoryNotFoundException.
  if (workingDirectory) {
    mkdirSyncImpl(winswFilesystemPathFor(workingDirectory, { isWslImpl }), { recursive: true });
  }

  // 1. Fetch WinSW and stage the new exe + config ALONGSIDE the (possibly still
  //    running) service. Never touch the live files while the old service may
  //    still hold an open handle on <id>.exe.
  const winsw = await installWinswImpl({ home: winHome, env, wsl: isWslImpl() });
  const winswSource = winsw.filesystemPath ?? winswFilesystemPathFor(winsw.path, { isWslImpl });
  copyFileSyncImpl(winswSource, stagedExePath);

  writeFileSyncImpl(stagedConfigPath, xml, 'utf8');

  // 2. Back up and stop/uninstall any previous service so it releases the exe
  //    handle. The backup lets us restore the host on failure — never leave it
  //    serviceless.
  const hadPrevious = existsSyncImpl(serviceFilesystemExePath);
  let backedUpExe = false;
  let backedUpConfig = false;
  if (hadPrevious) {
    try { copyFileSyncImpl(serviceFilesystemExePath, backupExePath); backedUpExe = true; } catch {}
    if (existsSyncImpl(configFilesystemPath)) {
      try { copyFileSyncImpl(configFilesystemPath, backupConfigPath); backedUpConfig = true; } catch {}
    }
    try {
      runPsFn(generateWinswUninstallScript({ serviceExePath, configPath, legacyRunKey }), { home: winHome });
    } catch {}
  }

  // 3. Promote the staged files onto the live paths. Retry the rename on a
  //    sharing violation (errors 32/5) with backoff while the old process
  //    finishes releasing the handle.
  try {
    await replaceFileWithRetry({
      from: stagedExePath,
      to: serviceFilesystemExePath,
      renameSyncImpl,
      sleepImpl,
      attempts: replaceAttempts,
      backoffMs: replaceBackoffMs,
    });
    await replaceFileWithRetry({
      from: stagedConfigPath,
      to: configFilesystemPath,
      renameSyncImpl,
      sleepImpl,
      attempts: replaceAttempts,
      backoffMs: replaceBackoffMs,
    });
  } catch (err) {
    // Restore the previous service so the host is never left serviceless.
    if (backedUpExe) {
      try { renameSyncImpl(backupExePath, serviceFilesystemExePath); } catch {}
    }
    if (backedUpConfig) {
      try { renameSyncImpl(backupConfigPath, configFilesystemPath); } catch {}
    }
    if (hadPrevious) {
      try {
        runPsFn(generateWinswInstallScript({ serviceExePath, configPath, legacyRunKey }), { home: winHome });
      } catch {}
    }
    try { unlinkSyncImpl(stagedExePath); } catch {}
    try { unlinkSyncImpl(stagedConfigPath); } catch {}
    throw err;
  }

  // 4. Install + start the new service INSIDE rollback handling. If this final
  //    step fails after the old service was already uninstalled (step 2), the
  //    host would otherwise be left serviceless — so on failure restore the
  //    backed-up exe/xml and re-register (install + start) the previous service.
  try {
    runPsFn(generateWinswInstallScript({ serviceExePath, configPath, legacyRunKey }), { home: winHome });
  } catch (err) {
    if (backedUpExe) {
      try { renameSyncImpl(backupExePath, serviceFilesystemExePath); } catch {}
    }
    if (backedUpConfig) {
      try { renameSyncImpl(backupConfigPath, configFilesystemPath); } catch {}
    }
    if (hadPrevious) {
      try {
        runPsFn(generateWinswInstallScript({ serviceExePath, configPath, legacyRunKey }), { home: winHome });
      } catch {}
    }
    throw err;
  }
  if (backedUpExe) { try { unlinkSyncImpl(backupExePath); } catch {} }
  if (backedUpConfig) { try { unlinkSyncImpl(backupConfigPath); } catch {} }
  return { id, serviceExePath, configPath, logDir };
}

export function winswServiceStatus({
  id,
  home,
  execFileSyncImpl = execFileSync,
  existsSyncImpl = existsSync,
  powershellExe = powerShellExecutable(),
  isWslImpl = isWsl,
} = {}) {
  const serviceExePath = winswExecutablePath({ id, home });
  const configPath = winswConfigPath({ id, home });
  const serviceFilesystemExePath = winswFilesystemPathFor(serviceExePath, { isWslImpl });
  const configFilesystemPath = winswFilesystemPathFor(configPath, { isWslImpl });
  if (!existsSyncImpl(serviceFilesystemExePath) || !existsSyncImpl(configFilesystemPath)) {
    return { running: false, state: 'Missing', label: id, raw: '' };
  }

  let raw = '';
  try {
    raw = runPsCommand(`& ${psQuote(serviceExePath)} status ${psQuote(configPath)}`, {
      powershellExe,
      execFileSyncImpl,
      prefixArgs: ['-Command'],
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
  } catch (error) {
    raw = `${error?.stdout?.toString?.() ?? ''}${error?.stderr?.toString?.() ?? ''}`.trim();
  }

  return { ...parseWinswServiceStatus(raw), label: id };
}

export function restartWinswService({
  id,
  home,
  existsSyncImpl = existsSync,
  runPsFn = runPs,
  isWslImpl = isWsl,
} = {}) {
  const serviceExePath = winswExecutablePath({ id, home });
  const configPath = winswConfigPath({ id, home });
  if (!existsSyncImpl(winswFilesystemPathFor(serviceExePath, { isWslImpl })) ||
      !existsSyncImpl(winswFilesystemPathFor(configPath, { isWslImpl }))) return false;
  try {
    runPsFn(`& ${psQuote(serviceExePath)} restart ${psQuote(configPath)} | Out-Null`, { home });
    return true;
  } catch {
    try {
      runPsFn(`
try { & ${psQuote(serviceExePath)} stop ${psQuote(configPath)} --force --no-wait | Out-Null } catch {}
Start-Sleep -Seconds 1
& ${psQuote(serviceExePath)} start ${psQuote(configPath)} | Out-Null
`, { home });
      return true;
    } catch {
      return false;
    }
  }
}

export function uninstallWinswService({
  id,
  home,
  existsSyncImpl = existsSync,
  runPsFn = runPs,
  isWslImpl = isWsl,
} = {}) {
  const serviceExePath = winswExecutablePath({ id, home });
  const configPath = winswConfigPath({ id, home });
  const legacyRunKey = legacyRunKeyForService(id);
  if (!existsSyncImpl(winswFilesystemPathFor(serviceExePath, { isWslImpl }))) {
    if (legacyRunKey) {
      try {
        runPsFn(`Remove-ItemProperty -Path ${psQuote(REG_RUN)} -Name ${psQuote(legacyRunKey)} -ErrorAction SilentlyContinue`, { home });
      } catch {}
    }
    return false;
  }
  try {
    runPsFn(generateWinswUninstallScript({ serviceExePath, configPath, legacyRunKey }), { home });
    return true;
  } catch {
    return false;
  }
}

function engineInstancePaths(instance) {
  const identity = engineInstanceIdentity(instance);
  const stateDir = normalizeWindowsFilesystemPath(instance.stateDir);
  return {
    ...identity,
    stateDir,
    launcherPath: pathWin32.join(stateDir, identity.launcherName),
    pidPath: pathWin32.join(stateDir, identity.pidName),
  };
}

function engineInstanceRunKeyStatus(runKey, { execSyncImpl = execSync, powershellExe = powerShellExecutable() } = {}) {
  try {
    const raw = trimPowershellOutput(execSyncImpl(
      withPowerShell(`-NoProfile -Command "(Get-ItemProperty -Path '${REG_RUN}' -Name '${runKey}' -ErrorAction SilentlyContinue).'${runKey}'"`, powershellExe),
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString());
    return { registered: !!raw, raw };
  } catch {
    return { registered: false, raw: '' };
  }
}

function engineInstanceLauncherPath(runKeyValue, fallbackPath) {
  return String(runKeyValue ?? '').match(/-File\s+"([^"]+)"/i)?.[1] ?? fallbackPath;
}

/**
 * Extract the launcher/executable a Windows Run-key command line actually
 * invokes. Handles both managed forms:
 *   - `powershell.exe ... -File "<launcher>.ps1"` (current launcher form), and
 *   - `"<...>headroom.exe" proxy --port N` / bare `<...>headroom.exe proxy ...`
 *     (legacy direct-exe form).
 * `-File` is matched first so the powershell host exe is never mistaken for the
 * launcher. Returns null when nothing path-like can be extracted.
 */
export function runKeyLauncherPath(runKeyValue = '') {
  const value = String(runKeyValue ?? '');
  const fileMatch = value.match(/-File\s+"([^"]+)"/i) ?? value.match(/-File\s+'([^']+)'/i);
  if (fileMatch) return fileMatch[1];
  const trimmed = value.trim();
  const quoted = trimmed.match(/^"([^"]+)"/);
  if (quoted) return quoted[1];
  const bare = trimmed.match(/^([^"\s]+)/);
  return bare ? bare[1] : null;
}

/**
 * Does a discovered Run-key command line invoke a launcher/executable that lives
 * UNDER the current managed root? A stale Run key left over from an earlier
 * default `~/.myelin` install (or a different relocated root) points at a
 * launcher outside the current root and must NOT be trusted as "registered".
 * Comparison is case-insensitive on native Windows form with collapsed
 * separators and no trailing slash.
 */
export function launcherOwnedByManagedRoot({
  runKeyValue = '',
  launcherPath,
  managedRoot,
  home,
  env = process.env,
} = {}) {
  const root = managedRoot
    ?? resolveMyelinRoot({ home: defaultWindowsHome(home), env, platform: 'windows' });
  const candidate = launcherPath ?? runKeyLauncherPath(runKeyValue);
  if (!candidate || !root) return false;
  const nativeRoot = collapseRedundantBackslashes(normalizeWindowsFilesystemPath(root, { rejectPosix: false }))
    .replace(/[\\/]+$/u, '')
    .toLowerCase();
  const nativeCandidate = collapseRedundantBackslashes(normalizeWindowsFilesystemPath(candidate, { rejectPosix: false }))
    .toLowerCase();
  if (!nativeRoot || !nativeCandidate) return false;
  return nativeCandidate === nativeRoot || nativeCandidate.startsWith(`${nativeRoot}\\`);
}

/**
 * Ownership decision for a discovered Run key: 'absent' (nothing registered),
 * 'keep' (launcher belongs to the current managed root), or 'reregister' (a
 * foreign/stale launcher — re-register against the current root).
 */
export function runKeyOwnershipDecision({ runKeyValue = '', managedRoot, home, env = process.env } = {}) {
  if (!String(runKeyValue ?? '').trim()) return 'absent';
  return launcherOwnedByManagedRoot({ runKeyValue, managedRoot, home, env }) ? 'keep' : 'reregister';
}

export function generateEngineInstanceRunScript({ instance, envVars = {}, ...options }) {
  const paths = engineInstancePaths(instance);
  const command = engineInstanceCommand(instance, options);
  const executable = normalizeWindowsFilesystemPath(command.executable);
  const logPath = normalizeWindowsFilesystemPath(instance.logPath);
  const args = command.arguments;
  const launch = commandForWindowsExecutable(executable, args);
  const launcherRegex = escapePs(escapePsRegex(paths.launcherPath));
  const isBatchLauncher = launch.isBatchLauncher;
  const listenerPort = Number(instance.port);
  if (isBatchLauncher && (!Number.isInteger(listenerPort) || listenerPort < 1 || listenerPort > 65535)) {
    throw new Error('Batch engine instance launchers require a valid listener port');
  }
  const mergedEnv = { ...command.env, ...envVars, ...instance.env };
  const envLines = Object.entries(mergedEnv)
    .filter(([, value]) => value != null && String(value).length > 0)
    .map(([key, value]) => {
      const escapedValue = escapePs(String(value ?? ''));
      return `$env:${key} = '${escapedValue}'\n[System.Environment]::SetEnvironmentVariable('${escapePs(key)}', '${escapedValue}', 'Process')`;
    })
    .join('\n');
  const childListenerTracking = isBatchLauncher
    ? `
$managedProcess = $null
while (-not $managedProcess -and -not $proc.HasExited) {
  foreach ($connection in @(Get-NetTCPConnection -State Listen -LocalPort ${listenerPort} -ErrorAction SilentlyContinue)) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
    $ancestor = $candidate
    for ($depth = 0; $depth -lt 16 -and $ancestor; $depth++) {
      if ($ancestor.ProcessId -eq $proc.Id) {
        $managedProcess = $candidate
        break
      }
      if (-not $ancestor.ParentProcessId) { break }
      $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $($ancestor.ParentProcessId)" -ErrorAction SilentlyContinue
    }
    if ($managedProcess) { break }
  }
  if (-not $managedProcess) {
    Start-Sleep -Milliseconds 100
    $proc.Refresh()
  }
}
if (-not $managedProcess) {
  return
}`.trim()
    : '$managedProcess = $proc';
  const previousProcessCleanup = `
$previousLauncherContent = if (Test-Path '${escapePs(paths.launcherPath)}') {
  Get-Content -Path '${escapePs(paths.launcherPath)}' -Raw -ErrorAction SilentlyContinue
} else {
  ''
}
`.trim();
  const launcherContent = `
$ErrorActionPreference = 'Stop'
${buildServiceEnvUnsetLines({ os: 'windows' })}
${envLines}
try { Remove-Item -Path '${escapePs(paths.pidPath)}' -ErrorAction SilentlyContinue } catch {}
${isBatchLauncher ? `$myelinBatchTarget = '${escapePs(launch.batchTarget)}'` : ''}
$proc = Start-Process -FilePath '${escapePs(launch.executable)}' -ArgumentList '${escapePs(launch.arguments)}' -WorkingDirectory '${escapePs(paths.stateDir)}' -RedirectStandardOutput '${escapePs(logPath)}' -WindowStyle Hidden -PassThru
${childListenerTracking}
Set-Content -Path '${escapePs(paths.pidPath)}' -Value ${isBatchLauncher ? '$managedProcess.ProcessId' : '$proc.Id'} -Encoding ASCII
Wait-Process -Id ${isBatchLauncher ? '$managedProcess.ProcessId' : '$proc.Id'}
if (Test-Path '${escapePs(paths.pidPath)}') {
  $recordedPid = Get-Content -Path '${escapePs(paths.pidPath)}' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($recordedPid -eq ${isBatchLauncher ? '$managedProcess.ProcessId' : '$proc.Id'}) {
    Remove-Item -Path '${escapePs(paths.pidPath)}' -ErrorAction SilentlyContinue
  }
}
`.trim();
  const previousProcessStop = `
    $previousPortMatch = [regex]::Match($previousLauncherContent, "(?m)(?:proxy\\s+--port\\s+|HEADROOM_LITE_PORT\\s*=\\s*')(\\d+)")
    $previousLauncherPort = $null
    if ($previousPortMatch.Success) {
      $candidatePort = [int]$previousPortMatch.Groups[1].Value
      if ($candidatePort -ge 1 -and $candidatePort -le 65535) {
        $previousLauncherPort = $candidatePort
      }
    }
    $previousBatchTarget = [regex]::Match($previousLauncherContent, "\\$myelinBatchTarget = '((?:''|[^'])+)'").Groups[1].Value.Replace("''", "'")
    $previousLauncherExecutable = if ($previousBatchTarget) { $previousBatchTarget } else { [regex]::Match($previousLauncherContent, "Start-Process -FilePath '((?:''|[^'])+)'").Groups[1].Value.Replace("''", "'") }
    $previousLauncherArguments = [regex]::Match($previousLauncherContent, "Start-Process -FilePath '(?:''|[^'])+' -ArgumentList '((?:''|[^'])*)'").Groups[1].Value.Replace("''", "'")
    $previousIsBatch = $previousLauncherExecutable -match '\\.(?:cmd|bat)$' -or [bool]$previousBatchTarget
    $previousTrackedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $previousPid" -ErrorAction SilentlyContinue
    $previousProcess = $null
    $previousTrackedMatches = $false
    if ($previousTrackedProcess -and $previousLauncherPort) {
      foreach ($connection in @(Get-NetTCPConnection -State Listen -LocalPort $previousLauncherPort -ErrorAction SilentlyContinue)) {
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
        $ancestor = $candidate
        for ($depth = 0; $depth -lt 16 -and $ancestor; $depth++) {
          if ($ancestor.ProcessId -eq $previousTrackedProcess.ProcessId) {
            $previousTrackedMatches = $true
            break
          }
          if (-not $ancestor.ParentProcessId) { break }
          $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $($ancestor.ParentProcessId)" -ErrorAction SilentlyContinue
        }
        if ($previousTrackedMatches) {
          $previousProcess = $candidate
          break
        }
      }
    }
    $previousOwnsPort = $previousProcess -ne $null
    $previousLauncherMatches = $false
    $previousCommandMatches = $false
    $ancestor = $previousProcess
    for ($depth = 0; $depth -lt 16 -and $ancestor; $depth++) {
      if ($ancestor.CommandLine -match '${launcherRegex}') { $previousLauncherMatches = $true }
      if ($previousIsBatch) {
        if ($ancestor.Name -ieq 'cmd.exe' -and $ancestor.CommandLine -match [regex]::Escape($previousLauncherExecutable)) {
          $previousCommandMatches = $true
        }
      } elseif ($ancestor.ProcessId -eq $previousProcess.ProcessId -and $previousProcess.ExecutablePath -eq $previousLauncherExecutable) {
        $previousArgumentsPattern = [regex]::Escape($previousLauncherArguments) + '$'
        if (-not $previousLauncherArguments -or $previousProcess.CommandLine -match $previousArgumentsPattern) {
          $previousCommandMatches = $true
        }
      }
      if (-not $ancestor.ParentProcessId) { break }
      $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $($ancestor.ParentProcessId)" -ErrorAction SilentlyContinue
    }
    if ($previousProcess -and $previousOwnsPort -and $previousLauncherMatches -and $previousCommandMatches -and $previousLauncherExecutable) {
      Stop-Process -Id $previousProcess.ProcessId -Force -ErrorAction SilentlyContinue
    }`.trim();
  return `
New-Item -ItemType Directory -Force -Path '${escapePs(paths.stateDir)}' | Out-Null
${previousProcessCleanup}
Set-Content -Path '${escapePs(paths.launcherPath)}' -Value @'
${launcherContent}
'@ -Encoding UTF8
if (Test-Path '${escapePs(paths.pidPath)}') {
  $previousPid = Get-Content -Path '${escapePs(paths.pidPath)}' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($previousPid -match '^[0-9]+$') {
${previousProcessStop}
  }
}
Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${escapePs(paths.launcherPath)}"' -WindowStyle Hidden
Set-ItemProperty -Path '${REG_RUN}' -Name '${paths.runKey}' -Value 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${escapePs(paths.launcherPath)}"'
Write-Host "[myelin] ${paths.name} started (hidden)"
`;
}

export function generateEngineInstanceWinswConfig({ instance, envVars = {}, home, env = process.env, ...options }) {
  const identity = engineInstanceIdentity(instance);
  const command = engineInstanceCommand(instance, options);
  const launch = commandForWindowsExecutable(
    normalizeWindowsFilesystemPath(command.executable),
    command.arguments,
  );
  return generateWinswConfigXml({
    id: identity.id,
    name: identity.name,
    description: identity.description,
    executable: normalizeWindowsFilesystemPath(launch.executable),
    arguments: launch.arguments,
    logPath: normalizeWindowsFilesystemPath(instance.logPath),
    workingDirectory: normalizeWindowsFilesystemPath(instance.stateDir),
    envVars: defaultServiceEnv({
      home,
      env,
      envVars: { ...command.env, ...envVars, ...instance.env },
    }),
  });
}

export async function installEngineInstance(instance, {
  manager = 'registry',
  envVars = {},
  home,
  env = process.env,
  runPsFn = runPs,
  forceRestart = false,
  _isPortResponding = isPortResponding,
  _isWinswConfigUnchanged = isWinswConfigUnchanged,
  ...options
} = {}) {
  const identity = engineInstanceIdentity(instance);
  const command = engineInstanceCommand(instance, options);
  const launch = commandForWindowsExecutable(
    normalizeWindowsFilesystemPath(command.executable),
    command.arguments,
  );
  const mergedEnv = withForwardedMyelinDir({ ...command.env, ...envVars, ...instance.env }, env);
  if (manager !== 'winsw') {
    runPsFn(generateEngineInstanceRunScript({ instance, envVars: mergedEnv, ...options }), { home, env });
    return { ok: true, manager: 'registry', id: identity.id };
  }
  return installWinswService({
    id: identity.id,
    name: identity.name,
    description: identity.description,
    executable: launch.executable,
    arguments: launch.arguments,
    envVars: mergedEnv,
    logPath: instance.logPath,
    workingDirectory: instance.stateDir,
    home,
    env,
    port: instance.port,
    forceRestart,
    _isPortResponding,
    _isWinswConfigUnchanged,
  });
}

export function engineInstanceStatus(instance, {
  manager = 'registry',
  execSyncImpl = execSync,
  execFileSyncImpl = execFileSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  runKeyStatusImpl,
  powershellExe = powerShellExecutable(),
  home,
  isWslImpl = isWsl,
} = {}) {
  const paths = engineInstancePaths(instance);
  if (manager === 'winsw') {
    return {
      ...winswServiceStatus({ id: paths.id, home, execFileSyncImpl, existsSyncImpl, powershellExe, isWslImpl }),
      healthUrl: instance.healthUrl,
    };
  }
  try {
    const runKeyStatus = (runKeyStatusImpl ?? ((deps) => engineInstanceRunKeyStatus(paths.runKey, deps)))({
      execSyncImpl,
      powershellExe,
      isWslImpl,
    });
    if (!runKeyStatus?.registered) {
      return { running: false, state: 'Stopped', raw: '', label: paths.id, healthUrl: instance.healthUrl };
    }
    const launcherPath = engineInstanceLauncherPath(runKeyStatus.raw, paths.launcherPath);
    const launcherScript = readWindowsScriptText(launcherPath, {
      execFileSyncImpl,
      existsSyncImpl,
      readFileSyncImpl,
      powershellExe,
      isWslImpl,
    });
    const legacyCommand = parseLegacyManagedHeadroomRunKeyValue({ runKeyValue: runKeyStatus.raw });
    const launcherCommand = parseLauncherStartProcess(launcherScript);
    const command = launcherCommand ?? legacyCommand ?? {};
    const executable = windowsPath(command.executablePath ?? '');
    const argumentsRegex = escapePs(escapePsRegex(command.argStr ?? ''));
    const executableName = escapePs(executable.split('\\').pop() ?? '');
    const launcherRegex = escapePs(escapePsRegex(windowsPath(launcherPath)));
    const launcherPort = launcherPortFromScript(launcherScript);
    const isBatchLauncher = /\.(?:cmd|bat)$/iu.test(executable);
    const pidText = trimPowershellOutput(readWindowsFileText(paths.pidPath, {
      execFileSyncImpl,
      existsSyncImpl,
      readFileSyncImpl,
      powershellExe,
      isWslImpl,
    }));
    const hasManagedPid = /^[0-9]+$/u.test(pidText);
    const pidClause = hasManagedPid
      ? `Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue`
      : `Get-CimInstance Win32_Process -Filter "Name = '${executableName}'" -ErrorAction SilentlyContinue | Select-Object -First 1`;
    const identityCheck = `$proc.Name -ieq '${executableName}' -and $proc.ExecutablePath -eq '${escapePs(executable)}' -and $proc.CommandLine -match '${argumentsRegex}$'`;
    const script = isBatchLauncher
      ? [
        `$managedPid = ${hasManagedPid ? pidText : '$null'}`,
        `$launcherPort = ${launcherPort ?? '$null'}`,
        `$trackedProcess = ${hasManagedPid ? pidClause : '$null'}`,
        `$proc = $null`,
        `if ($trackedProcess -and $launcherPort) {
  $trackedMatches = $false
  foreach ($connection in @(Get-NetTCPConnection -State Listen -LocalPort $launcherPort -ErrorAction SilentlyContinue)) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
    $ancestor = $candidate
    for ($depth = 0; $depth -lt 16 -and $ancestor; $depth++) {
      if ($ancestor.ProcessId -eq $trackedProcess.ProcessId) {
        $trackedMatches = $true
        break
      }
      if (-not $ancestor.ParentProcessId) { break }
      $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $($ancestor.ParentProcessId)" -ErrorAction SilentlyContinue
    }
    if ($trackedMatches) {
      $proc = $candidate
      break
    }
  }
}
if ($proc) {
  $launcherMatches = $false
  $commandMatches = $false
  $ancestor = $proc
  for ($depth = 0; $depth -lt 16 -and $ancestor; $depth++) {
    if ($ancestor.CommandLine -match '${launcherRegex}') { $launcherMatches = $true }
    if ($ancestor.Name -ieq 'cmd.exe' -and $ancestor.CommandLine -match '${escapePs(escapePsRegex(executable))}') { $commandMatches = $true }
    if (-not $ancestor.ParentProcessId) { break }
    $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $($ancestor.ParentProcessId)" -ErrorAction SilentlyContinue
  }
  if ($launcherMatches -and $commandMatches) { 'Running' } else { 'Stopped' }
} else { 'Stopped' }`,
      ].join('\n')
      : [
        `$managedPid = ${hasManagedPid ? pidText : '$null'}`,
        `$proc = ${pidClause}`,
        launcherCommand
          ? `if ($proc -and ${identityCheck}) {
  $parent = if ($proc.ParentProcessId) { Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }
  if ($parent -and $parent.CommandLine -match '${launcherRegex}') { 'Running' } else { 'Stopped' }
} else { 'Stopped' }`
          : `if ($proc -and ${identityCheck}) { 'Running' } else { 'Stopped' }`,
      ].join('\n');
    const raw = trimPowershellOutput(runPsCommand(`& { ${script} }`, {
      powershellExe,
      execFileSyncImpl,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString());
    return { ...parseManagedHeadroomStatus(raw), label: paths.id, healthUrl: instance.healthUrl };
  } catch {
    return { running: false, state: 'Unknown', raw: '', label: paths.id, healthUrl: instance.healthUrl };
  }
}

function ownedWinswEngineInstance(instance, paths, {
  home,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  execFileSyncImpl = execFileSync,
  powershellExe = powerShellExecutable(),
  isWslImpl = isWsl,
} = {}) {
  const configPath = winswConfigPath({ id: paths.id, home });
  const config = readWindowsFileText(configPath, {
    existsSyncImpl,
    readFileSyncImpl,
    execFileSyncImpl,
    powershellExe,
    isWslImpl,
  });
  const executable = config.match(/<executable>([^<]+)<\/executable>/iu)?.[1] ?? '';
  const expectedExecutable = instance.engine === 'headroom_lite'
    ? /(?:^|[\\/])headroom-lite(?:\.(?:exe|cmd|bat))?$/iu
    : /(?:^|[\\/])headroom(?:\.exe)?$/iu;
  const argumentsValue = config.match(/<arguments>([\s\S]*?)<\/arguments>/iu)?.[1] ?? '';
  const usesOwnedCmdShim = instance.engine === 'headroom_lite'
    && /^cmd\.exe$/iu.test(executable)
    && /\/d\s+\/s\s+\/c\s+&quot;&quot;[^<]*headroom-lite(?:\.(?:cmd|bat))?&quot;&quot;/iu.test(argumentsValue);
  const configuredPort = instance.engine === 'headroom_lite'
    ? config.match(/<env name="HEADROOM_LITE_PORT" value="(\d+)"\/>/iu)?.[1]
    : config.match(/<arguments>proxy --port (\d+)(?:\s|<)/iu)?.[1];
  const hasValidConfiguredPort = Number.isInteger(Number(configuredPort)) &&
    Number(configuredPort) >= 1 &&
    Number(configuredPort) <= 65535;
  return config.includes(`<id>${paths.id}</id>`) &&
    config.includes(`<workingdirectory>${xmlEscape(paths.stateDir)}</workingdirectory>`) &&
    hasValidConfiguredPort &&
    (expectedExecutable.test(executable) || usesOwnedCmdShim);
}

export function generateEngineInstanceRemovalScript({ instance, home } = {}) {
  const paths = engineInstancePaths(instance);
  const liteListenerFallback = instance.engine === 'headroom_lite'
    ? `
if ($legacyLauncherMatches -and (Test-Path $launcherPath)) {
  $liteFallbackContent = Get-Content -Path $launcherPath -Raw -ErrorAction SilentlyContinue
  $liteFallbackPortMatch = [regex]::Match($liteFallbackContent, "(?m)HEADROOM_LITE_PORT\\s*=\\s*'(\\d+)")
  $liteFallbackPort = $null
  if ($liteFallbackPortMatch.Success) {
    $liteFallbackPort = [int]$liteFallbackPortMatch.Groups[1].Value
    if ($liteFallbackPort -lt 1 -or $liteFallbackPort -gt 65535) { $liteFallbackPort = $null }
  }
  $liteFallbackBatchTarget = [regex]::Match($liteFallbackContent, "\\$myelinBatchTarget = '((?:''|[^'])+)'").Groups[1].Value.Replace("''", "'")
  $liteFallbackExecutable = if ($liteFallbackBatchTarget) { $liteFallbackBatchTarget } else { [regex]::Match($liteFallbackContent, "Start-Process -FilePath '((?:''|[^'])+)'").Groups[1].Value.Replace("''", "'") }
  $liteFallbackBatch = $liteFallbackExecutable -match '\\.(?:cmd|bat)$' -or [bool]$liteFallbackBatchTarget
  $liteFallbackRoleMatches = $liteFallbackContent -match [regex]::Escape($stateDir)
  if ($liteFallbackPort -and $liteFallbackExecutable -and $liteFallbackRoleMatches) {
    foreach ($connection in @(Get-NetTCPConnection -State Listen -LocalPort $liteFallbackPort -ErrorAction SilentlyContinue)) {
      $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
      $liteFallbackLauncherMatches = $false
      $liteFallbackCommandMatches = $false
      $ancestor = $candidate
      for ($depth = 0; $depth -lt 16 -and $ancestor; $depth++) {
        if ($ancestor.CommandLine -match [regex]::Escape($launcherPath)) { $liteFallbackLauncherMatches = $true }
        if ($liteFallbackBatch) {
          if ($ancestor.Name -ieq 'cmd.exe' -and $ancestor.CommandLine -match [regex]::Escape($liteFallbackExecutable)) {
            $liteFallbackCommandMatches = $true
          }
        } elseif ($ancestor.ProcessId -eq $candidate.ProcessId -and $candidate.ExecutablePath -eq $liteFallbackExecutable) {
          $liteFallbackCommandMatches = $true
        }
        if (-not $ancestor.ParentProcessId) { break }
        $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $($ancestor.ParentProcessId)" -ErrorAction SilentlyContinue
      }
      if ($candidate -and $liteFallbackLauncherMatches -and $liteFallbackCommandMatches) {
        Stop-Process -Id $candidate.ProcessId -Force -ErrorAction SilentlyContinue
        break
      }
    }
  }
}`
    : '';
  return `
$pidPath = '${escapePs(paths.pidPath)}'
$launcherPath = '${escapePs(paths.launcherPath)}'
$runKey = '${escapePs(paths.runKey)}'
$stateDir = '${escapePs(paths.stateDir)}'
$legacyRunKeyValue = (Get-ItemProperty -Path '${REG_RUN}' -Name $runKey -ErrorAction SilentlyContinue).$runKey
$managedPid = if (Test-Path $pidPath) { Get-Content -Path $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $null }
if ($managedPid -match '^[0-9]+$' -and (Test-Path $launcherPath)) {
  $managedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue
  $launcherContent = Get-Content -Path $launcherPath -Raw -ErrorAction SilentlyContinue
  $myelinBatchTarget = [regex]::Match($launcherContent, "\\$myelinBatchTarget = '((?:''|[^'])+)'").Groups[1].Value.Replace("''", "'")
  $launcherExecutable = if ($myelinBatchTarget) { $myelinBatchTarget } else { [regex]::Match($launcherContent, "Start-Process -FilePath '((?:''|[^'])+)'").Groups[1].Value.Replace("''", "'") }
  $portMatch = [regex]::Match($launcherContent, "(?m)(?:proxy\\s+--port\\s+|HEADROOM_LITE_PORT\\s*=\\s*')(\\d+)")
  $launcherPort = $null
  if ($portMatch.Success) {
    $launcherPort = [int]$portMatch.Groups[1].Value
    if ($launcherPort -lt 1 -or $launcherPort -gt 65535) { $launcherPort = $null }
  }
  $ownedProcess = $null
  $trackedMatches = $false
  if ($managedProcess -and $launcherPort) {
    foreach ($connection in @(Get-NetTCPConnection -State Listen -LocalPort $launcherPort -ErrorAction SilentlyContinue)) {
      $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
      $ancestor = $candidate
      for ($depth = 0; $depth -lt 16 -and $ancestor; $depth++) {
        if ($ancestor.ProcessId -eq $managedProcess.ProcessId) {
          $trackedMatches = $true
          break
        }
        if (-not $ancestor.ParentProcessId) { break }
        $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $($ancestor.ParentProcessId)" -ErrorAction SilentlyContinue
      }
      if ($trackedMatches) {
        $ownedProcess = $candidate
        break
      }
    }
  }
  $ownsPort = $ownedProcess -ne $null
  $roleMatches = $launcherContent -match [regex]::Escape($stateDir)
  $portMatches = $launcherPort -ne $null
  $cmdLauncher = $launcherExecutable -match '\\.(?:cmd|bat)$' -or [bool]$myelinBatchTarget
  $launcherMatches = $false
  $commandMatches = $false
  $ancestor = $ownedProcess
  for ($depth = 0; $depth -lt 16 -and $ancestor; $depth++) {
    if ($ancestor.CommandLine -match [regex]::Escape($launcherPath)) { $launcherMatches = $true }
    if ($cmdLauncher) {
      if ($ancestor.Name -ieq 'cmd.exe' -and $ancestor.CommandLine -match [regex]::Escape($launcherExecutable)) {
        $commandMatches = $true
      }
    } elseif ($ancestor.ProcessId -eq $ownedProcess.ProcessId -and $ancestor.ExecutablePath -eq $launcherExecutable) {
      $commandMatches = $true
    }
    if (-not $ancestor.ParentProcessId) { break }
    $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $($ancestor.ParentProcessId)" -ErrorAction SilentlyContinue
  }
  if ($ownedProcess -and $launcherMatches -and $commandMatches -and $ownsPort -and $roleMatches -and $portMatches -and $launcherExecutable) {
    Stop-Process -Id $ownedProcess.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -Path $pidPath -ErrorAction SilentlyContinue
}
$legacyExecutable = $null
$legacyArguments = $null
$legacyArgumentsPattern = $null
$legacyPort = $null
$legacyDirectMatch = [regex]::Match([string]$legacyRunKeyValue, '^\\s*(?:"(?<executable>[^"]+headroom(?:\\.exe)?)"|(?<executable>\\S+headroom(?:\\.exe)?))\\s+(?<arguments>proxy\\b.*)\\s*$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
$legacyLauncherMatch = [regex]::Match([string]$legacyRunKeyValue, '(?i)(?:^|\\s)-File\\s+"(?<launcher>[^"]+)"')
$legacyLauncherMatches = $legacyLauncherMatch.Success -and $legacyLauncherMatch.Groups['launcher'].Value -ieq $launcherPath
if ($legacyLauncherMatches -and (Test-Path $launcherPath)) {
  $legacyLauncherContent = Get-Content -Path $launcherPath -Raw -ErrorAction SilentlyContinue
  $legacyStartMatch = [regex]::Match($legacyLauncherContent, "Start-Process -FilePath '((?:''|[^'])+)' -ArgumentList '((?:''|[^'])*)'")
  if ($legacyStartMatch.Success) {
    $legacyExecutable = $legacyStartMatch.Groups[1].Value.Replace("''", "'")
    $legacyArguments = $legacyStartMatch.Groups[2].Value.Replace("''", "'").Trim()
  }
  if ($legacyExecutable -and $legacyArguments -match '^proxy\\b') {
    $legacyArgumentsPattern = [regex]::Escape($legacyArguments) + '\\s*$'
    $legacyPortMatch = [regex]::Match($legacyArguments, '(?:^|\\s)--port\\s+(\\d+)(?:\\s|$)')
    if ($legacyPortMatch.Success) {
      $candidatePort = [int]$legacyPortMatch.Groups[1].Value
      if ($candidatePort -ge 1 -and $candidatePort -le 65535) { $legacyPort = $candidatePort }
    }
  }
}
if ($legacyLauncherMatches -and $legacyExecutable -and $legacyArguments -and $legacyPort) {
  foreach ($connection in @(Get-NetTCPConnection -State Listen -LocalPort $legacyPort -ErrorAction SilentlyContinue)) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
    $legacyLauncherAncestorMatches = $false
    $ancestor = $candidate
    for ($depth = 0; $depth -lt 16 -and $ancestor; $depth++) {
      if ($ancestor.CommandLine -match [regex]::Escape($launcherPath)) {
        $legacyLauncherAncestorMatches = $true
        break
      }
      if (-not $ancestor.ParentProcessId) { break }
      $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $($ancestor.ParentProcessId)" -ErrorAction SilentlyContinue
    }
    if ($candidate -and $legacyLauncherAncestorMatches -and $candidate.ExecutablePath -eq $legacyExecutable -and $candidate.CommandLine -match $legacyArgumentsPattern -and $candidate.CommandLine -match "(^|\\s)--port\\s+$legacyPort(\\s|$)") {
      Stop-Process -Id $candidate.ProcessId -Force -ErrorAction SilentlyContinue
      break
    }
  }
}
# Direct legacy Run-key entries have no launcher/PID/state ownership proof.
# Remove their stale registration but leave an ambiguous listener untouched.
${liteListenerFallback}
if ($legacyDirectMatch.Success -or $legacyLauncherMatches) {
  Remove-ItemProperty -Path '${REG_RUN}' -Name $runKey -ErrorAction SilentlyContinue
}
`;
}

export function removeEngineInstance(instance, {
  manager = 'registry',
  home,
  includeLegacy = true,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  execSyncImpl = execSync,
  execFileSyncImpl = execFileSync,
  powershellExe = powerShellExecutable(),
  uninstallWinswServiceImpl = uninstallWinswService,
  uninstallWindowsWatchdogTaskImpl = uninstallWindowsWatchdogTask,
  runPsFn = runPs,
  isWslImpl = isWsl,
} = {}) {
  const paths = engineInstancePaths(instance);
  const legacyInstance = !includeLegacy || instance.legacy
    ? instance
    : legacyEngineInstance({
        engine: 'headroom',
        role: instance.role,
        port: instance.port,
        envVars: instance.env,
        home,
      });
  const legacyPaths = engineInstancePaths(legacyInstance);
  const identities = paths.id === legacyPaths.id
    ? [{ instance, paths }]
    : [{ instance, paths }, { instance: legacyInstance, paths: legacyPaths }];
  for (const { paths: ownedPaths } of identities) {
    uninstallWindowsWatchdogTaskImpl({ id: ownedPaths.id, home, isWslImpl });
  }
  for (const { instance: ownedInstance, paths: ownedPaths } of identities) {
    if (ownedWinswEngineInstance(ownedInstance, ownedPaths, {
      home,
      existsSyncImpl,
      readFileSyncImpl,
      execFileSyncImpl,
      powershellExe,
      isWslImpl,
    })) {
      uninstallWinswServiceImpl({ id: ownedPaths.id, home, isWslImpl });
    }
  }
  for (const { instance: ownedInstance } of identities) {
    runPsFn(generateEngineInstanceRemovalScript({ instance: ownedInstance, home }), { home });
  }
  return true;
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
  'MYELIN_COPILOT_ENGINE_URL',
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

export function parseLegacyMitmRunKeyValue(runKeyValue = '') {
  const value = String(runKeyValue ?? '').trim();
  const match = value.match(/^\s*(?:"(?<quotedExecutable>(?:[A-Za-z]:|\\\\)[^"]*\\mitmdump(?:\.exe)?)"|(?<bareExecutable>(?:[A-Za-z]:|\\\\)\S*\\mitmdump(?:\.exe)?))\s+(?<argStr>.+?)\s*$/iu);
  if (!match?.groups) return null;
  const executablePath = match.groups.quotedExecutable ?? match.groups.bareExecutable;
  const argStr = match.groups.argStr?.trim() ?? '';
  const portMatch = argStr.match(/(?:^|\s)(?:--listen-port\s+|--mode\s+regular@)(?<port>\d{1,5})(?=\s|$)/u);
  const addonMatch = argStr.match(/(?:^|\s)-s\s+(?:"(?<quotedAddon>[^"]+)"|(?<bareAddon>\S+))(?=\s|$)/u);
  const port = Number(portMatch?.groups?.port);
  const addonPath = addonMatch?.groups?.quotedAddon ?? addonMatch?.groups?.bareAddon ?? '';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/copilot_addon\.py$/iu.test(addonPath)) {
    return null;
  }
  return { executablePath, argStr, port };
}

function readManagedMitmIdentity({
  home,
  execFileSyncImpl = execFileSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  powershellExe = powerShellExecutable(),
} = {}) {
  const launcherPath = managedMitmLauncherPath({ home });
  const launcherScript = readWindowsScriptText(launcherPath, {
    execFileSyncImpl,
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

export function buildLegacyMitmStatusScript({ port, executablePath, argStr } = {}) {
  const validPort = Number(port);
  if (!Number.isInteger(validPort) || validPort < 1 || validPort > 65535 || !executablePath || !argStr) {
    return `'Stopped'`;
  }
  const exeName = windowsPath(executablePath).split('\\').pop();
  const executablePattern = escapePsRegex(windowsPath(executablePath));
  const commandPattern = escapePs(`^\\s*(?:"${executablePattern}"|${executablePattern})\\s+${escapePsRegex(argStr)}\\s*$`);
  return [
    `$legacyPort = ${validPort}`,
    `$legacyProcess = $null`,
    `foreach ($connection in @(Get-NetTCPConnection -State Listen -LocalPort $legacyPort -ErrorAction SilentlyContinue)) {`,
    `  $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue`,
    `  if ($candidate -and $candidate.Name -ieq '${escapePs(exeName)}' -and $candidate.ExecutablePath -eq '${escapePs(windowsPath(executablePath))}' -and $candidate.CommandLine -match '${commandPattern}') {`,
    `    $legacyProcess = $candidate`,
    `    break`,
    `  }`,
    `}`,
    `if ($legacyProcess) { 'Running' } else { 'Stopped' }`,
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
  execFileSyncImpl = execFileSync,
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
    execFileSyncImpl,
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
  execFileSyncImpl = execFileSync,
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
    execFileSyncImpl,
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

export function generateHeadroomRunScript(opts = {}) {
  const mergedEnv = opts.interceptToolResults
    ? { HEADROOM_INTERCEPT_ENABLED: '1', ...opts.envVars }
    : (opts.envVars ?? {});
  return generateEngineInstanceRunScript({
    ...opts,
    instance: legacyEngineInstance({ ...opts, role: 'primary', envVars: mergedEnv }),
    envVars: {},
  });
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
  const stateDir = managedPaths({ home: homedir() }).serviceStatePath;
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


export async function installService(opts = {}) {
  const mergedEnv = opts.interceptToolResults
    ? { HEADROOM_INTERCEPT_ENABLED: '1', ...opts.envVars }
    : (opts.envVars ?? {});
  return installEngineInstance(
    legacyEngineInstance({ ...opts, role: 'primary', envVars: mergedEnv }),
    { ...opts, envVars: {} },
  );
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
export function generateCopilotHeadroomRunScript(opts = {}) {
  const selectedEngine = opts.engine ?? 'headroom';
  const stateDir = opts.workingDirectory ?? legacyEngineInstance({ ...opts, role: 'copilot' }).stateDir;
  return generateEngineInstanceRunScript({
    ...opts,
    instance: opts.instance ?? {
      engine: selectedEngine,
      role: 'copilot',
      port: opts.port,
      id: `${selectedEngine}-copilot`,
      legacy: true,
      stateDir,
      logPath: pathWin32.join(stateDir ?? '', 'copilot-headroom.log'),
      healthUrl: `http://127.0.0.1:${opts.port}/health`,
      env: opts.envVars ?? {},
    },
    envVars: {},
  });
}

export async function installCopilotHeadroomService(opts = {}) {
  return installEngineInstance(
    legacyEngineInstance({ ...opts, role: 'copilot' }),
    { ...opts, envVars: {} },
  );
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

export function copilotHeadroomServiceStatus(opts = {}) {
  const status = engineInstanceStatus(
    legacyEngineInstance({ ...opts, role: 'copilot', port: opts.port ?? 8788 }),
    opts,
  );
  return { running: status.running, state: status.state, raw: status.raw };
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

export function generateManagedMitmRemovalScript({ home } = {}) {
  const launcherPath = managedMitmLauncherPath({ home });
  const pidPath = managedMitmPidPath({ home });
  const launcherRegex = escapePs(escapePsRegex(windowsPath(launcherPath)));
  return `
$launcherPath = '${escapePs(windowsPath(launcherPath))}'
$pidPath = '${escapePs(windowsPath(pidPath))}'
$launcherRegex = '${launcherRegex}'
$runKeyValue = [string]((Get-ItemProperty -Path '${REG_RUN}' -Name '${MITM_KEY}' -ErrorAction SilentlyContinue).'${MITM_KEY}')
$launcherMatches = $runKeyValue -match '-File\\s+"' -and $runKeyValue -match $launcherRegex
if ($launcherMatches) {
  if (Test-Path $pidPath) {
    $managedPid = (Get-Content -Path $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($managedPid -and $managedPid.ToString().Trim() -match '^[0-9]+$') {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue
      if ($proc -and $proc.Name -ieq 'mitmdump.exe') {
        $parent = if ($proc.ParentProcessId) { Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }
        if ($parent -and $parent.CommandLine -match $launcherRegex) {
          Stop-Process -Id $managedPid -Force -ErrorAction SilentlyContinue
        }
      }
    }
    Remove-Item -Path $pidPath -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process -Filter "Name = 'mitmdump.exe'" | ForEach-Object {
    $parent = if ($_.ParentProcessId) { Get-CimInstance Win32_Process -Filter "ProcessId = $($_.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }
    if ($parent -and $parent.CommandLine -match $launcherRegex) {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}
$legacyDirectMatch = [regex]::Match([string]$runKeyValue, '^\\s*(?:"(?<executable>(?:[A-Za-z]:|\\\\\\\\)[^"]*\\\\mitmdump(?:\\.exe)?)"|(?<executable>(?:[A-Za-z]:|\\\\\\\\)\\S*\\\\mitmdump(?:\\.exe)?))\\s+(?<arguments>.*)\\s*$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
$legacyPortMatch = if ($legacyDirectMatch.Success) { [regex]::Match($legacyDirectMatch.Groups['arguments'].Value, '(?:^|\\s)(?:--listen-port\\s+|--mode\\s+regular@)(?<port>\\d+)(?=\\s|$)') } else { $null }
$legacyAddonMatches = $legacyDirectMatch.Success -and $legacyDirectMatch.Groups['arguments'].Value -match '(?:^|\\s)-s\\s+(?:"[^"]*copilot_addon\\.py"|[^\\s]*copilot_addon\\.py)(?=\\s|$)'
$legacyPort = if ($legacyPortMatch.Success) { [int]$legacyPortMatch.Groups['port'].Value } else { $null }
$legacyDirectOwned = $legacyDirectMatch.Success -and $legacyAddonMatches -and $legacyPort -ge 1 -and $legacyPort -le 65535
if ($launcherMatches -or $legacyDirectOwned) {
  Remove-ItemProperty -Path '${REG_RUN}' -Name '${MITM_KEY}' -ErrorAction SilentlyContinue
}
`;
}

export function removeMitmService({
  manager = 'registry',
  home,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  execFileSyncImpl = execFileSync,
  powershellExe = powerShellExecutable(),
  uninstallWinswServiceImpl = uninstallWinswService,
  runPsFn = runPs,
  isWslImpl = isWsl,
} = {}) {
  const serviceExePath = winswExecutablePath({ id: MITM_SERVICE_ID, home });
  const configPath = winswConfigPath({ id: MITM_SERVICE_ID, home });
  const config = readWindowsFileText(configPath, {
    existsSyncImpl,
    readFileSyncImpl,
    execFileSyncImpl,
    powershellExe,
    isWslImpl,
  });
  const ownedWinSw = existsSyncImpl(winswFilesystemPathFor(serviceExePath, { isWslImpl }))
    && /<id>\s*myelin-mitmproxy\s*<\/id>/iu.test(config)
    && /<name>\s*Myelin Mitmproxy\s*<\/name>/iu.test(config);
  let removed = false;
  if (ownedWinSw) {
    removed = uninstallWinswServiceImpl({ id: MITM_SERVICE_ID, home, isWslImpl }) || removed;
  }
  runPsFn(generateManagedMitmRemovalScript({ home }), { home });
  return removed || manager === 'registry';
}

export async function installMitmService({ mitmdumpBin, port, addonPath, envVars = {}, logPath, home, env = process.env, upstreamProxy, egressPort, manager = 'registry', forceRestart = false, _isPortResponding = isPortResponding, _isWinswConfigUnchanged = isWinswConfigUnchanged }) {
  const persistedEnv = withForwardedMyelinDir(envVars, env);
  if (manager !== 'winsw') {
    runPs(generateMitmRunScript({ mitmdumpBin, port, addonPath, envVars: persistedEnv, egressPort, home }), { home, env });
    return { ok: true, manager: 'registry' };
  }
  return installWinswService({
    id: MITM_SERVICE_ID,
    name: 'Myelin Mitmproxy',
    description: 'Myelin mitmproxy LLM compression proxy',
    executable: mitmdumpBin,
    arguments: buildMitmArgumentString({ mitmdumpBin, port, addonPath, envVars: persistedEnv, egressPort, upstreamProxy }),
    envVars: { ...(egressPort ? { MYELIN_EGRESS_PORT: String(egressPort) } : {}), ...persistedEnv },
    logPath,
    home,
    env,
    port,
    forceRestart,
    _isPortResponding,
    _isWinswConfigUnchanged,
  });
}

export function mitmServiceStatus({
  manager = 'registry',
  home,
  execSyncImpl = execSync,
  execFileSyncImpl = execFileSync,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  powershellExe = powerShellExecutable(),
  isWslImpl = isWsl,
} = {}) {
  if (manager !== 'winsw') {
    try {
      const identity = readManagedMitmIdentity({
        home,
        execFileSyncImpl,
        existsSyncImpl,
        readFileSyncImpl,
        powershellExe,
      });
      const pidText = identity
        ? trimPowershellOutput(readWindowsFileText(managedMitmPidPath({ home }), {
            execFileSyncImpl,
            existsSyncImpl,
            readFileSyncImpl,
            powershellExe,
          }))
        : '';
      if (identity && pidText && /^[0-9]+$/u.test(pidText)) {
        const script = buildManagedMitmStatusScript({
          pid: pidText,
          executablePath: identity.executablePath,
          argStr: identity.argumentList,
          launcherPath: identity.launcherPath,
        });
        const raw = runPsCommand(`& { ${script} }`, { powershellExe, execFileSyncImpl, stdio: 'pipe' }).toString();
        return parseManagedMitmStatus(raw);
      }
      const runKeyStatus = mitmRunKeyStatus({ execSyncImpl, powershellExe });
      const legacyIdentity = parseLegacyMitmRunKeyValue(runKeyStatus.raw);
      if (!legacyIdentity) return { running: false, state: 'Stopped', raw: '' };
      const script = buildLegacyMitmStatusScript(legacyIdentity);
      const raw = runPsCommand(`& { ${script} }`, { powershellExe, execFileSyncImpl, stdio: 'pipe' }).toString();
      return parseManagedMitmStatus(raw);
    } catch {
      return { running: false, state: 'Unknown' };
    }
  }
  return winswServiceStatus({
    id: MITM_SERVICE_ID,
    home,
    execFileSyncImpl,
    existsSyncImpl,
    powershellExe,
    isWslImpl,
  });
}

export function serviceStatus(opts = {}) {
  const status = engineInstanceStatus(
    legacyEngineInstance({ ...opts, role: 'primary', port: opts.port ?? 8787 }),
    opts,
  );
  return { running: status.running, state: status.state, raw: status.raw };
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

function mitmRunKeyStatus({ execSyncImpl = execSync, powershellExe = powerShellExecutable() } = {}) {
  try {
    const raw = trimPowershellOutput(execSyncImpl(
      withPowerShell(`-NoProfile -Command "(Get-ItemProperty -Path '${REG_RUN}' -Name '${MITM_KEY}' -ErrorAction SilentlyContinue).'${MITM_KEY}'"`, powershellExe),
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
  isWslImpl = isWsl,
  existsSyncImpl = existsSync,
  mkdirSyncImpl = mkdirSync,
  writeFileSyncImpl = writeFileSync,
  runPsFn = runPs,
} = {}) {
  const winHome = defaultWindowsHome(home);
  const serviceExePath = winswExecutablePath({ id, home: winHome });
  const configPath = configPathOverride ?? winswConfigPath({ id, home: winHome });
  const serviceFilesystemExePath = winswFilesystemPathFor(serviceExePath, { isWslImpl });
  const configFilesystemPath = winswFilesystemPathFor(configPath, { isWslImpl });
  if (!existsSyncImpl(serviceFilesystemExePath) || !existsSyncImpl(configFilesystemPath)) {
    throw new Error(`WinSW service assets missing for ${id}`);
  }

  const scriptPath = winswWatchdogScriptPath({ id, home: winHome });
  const logPath = winswWatchdogLogPath({ id, home: winHome });
  const filesystemScriptPath = winswFilesystemPathFor(scriptPath, { isWslImpl });
  mkdirSyncImpl(dirname(filesystemScriptPath), { recursive: true });
  writeFileSyncImpl(filesystemScriptPath, generateWindowsWatchdogHealthcheckScript({
    serviceName,
    healthUrl,
    winswExePath: serviceExePath,
    winswConfigPath: configPath,
    logPath,
  }), 'utf8');
  runPsFn(generateWindowsWatchdogTaskCreateScript({ taskName, scriptPath, intervalMinutes }), { home: winHome });
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
  instances,
  headroomPort,
  copilotHeadroomPort,
  intervalMinutes = 2,
  installWindowsWatchdogTaskImpl = installWindowsWatchdogTask,
  uninstallWindowsWatchdogTaskImpl = uninstallWindowsWatchdogTask,
} = {}) {
  if (Array.isArray(instances)) {
    if (!enabled) {
      for (const instance of instances) {
        uninstallWindowsWatchdogTaskImpl({ id: instance.id, home });
      }
      return null;
    }
    return instances.map((instance) => installWindowsWatchdogTaskImpl({
      id: instance.id,
      serviceName: `Myelin ${instance.id}`,
      healthUrl: instance.healthUrl,
      intervalMinutes,
      home,
    }));
  }
  if (!enabled) {
    uninstallWindowsWatchdogTaskImpl({ id: HEADROOM_SERVICE_ID, home });
    return null;
  }
  const tasks = [];
  if (headroomPort != null) {
    tasks.push(installWindowsWatchdogTaskImpl({
      id: HEADROOM_SERVICE_ID,
      serviceName: 'Myelin Headroom',
      healthUrl: headroomHealthUrl(headroomPort),
      intervalMinutes,
      home,
    }));
  } else {
    uninstallWindowsWatchdogTaskImpl({ id: HEADROOM_SERVICE_ID, home });
  }
  if (copilotHeadroomPort) {
    tasks.push(installWindowsWatchdogTaskImpl({
      id: COPILOT_HEADROOM_SERVICE_ID,
      serviceName: 'Myelin Copilot Headroom',
      healthUrl: headroomHealthUrl(copilotHeadroomPort),
      intervalMinutes,
      home,
    }));
  }
  return tasks;
}
