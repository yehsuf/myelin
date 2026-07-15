import { execSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, posix as pathPosix } from 'node:path';
import { writeManagedLauncher } from '../runtime/launcher.mjs';

/**
 * Resolve where npm puts global bin shims for a given prefix.
 * Pure — no filesystem/process access — so it's directly unit-testable.
 * On POSIX, npm puts shims in <prefix>/bin. On Windows, npm puts them
 * directly in <prefix> itself (no bin/ subfolder).
 */
export function resolveGlobalBinDir(prefix, os) {
  return os === 'windows' ? prefix : pathPosix.join(prefix, 'bin');
}

/**
 * Check whether we can actually write into a given directory, creating it
 * first if it doesn't exist yet. Returns false (never throws) on any
 * failure — permission denied, read-only filesystem, etc.
 */
function isWritable(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.myelin-write-probe-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function makeExecutable(path) {
  try {
    chmodSync(path, 0o755);
  } catch {}
}

/**
 * Write a stable managed-runtime launcher into ~/.myelin/bin and, when the
 * npm global prefix is writable, copy the platform-specific command shim into
 * npm's global bin dir. This avoids ever executing a caller checkout.
 */
export function linkGlobalBin({ os, prefix = null, home = homedir() } = {}) {
  try {
    const resolvedPrefix = prefix
      ?? execSync('npm config get prefix', { stdio: 'pipe' }).toString().trim();
    const globalBinDir = resolveGlobalBinDir(resolvedPrefix, os);
    const launcher = writeManagedLauncher({ home, os });

    if (!isWritable(globalBinDir)) {
      return {
        linked: false,
        reason: `no write access to npm global bin dir (${globalBinDir})`,
        binDir: launcher.binDir,
        launcherPath: launcher.launcherPath,
        commandPath: launcher.commandPath,
      };
    }

    const linkedCommandPath = join(globalBinDir, basename(launcher.commandPath));
    if (linkedCommandPath !== launcher.commandPath) {
      copyFileSync(launcher.commandPath, linkedCommandPath);
      makeExecutable(linkedCommandPath);
    }

    return {
      linked: true,
      reason: null,
      binDir: globalBinDir,
      launcherPath: launcher.launcherPath,
      commandPath: linkedCommandPath,
    };
  } catch (e) {
    return { linked: false, reason: e.message.split('\n')[0], binDir: null, launcherPath: null, commandPath: null };
  }
}
