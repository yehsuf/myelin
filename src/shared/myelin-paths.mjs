import { win32 as win32Path, posix as posixPath } from 'node:path';

/**
 * This module may import Node stdlib only — it is the shared leaf every other
 * path consumer resolves through, so it must never create an import cycle.
 *
 * Path separators are decided by an *explicit platform input*, never by the
 * host's `process.platform`. Callers that simulate a target OS (tests included)
 * thread their own platform/os token so a darwin/linux run yields POSIX paths
 * even on a Windows host, while real Windows paths stay backslashed. The
 * `platform` default of `process.platform` only ever applies when a caller has
 * no platform of its own — the ambient host is then the correct target.
 */

/**
 * Path implementation for an explicit platform token. `'win32'` and detectOS's
 * `'windows'` map to Windows separators; every other token (`'darwin'`,
 * `'linux'`, WSL, …) maps to POSIX.
 * @param {string} [platform]
 */
export function pathModuleForPlatform(platform = process.platform) {
  return platform === 'win32' || platform === 'windows' ? win32Path : posixPath;
}

/**
 * Heuristic: does an already-resolved path use Windows separators? Used by
 * {@link joinManaged} to extend a resolved managed root (which may be a
 * caller-supplied `MYELIN_DIR`/`rootDir` of either style) without re-plumbing a
 * platform token through every call site.
 * @param {string} p
 */
export function isWindowsStylePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true; // drive-rooted (C:\ or C:/)
  if (p.startsWith('\\\\')) return true; // UNC (\\server\share)
  if (p.startsWith('/')) return false; // POSIX absolute
  return p.includes('\\'); // any other backslash-bearing path
}

/**
 * Join extra segments onto an already-resolved base path, matching the base's
 * separator style. This lets callers extend `managedPaths(...).root` (or another
 * resolved managed path) with the correct separator even when they hold no
 * platform token — the style is taken from the resolved path itself, so a POSIX
 * `MYELIN_DIR` stays POSIX and a Windows drive path stays backslashed.
 * @param {string} base
 * @param {...string} segments
 */
export function joinManaged(base, ...segments) {
  return (isWindowsStylePath(base) ? win32Path : posixPath).join(base, ...segments);
}

/**
 * Resolve the managed Myelin runtime root. Precedence, highest first:
 *   1. an explicit `rootDir` argument (used to thread a caller-selected root
 *      through the release/runtime helpers without touching global env),
 *   2. the `MYELIN_DIR` environment variable,
 *   3. the default `<home>/.myelin` (joined with the explicit `platform`'s
 *      separator).
 */
export function resolveMyelinRoot({ home, env = process.env, rootDir, platform = process.platform } = {}) {
  const nonBlank = (value) =>
    typeof value === 'string' && value.trim() ? value : undefined;
  // A blank/whitespace-only explicit rootDir is treated as absent so it does
  // not shadow a legitimately-set MYELIN_DIR.
  return (
    nonBlank(rootDir) ??
    nonBlank(env?.MYELIN_DIR) ??
    pathModuleForPlatform(platform).join(home, '.myelin')
  );
}

/** Pure path helpers derived from the single resolved managed root. */
export function managedPaths({ home, env, rootDir, platform = process.platform } = {}) {
  const root = resolveMyelinRoot({ home, env, rootDir, platform });
  // Separator style for the derived paths: when a caller relocates the root via
  // an explicit `rootDir`/`MYELIN_DIR` whose style disagrees with `platform`
  // (e.g. a POSIX MYELIN_DIR on a win32 target, or a Windows rootDir on a linux
  // target), joining with `platform`'s separators would splice a mismatched
  // separator into the resolved root (e.g. `C:\\managed/config.yaml`). Derive
  // the style from the resolved root itself in that case so an explicit root
  // keeps one consistent separator. The default `<home>/.myelin` root already
  // tracks `platform`, so it keeps using the platform separator.
  const nonBlank = (value) =>
    typeof value === 'string' && value.trim() ? value : undefined;
  const explicitRoot = nonBlank(rootDir) ?? nonBlank(env?.MYELIN_DIR);
  const { join } = explicitRoot
    ? (isWindowsStylePath(root) ? win32Path : posixPath)
    : pathModuleForPlatform(platform);
  return {
    root,
    configPath: join(root, 'config.yaml'),
    binDir: join(root, 'bin'),
    venvPath: join(root, 'venv'),
    caBundlePath: join(root, 'ca-bundle.pem'),
    releasesDir: join(root, 'releases'),
    currentPointerPath: join(root, 'current.json'),
    launcherPath: join(root, 'bin', 'myelin-launcher.mjs'),
    runtimeBridgeRoot: join(root, 'runtime-bridge'),
    serviceStatePath: join(root, 'state'),
  };
}

/**
 * Forward a non-blank MYELIN_DIR from `env` into a service environment map so a
 * launchd/systemd service resolves the same relocated managed root on every
 * restart (mirrors the Windows service env forwarding). POSIX service
 * definitions use the path verbatim — no separator normalization. MYELIN_DIR is
 * placed first so an explicit caller-supplied `envVars.MYELIN_DIR` still wins.
 */
export function withForwardedMyelinDir(envVars = {}, env = process.env) {
  const raw = env?.MYELIN_DIR;
  return (typeof raw === 'string' && raw.trim())
    ? { MYELIN_DIR: raw, ...envVars }
    : { ...envVars };
}
