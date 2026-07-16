import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { releaseIdForCommit, runtimePaths, writeCurrentRelease } from './release-store.mjs';
import { joinManaged } from '../shared/myelin-paths.mjs';

function tempStageRoot(paths, now) {
  return joinManaged(paths.root, `releases-stage-main-${process.pid}-${now}`);
}

function isReusableRelease(runtimeRoot, existsSyncFn) {
  return existsSyncFn(joinManaged(runtimeRoot, 'src', 'cli', 'index.mjs'))
    && existsSyncFn(joinManaged(runtimeRoot, 'node_modules'));
}

export function stageMainRuntime({
  home,
  rootDir,
  repoUrl,
  activate = true,
  execFileSyncFn = execFileSync,
  existsSyncFn = existsSync,
  rmSyncFn = rmSync,
  mkdirSyncFn = mkdirSync,
  renameSyncFn = renameSync,
  writeCurrentReleaseFn = writeCurrentRelease,
  runtimePathsFn = runtimePaths,
  releaseIdForCommitFn = releaseIdForCommit,
  nowFn = Date.now,
} = {}) {
  const paths = runtimePathsFn({ home, rootDir });
  const stageRoot = tempStageRoot(paths, nowFn());
  let removeStageRoot = true;

  mkdirSyncFn(paths.root, { recursive: true });
  mkdirSyncFn(paths.releasesDir, { recursive: true });
  mkdirSyncFn(stageRoot, { recursive: true });

  try {
    execFileSyncFn('git', ['clone', '--depth', '1', '--branch', 'main', repoUrl, stageRoot], {
      stdio: 'inherit',
    });

    const commit = String(execFileSyncFn('git', ['rev-parse', 'HEAD'], {
      cwd: stageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })).trim();

    const releaseId = releaseIdForCommitFn(commit);
    const runtimeRoot = joinManaged(paths.releasesDir, releaseId);

    // An existing, complete release for this exact commit is reused as-is; the
    // staged candidate is discarded and no rebuild is performed.
    if (existsSyncFn(runtimeRoot) && isReusableRelease(runtimeRoot, existsSyncFn)) {
      rmSyncFn(stageRoot, { recursive: true, force: true });
      removeStageRoot = false;
      if (activate) writeCurrentReleaseFn({ home, rootDir, releaseId });
      return { releaseId, runtimeRoot, reused: true };
    }

    // Validate the candidate BEFORE touching any existing release directory, so
    // a failed restage (including a same-commit restage that targets the active
    // release) can never destroy a working runtime before a validated
    // replacement exists.
    execFileSyncFn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts'], {
      cwd: stageRoot,
      stdio: 'inherit',
    });
    execFileSyncFn(process.platform === 'win32' ? 'node.exe' : 'node', ['--check', 'src/cli/index.mjs'], {
      cwd: stageRoot,
      stdio: 'inherit',
    });

    // Candidate validated — now it is safe to replace an incomplete destination.
    if (existsSyncFn(runtimeRoot)) {
      rmSyncFn(runtimeRoot, { recursive: true, force: true });
    }

    renameSyncFn(stageRoot, runtimeRoot);
    removeStageRoot = false;

    if (activate) writeCurrentReleaseFn({ home, rootDir, releaseId });
    return { releaseId, runtimeRoot, reused: false };
  } catch (error) {
    if (removeStageRoot) {
      try {
        rmSyncFn(stageRoot, { recursive: true, force: true });
      } catch {}
    }
    throw error;
  }
}
