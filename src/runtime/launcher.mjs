import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCurrentRelease, runtimePaths } from './release-store.mjs';
import { joinManaged } from '../shared/myelin-paths.mjs';
import { normalizeWindowsFilesystemPath } from '../service/windows.mjs';
import { isWsl } from '../detect/wsl.mjs';

function launcherModulePath() {
  return fileURLToPath(import.meta.url);
}

function makeExecutable(path, chmodSyncFn = chmodSync) {
  try {
    chmodSyncFn(path, 0o755);
  } catch {}
}

function shSingleQuote(value = '') {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

// In a .cmd batch file `%` triggers %VAR% expansion even inside double quotes;
// `%%` collapses back to a literal `%` at parse time. `$(...)`, backticks and
// `$VAR` are NOT special to cmd.exe, so double-quoting already keeps them inert
// — escaping `%` closes the only remaining expansion/injection vector for a
// relocated (MYELIN_DIR-derived, arbitrary) managed path.
function cmdBatchLiteral(value = '') {
  return String(value ?? '').replace(/%/g, '%%');
}

function renderPosixLauncher(launcherPath, nodeBin = process.execPath) {
  // launcherPath is MYELIN_DIR-derived (arbitrary user text). Single-quote it —
  // exactly like nodeBin — so a relocated root containing `$(...)`, backticks,
  // or `$VAR` can never be executed/expanded by /bin/sh when the shim runs.
  return `#!/bin/sh\nexec ${shSingleQuote(nodeBin)} ${shSingleQuote(launcherPath)} "$@"\n`;
}

function renderWindowsLauncher(launcherPath, nodeBin = process.execPath, { rejectPosix = isWsl() } = {}) {
  // Under WSL the launcher module classifies the OS as 'windows', but
  // process.execPath (/usr/bin/node) and a $HOME-derived launcherPath
  // (/home/... or /mnt/<drive>/...) are POSIX paths that native cmd.exe cannot
  // run. Resolve BOTH to native Windows paths (converting /mnt/<drive>/... to
  // <Drive>:\...) so the .cmd is runnable; if a path has no native Windows
  // equivalent, refuse rather than emit a broken shim.
  let nativeNode;
  let nativeLauncher;
  try {
    nativeNode = normalizeWindowsFilesystemPath(nodeBin, { rejectPosix });
    nativeLauncher = normalizeWindowsFilesystemPath(launcherPath, { rejectPosix });
  } catch (error) {
    throw new Error(
      `cannot generate a native Windows launcher (.cmd): ${error.message}`,
    );
  }
  return `@echo off\r\n"${cmdBatchLiteral(nativeNode)}" "${cmdBatchLiteral(nativeLauncher)}" %*\r\n`;
}

function renderManagedLauncherSource() {
  return `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 as win32Path, posix as posixPath } from 'node:path';

const RELEASE_ID_RE = /^main-[0-9a-f]{7,64}$/;
const BACKSLASH = String.fromCharCode(92);

// Mirror src/shared/myelin-paths.mjs isWindowsStylePath so an explicit
// MYELIN_DIR is canonicalized with the same separator semantics the installer
// used (drive-rooted / UNC / backslash-bearing => Windows-style).
function isWindowsStylePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.length >= 3 && /[A-Za-z]/.test(p.charAt(0)) && p.charAt(1) === ':' && (p.charAt(2) === '/' || p.charAt(2) === BACKSLASH)) return true;
  if (p.startsWith(BACKSLASH + BACKSLASH) || p.startsWith('//')) return true;
  if (p.startsWith('/')) return false;
  return p.includes(BACKSLASH);
}

// Mirror resolveMyelinRoot: expand a leading ~ / ~/ / ~BACKSLASH against home,
// root a relative MYELIN_DIR at home (never cwd), pass an absolute value
// through, and fall back to <home>/.myelin for a blank/absent value. Kept in
// lock-step with the installer so generated-runtime and installer state never
// diverge for a ~-prefixed or relative managed root.
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

function runtimePaths(home) {
  const root = resolveManagedRoot(home);
  return {
    releasesDir: join(root, 'releases'),
    currentPointerPath: join(root, 'current.json'),
  };
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

function readCurrentRelease(home) {
  const paths = runtimePaths(home);

  try {
    const parsed = JSON.parse(readFileSync(paths.currentPointerPath, 'utf8'));
    if (
      !parsed
      || typeof parsed !== 'object'
      || parsed.version !== 1
      || typeof parsed.releaseId !== 'string'
      || !RELEASE_ID_RE.test(parsed.releaseId)
    ) {
      return null;
    }

    const runtimeRoot = join(paths.releasesDir, parsed.releaseId);
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

function resolveRuntimeEntrypoint(home = homedir()) {
  const currentRelease = readCurrentRelease(home);
  if (!currentRelease?.runtimeRoot) {
    throw new Error('no current managed runtime configured');
  }

  return join(currentRelease.runtimeRoot, 'src', 'cli', 'index.mjs');
}

try {
  const entrypoint = resolveRuntimeEntrypoint();
  if (!existsSync(entrypoint)) {
    throw new Error(\`managed runtime entrypoint missing: \${entrypoint}\`);
  }

  const child = spawnSync(process.execPath, [entrypoint, ...process.argv.slice(2)], { stdio: 'inherit' });
  if (child.error) {
    throw child.error;
  }

  process.exit(child.status ?? 1);
} catch (error) {
  console.error(\`[myelin] \${error.message}\`);
  process.exit(1);
}
`;
}

export function resolveRuntimeEntrypoint({ home = homedir(), rootDir, readCurrentReleaseFn = readCurrentRelease } = {}) {
  const currentRelease = readCurrentReleaseFn({ home, rootDir });
  if (!currentRelease?.runtimeRoot) {
    throw new Error('no current managed runtime configured');
  }

  return joinManaged(currentRelease.runtimeRoot, 'src', 'cli', 'index.mjs');
}

export function writeManagedLauncher({
  home = homedir(),
  rootDir,
  os,
  nodeBin = process.execPath,
  wsl = isWsl(),
  mkdirSyncFn = mkdirSync,
  writeFileSyncFn = writeFileSync,
  chmodSyncFn = chmodSync,
} = {}) {
  // Under WSL the launcher classifies the OS as 'windows' but the underlying
  // paths (home, nodeBin, launcherPath) are POSIX (/home/... or /mnt/<drive>/...).
  // If runtimePaths joined them with the host's separators, a real Windows host
  // (process.platform === 'win32') would mangle `/mnt/d/...` into `\mnt\d\...`
  // BEFORE renderWindowsLauncher could convert it to `D:\...` — the same input
  // would then behave differently on Windows vs macOS/Linux. Pin the path style
  // to POSIX from the EXPLICIT `wsl` signal so the /mnt/<drive>→<Drive>:\
  // conversion and the refuse-on-non-convertible decision are deterministic on
  // every host. For the non-WSL cases the ambient platform is the correct target
  // (a native Windows host builds Windows paths; POSIX hosts build POSIX paths),
  // so leave `platform` unset to preserve that behavior.
  const pathPlatform = wsl ? 'linux' : undefined;
  const { root, launcherPath } = runtimePaths({ home, rootDir, platform: pathPlatform });
  const binDir = joinManaged(root, 'bin');
  const commandPath = joinManaged(binDir, os === 'windows' ? 'myelin.cmd' : 'myelin');

  // Render the command shim BEFORE writing anything so a non-convertible
  // (WSL/POSIX) Windows launcher fails fast without leaving a partial install.
  const commandContent = os === 'windows'
    ? renderWindowsLauncher(launcherPath, nodeBin, { rejectPosix: wsl })
    : renderPosixLauncher(launcherPath, nodeBin);

  mkdirSyncFn(binDir, { recursive: true });
  writeFileSyncFn(launcherPath, renderManagedLauncherSource(), 'utf8');
  makeExecutable(launcherPath, chmodSyncFn);

  writeFileSyncFn(commandPath, commandContent, 'utf8');
  makeExecutable(commandPath, chmodSyncFn);

  return { binDir, launcherPath, commandPath };
}

export function runManagedLauncher({
  home = homedir(),
  rootDir,
  existsSyncFn = existsSync,
  spawnSyncFn = spawnSync,
} = {}) {
  const entrypoint = resolveRuntimeEntrypoint({ home, rootDir });
  if (!existsSyncFn(entrypoint)) {
    throw new Error(`managed runtime entrypoint missing: ${entrypoint}`);
  }

  const child = spawnSyncFn(process.execPath, [entrypoint, ...process.argv.slice(2)], { stdio: 'inherit' });
  if (child.error) {
    throw child.error;
  }

  return child.status ?? 1;
}

function isDirectExecution() {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === launcherModulePath();
}

if (isDirectExecution()) {
  try {
    process.exit(runManagedLauncher());
  } catch (error) {
    console.error(`[myelin] ${error.message}`);
    process.exit(1);
  }
}
