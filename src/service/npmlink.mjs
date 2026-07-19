import { execSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, posix as pathPosix, resolve, sep } from 'node:path';
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
 * Return true when the npm prefix resolves to the myelin package checkout
 * itself — which happens during development when `npm link` is run from the
 * repo. In that case, globalBinDir is <repo>/bin and copying the generated
 * launcher shim there would overwrite the committed ESM entry-point wrapper.
 *
 * Two detection strategies (both checked):
 *  1. Explicit repoRoot: caller knows the checkout path; compare directly.
 *  2. Auto-detect: prefix contains a package.json with a "bin.myelin" entry.
 *
 * On Windows, path comparison is case-insensitive (NTFS).
 */
function isNpmPrefixPackageCheckout(prefix, repoRoot = null) {
  const resolvedPrefix = resolve(prefix);
  if (repoRoot) {
    const resolvedRepo = resolve(repoRoot);
    // Case-insensitive on Windows (NTFS); case-sensitive on POSIX.
    const norm = process.platform === 'win32'
      ? (p) => p.toLowerCase()
      : (p) => p;
    if (norm(resolvedPrefix) === norm(resolvedRepo) ||
        norm(resolvedPrefix).startsWith(norm(resolvedRepo) + sep)) {
      return true;
    }
  }
  try {
    const pkg = JSON.parse(readFileSync(join(resolvedPrefix, 'package.json'), 'utf8'));
    return typeof pkg?.bin?.myelin === 'string';
  } catch {
    return false;
  }
}

/**
 * Write a stable managed-runtime launcher into ~/.myelin/bin and, when the
 * npm global prefix is writable, copy the platform-specific command shim into
 * npm's global bin dir. This avoids ever executing a caller checkout.
 */
export function linkGlobalBin({ os, prefix = null, home = homedir(), repoRoot = null } = {}) {
  try {
    const resolvedPrefix = prefix
      ?? execSync('npm config get prefix', { stdio: 'pipe' }).toString().trim();
    const globalBinDir = resolveGlobalBinDir(resolvedPrefix, os);

    // Guard BEFORE isWritable: if npm prefix points to the package checkout
    // (via `npm link`), globalBinDir is <repo>/bin. isWritable would create
    // that directory via mkdirSync before we could detect the problem — so
    // we must check first and bail out early, keeping the checkout clean.
    if (isNpmPrefixPackageCheckout(resolvedPrefix, repoRoot)) {
      const launcher = writeManagedLauncher({ home, os });
      return {
        linked: false,
        reason: 'npm prefix points to package checkout — committed bin/myelin protected',
        binDir: launcher.binDir,
        launcherPath: launcher.launcherPath,
        commandPath: launcher.commandPath,
      };
    }

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
      // Break any existing symlink before copying — copyFileSync follows
      // symlinks, so a prior `npm link` that created a symlink from the
      // global bin dir back to the repo's bin/myelin would cause us to
      // overwrite the committed checkout file.
      // rmSync({ force: true }) removes the symlink itself (not its target),
      // ignores ENOENT, and propagates EACCES so a root-owned symlink fails
      // visibly rather than silently falling back to the original bug.
      rmSync(linkedCommandPath, { force: true });
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
