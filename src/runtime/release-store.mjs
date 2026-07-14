import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { joinManaged, managedPaths } from '../shared/myelin-paths.mjs';

const RELEASE_ID_RE = /^main-[0-9a-f]{7,64}$/;

function normalizeRootArgs(arg) {
  return typeof arg === 'string' ? { home: arg } : (arg ?? {});
}

export function runtimePaths(arg) {
  const { home, rootDir } = normalizeRootArgs(arg);
  const { root, releasesDir, currentPointerPath, launcherPath } = managedPaths({ home, rootDir });
  return {
    root,
    releasesDir,
    currentPointerPath,
    launcherPath,
  };
}

export function releaseIdForCommit(commit) {
  return `main-${commit}`;
}

function releaseRuntimeRoot({ home, rootDir }, releaseId) {
  return joinManaged(runtimePaths({ home, rootDir }).releasesDir, releaseId);
}

function currentReleasePointer({ home, rootDir }, releaseId) {
  return {
    version: 1,
    releaseId,
    runtimeRoot: releaseRuntimeRoot({ home, rootDir }, releaseId),
  };
}

function isValidReleaseId(releaseId) {
  return typeof releaseId === 'string' && RELEASE_ID_RE.test(releaseId);
}

function isValidPointer({ home, rootDir }, value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.version === 1
    && isValidReleaseId(value.releaseId)
    && value.runtimeRoot === releaseRuntimeRoot({ home, rootDir }, value.releaseId)
  );
}

export function readCurrentRelease({ home, rootDir, readFileSyncFn = readFileSync } = {}) {
  const { currentPointerPath } = runtimePaths({ home, rootDir });

  try {
    const parsed = JSON.parse(readFileSyncFn(currentPointerPath, 'utf8'));
    if (!isValidPointer({ home, rootDir }, parsed)) {
      return null;
    }

    return currentReleasePointer({ home, rootDir }, parsed.releaseId);
  } catch {
    return null;
  }
}

export function writeCurrentRelease({
  home,
  rootDir,
  releaseId,
  renameSyncFn = renameSync,
  readFileSyncFn = readFileSync,
  writeFileSyncFn = writeFileSync,
  mkdirSyncFn = mkdirSync,
} = {}) {
  if (!isValidReleaseId(releaseId)) {
    throw new Error(`invalid release id: ${releaseId}`);
  }

  const paths = runtimePaths({ home, rootDir });
  const pointer = currentReleasePointer({ home, rootDir }, releaseId);
  const tempPointerPath = `${paths.currentPointerPath}.${process.pid}.tmp`;

  mkdirSyncFn(paths.root, { recursive: true });
  mkdirSyncFn(paths.releasesDir, { recursive: true });

  try {
    writeFileSyncFn(tempPointerPath, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');

    let parsed;
    try {
      parsed = JSON.parse(readFileSyncFn(tempPointerPath, 'utf8'));
    } catch {
      unlinkSync(tempPointerPath);
      throw new Error('invalid current release pointer');
    }

    if (!isValidPointer({ home, rootDir }, parsed)) {
      unlinkSync(tempPointerPath);
      throw new Error('invalid current release pointer');
    }

    renameSyncFn(tempPointerPath, paths.currentPointerPath);
    return pointer;
  } catch (error) {
    try {
      unlinkSync(tempPointerPath);
    } catch {}
    throw error;
  }
}
