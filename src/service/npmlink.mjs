import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix as pathPosix } from 'node:path';

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

/**
 * Attempt to expose the `myelin` command globally via npm's own bin-linking
 * mechanism (the standard, idiomatic way to ship a Node CLI), instead of
 * hand-writing shell aliases/functions. This is what package.json's "bin"
 * field is for — npm generates the platform-correct shim itself (POSIX
 * symlink+chmod, Windows .cmd/.ps1 wrapper), still just executing the same
 * source files (no bundling), so self-update via `git pull` continues to
 * work unchanged.
 *
 * Accepts an optional `prefix` override so this can be exercised in a fully
 * isolated sandbox (e.g. `npm link --prefix /tmp/fake-prefix`) without ever
 * touching the real global npm state — used by tests and pre-deploy checks.
 *
 * Gracefully returns { linked: false, reason } instead of throwing when the
 * global prefix isn't writable (common on some corp machines) — callers
 * should fall back to the existing shell-alias approach in that case.
 */
export function linkGlobalBin({ repoRoot, os, prefix = null } = {}) {
  try {
    const resolvedPrefix = prefix
      ?? execSync('npm config get prefix', { stdio: 'pipe' }).toString().trim();
    const binDir = resolveGlobalBinDir(resolvedPrefix, os);
    if (!isWritable(binDir)) {
      return { linked: false, reason: `no write access to npm global bin dir (${binDir})`, binDir };
    }
    // `npm link` is always implicitly global — `-g`/`--global` is rejected as
    // redundant, and the `--prefix` CLI flag means something different in
    // this context (it's read as "project root to link", not "global
    // install location", causing an ENOENT looking for package.json there).
    // The sanctioned way to override the global prefix for one invocation
    // is the npm_config_prefix env var — verified live against a real
    // sandboxed prefix.
    const env = prefix ? { ...process.env, npm_config_prefix: prefix } : process.env;
    execSync('npm link --registry https://registry.npmjs.org', { cwd: repoRoot, stdio: 'pipe', env });
    return { linked: true, reason: null, binDir };
  } catch (e) {
    return { linked: false, reason: e.message.split('\n')[0], binDir: null };
  }
}
