import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCurrentRelease, runtimePaths } from './release-store.mjs';
import { joinManaged } from '../shared/myelin-paths.mjs';

function launcherModulePath() {
  return fileURLToPath(import.meta.url);
}

function makeExecutable(path, chmodSyncFn = chmodSync) {
  try {
    chmodSyncFn(path, 0o755);
  } catch {}
}

function renderPosixLauncher(launcherPath) {
  return `#!/bin/sh\nexec node "${launcherPath}" "$@"\n`;
}

function renderWindowsLauncher(launcherPath) {
  return `@echo off\r\nnode "${launcherPath}" %*\r\n`;
}

function renderManagedLauncherSource() {
  return `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RELEASE_ID_RE = /^main-[0-9a-f]{7,64}$/;

function runtimePaths(home) {
  const rawRoot = process.env.MYELIN_DIR;
  const root = (typeof rawRoot === 'string' && rawRoot.trim()) ? rawRoot : join(home, '.myelin');
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
  mkdirSyncFn = mkdirSync,
  writeFileSyncFn = writeFileSync,
  chmodSyncFn = chmodSync,
} = {}) {
  const { root, launcherPath } = runtimePaths({ home, rootDir });
  const binDir = joinManaged(root, 'bin');
  const commandPath = joinManaged(binDir, os === 'windows' ? 'myelin.cmd' : 'myelin');

  mkdirSyncFn(binDir, { recursive: true });
  writeFileSyncFn(launcherPath, renderManagedLauncherSource(), 'utf8');
  makeExecutable(launcherPath, chmodSyncFn);

  writeFileSyncFn(
    commandPath,
    os === 'windows' ? renderWindowsLauncher(launcherPath) : renderPosixLauncher(launcherPath),
    'utf8',
  );
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
