import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { managedPaths, joinManaged, isWindowsStylePath } from '../shared/myelin-paths.mjs';

export const RTK_PINNED_VERSION = '0.43.0';

export function parseRtkVersion(raw = '') {
  const m = raw.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

export function getRtkVersionStatus(raw = '') {
  const parsedVersion = parseRtkVersion(raw);
  return {
    parsedVersion,
    pinnedVersion: RTK_PINNED_VERSION,
    pinnedVersionMatches: parsedVersion === RTK_PINNED_VERSION,
  };
}

export function formatRtkVersionDetail(info = {}) {
  if (!info?.installed) return 'not found — run: myelin update';
  if (!info.parsedVersion) return `${info.version} — unable to parse semver (expected ${RTK_PINNED_VERSION})`;
  if (info.pinnedVersionMatches) return info.version;
  return `${info.version} — pinned ${RTK_PINNED_VERSION} verified; re-test output fidelity before upgrading`;
}

export function getRtkVersionWarning(info = {}) {
  if (!info?.installed) return null;
  if (!info.parsedVersion) {
    return `rtk version output was unparseable (${info.version}); expected pinned ${RTK_PINNED_VERSION}.`;
  }
  if (info.pinnedVersionMatches) return null;
  return `rtk ${info.parsedVersion} detected; pinned ${RTK_PINNED_VERSION} is the known-good version for Myelin hook/output stability.`;
}

function readTextIfExists(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return { value: null, unreadable: false };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), unreadable: false };
  } catch {
    return { value: null, unreadable: true };
  }
}

function hasClaudeHook(settings) {
  const entries = settings?.hooks?.PreToolUse;
  return Array.isArray(entries) && entries.some((entry) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((hook) =>
      typeof hook?.command === 'string' && hook.command.includes('rtk hook claude')));
}

/** Every command string across a Copilot/Claude hook config, regardless of
 *  event-key casing (preToolUse/PreToolUse), entry shape (flat vs the nested
 *  {matcher, hooks:[...]} VS Code shape), or field (command/bash/powershell). */
function collectHookCommands(config) {
  const cmds = [];
  const events = config?.hooks;
  if (!events || typeof events !== 'object') return cmds;
  const push = (obj) => {
    for (const field of ['command', 'bash', 'powershell']) {
      if (typeof obj?.[field] === 'string') cmds.push(obj[field]);
    }
  };
  for (const entries of Object.values(events)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      push(entry);
      if (Array.isArray(entry?.hooks)) for (const h of entry.hooks) push(h);
    }
  }
  return cmds;
}

/** A hook that invokes the raw `rtk hook copilot` binary directly — the
 *  fail-CLOSED, session-bricking form `rtk init --copilot` generates. The word
 *  boundary keeps this from matching our safe `rtk-guard copilot` wrapper. */
export function isRawUnsafeRtkHook(config) {
  return collectHookCommands(config).some((c) => /(^|[^\w-])rtk\s+hook\s+/.test(c));
}

/** A hook routed through the fail-open `myelin rtk-guard` wrapper. */
export function isGuardedRtkHook(config) {
  return collectHookCommands(config).some((c) => c.includes('rtk-guard'));
}

export function detectRtkHookArtifacts({ home = homedir() } = {}) {
  const claudeSettingsPath = join(home, '.claude', 'settings.json');
  const claudeMdPath = join(home, '.claude', 'CLAUDE.md');
  const claudeRtkMdPath = join(home, '.claude', 'RTK.md');
  const copilotMcpPath = join(home, '.copilot', 'mcp-config.json');
  const copilotHookPath = join(home, '.copilot', 'hooks', 'rtk-rewrite.json');
  const copilotInstructionsPath = join(home, '.copilot', 'copilot-instructions.md');

  const claudeSettings = readJsonIfExists(claudeSettingsPath);
  const copilotHook = readJsonIfExists(copilotHookPath);
  const claudeMd = readTextIfExists(claudeMdPath);
  const copilotInstructions = readTextIfExists(copilotInstructionsPath);

  const claude = {
    relevant: [claudeSettingsPath, claudeMdPath, claudeRtkMdPath].some(existsSync),
    hookConfigured: hasClaudeHook(claudeSettings.value),
    rtkMdPresent: existsSync(claudeRtkMdPath),
    claudeReferencePresent: claudeMd?.includes('@RTK.md') ?? false,
    settingsUnreadable: claudeSettings.unreadable,
  };
  claude.ok = claude.hookConfigured && claude.rtkMdPresent && claude.claudeReferencePresent;
  claude.detail = claude.ok ? 'hook + RTK.md + @RTK.md present' : [
    !claude.hookConfigured && (claude.settingsUnreadable ? 'settings.json unreadable' : 'settings.json hook missing'),
    !claude.rtkMdPresent && 'RTK.md missing',
    !claude.claudeReferencePresent && 'CLAUDE.md missing @RTK.md',
  ].filter(Boolean).join('; ');

  const copilot = {
    relevant: [copilotMcpPath, copilotHookPath, copilotInstructionsPath].some(existsSync),
    hookConfigured: isGuardedRtkHook(copilotHook.value),
    hookUnsafe: isRawUnsafeRtkHook(copilotHook.value),
    instructionsPresent: (copilotInstructions?.includes('<!-- rtk-instructions') || copilotInstructions?.includes('# RTK')) ?? false,
    hookUnreadable: copilotHook.unreadable,
  };
  // A raw `rtk hook copilot` hook is worse than no hook: it fail-CLOSES every
  // tool call when rtk isn't on Copilot's PATH. Never report that as ok.
  copilot.ok = copilot.hookConfigured && !copilot.hookUnsafe && copilot.instructionsPresent;
  copilot.detail = copilot.ok ? 'fail-open guarded hook + copilot-instructions.md present' : [
    copilot.hookUnsafe && 'UNSAFE raw `rtk hook copilot` hook (fail-closed) — run `myelin install` to heal',
    !copilot.hookConfigured && !copilot.hookUnsafe && (copilot.hookUnreadable ? 'hook file unreadable' : 'hook file missing or incomplete'),
    !copilot.instructionsPresent && 'copilot-instructions.md missing',
  ].filter(Boolean).join('; ');

  return { claude, copilot };
}

const defaultFs = { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync };

/** Windows paths use `\`; the bash Copilot runs (Git Bash on Windows too)
 *  wants `/`. */
export function toPosixPath(p = '') {
  return String(p).replace(/\\/g, '/');
}

/** Absolute path (trailing slash) to the managed runtime bridge, so the RTK
 *  hook always re-enters Myelin through a current.json-validating bridge
 *  instead of a checkout path. */
export function resolveMyelinRepoRoot({ home = homedir(), rootDir, env = process.env, plat = process.platform, exists = existsSync } = {}) {
  const bridgeRoot = managedPaths({ home, env, rootDir, platform: plat }).runtimeBridgeRoot;
  // The bridge root can be a relocated MYELIN_DIR/rootDir whose separator style
  // disagrees with `plat` (a Windows rootDir resolved on a POSIX host, or a
  // POSIX MYELIN_DIR on a Windows host). Probe and terminate it in the root's
  // OWN style so we never splice a mismatched separator (e.g.
  // `D:\managed\runtime-bridge/src/...` or a trailing `/` on a backslash path).
  const sep = isWindowsStylePath(bridgeRoot) ? '\\' : '/';
  const probe = joinManaged(bridgeRoot, 'src', 'cli', 'index.mjs');
  try { if (exists(probe)) return bridgeRoot + sep; } catch { /* fall through */ }
  return bridgeRoot + sep;
}

export function copilotRtkHookPath(home = homedir()) {
  return join(home, '.copilot', 'hooks', 'rtk-rewrite.json');
}

/**
 * The bash command Copilot CLI runs for the RTK preToolUse hook. Copilot honors
 * the `bash` field on every platform (Windows included) and preToolUse hooks
 * are fail-CLOSED on non-zero exit, so this string is built for three safety
 * properties, in priority order:
 *   1. Trailing `; exit 0` — the shell ALWAYS exits 0, so even if node is gone
 *      or the guard can't spawn, the tool call is never denied. This is the
 *      invariant that stops `myelin init/install` from bricking Copilot.
 *   2. Absolute node path — the guard runs even under the minimal PATH Copilot
 *      spawns hooks with (the original Windows failure: `rtk` off PATH -> 127).
 *   3. `2>/dev/null` — the guard's stderr is dropped; only a decision on stdout
 *      reaches Copilot.
 */
export function buildRtkGuardBashCommand({ nodePath = process.execPath, repoRoot } = {}) {
  const root = repoRoot ?? resolveMyelinRepoRoot();
  const node = toPosixPath(nodePath);
  const cli = toPosixPath(root).replace(/\/?$/, '/') + 'src/cli/index.mjs';
  return `"${node}" "${cli}" rtk-guard copilot 2>/dev/null; exit 0`;
}

/** The full fail-open replacement for `~/.copilot/hooks/rtk-rewrite.json`.
 *  Canonical Copilot CLI shape: camelCase `preToolUse`, flat entry, `bash`
 *  field, `bash` matcher (RTK only rewrites shell commands). */
export function buildGuardedRtkCopilotHook({ nodePath = process.execPath, repoRoot } = {}) {
  return {
    version: 1,
    hooks: {
      preToolUse: [
        {
          type: 'command',
          matcher: 'bash',
          bash: buildRtkGuardBashCommand({ nodePath, repoRoot }),
          cwd: '.',
          timeoutSec: 5,
        },
      ],
    },
  };
}

/**
 * Guarantee the global RTK Copilot hook can never brick a session. Modes:
 *   - 'active'    : (re)write the fail-open guarded hook, replacing any raw
 *                   `rtk hook copilot` `rtk init --copilot` may have written.
 *   - 'inactive'  : RTK is off/absent — remove our (or a raw rtk) hook so a
 *                   previously-bricked machine is healed. Never touches a
 *                   foreign hand-written hook that happens to share the path.
 *   - 'heal-only' : only rewrite a raw hook to the guarded form; never create
 *                   or remove. Safe to call from `myelin init`.
 * fs is injectable for tests; every path is defensive and returns a status.
 */
export function ensureSafeRtkCopilotHook({
  home = homedir(),
  nodePath = process.execPath,
  repoRoot,
  mode = 'active',
  fs = defaultFs,
} = {}) {
  const path = copilotRtkHookPath(home);
  const present = fs.existsSync(path);
  let existing = null;
  if (present) {
    try { existing = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { existing = null; }
  }
  const writeGuarded = () => {
    const config = buildGuardedRtkCopilotHook({ nodePath, repoRoot });
    fs.mkdirSync(join(home, '.copilot', 'hooks'), { recursive: true });
    fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  };

  if (mode === 'active') {
    writeGuarded();
    return { action: 'wrote-guarded', path };
  }

  if (mode === 'heal-only') {
    if (present && isRawUnsafeRtkHook(existing) && !isGuardedRtkHook(existing)) {
      writeGuarded();
      return { action: 'healed-raw', path };
    }
    return { action: 'noop', path };
  }

  // mode === 'inactive'
  if (!present) return { action: 'noop', path };
  if (existing === null || isGuardedRtkHook(existing) || isRawUnsafeRtkHook(existing)) {
    try { fs.unlinkSync(path); return { action: 'removed-unsafe', path }; }
    catch { return { action: 'remove-failed', path }; }
  }
  return { action: 'left-foreign', path };
}

export function rtkInstallStrategy(os) {
  if (os === 'windows') {
    return [
      { method: 'github_release', label: 'Download RTK binary (GitHub)' },
      { method: 'cargo', label: 'Build from source (cargo install rtk) — requires Rust + VS Build Tools (~3GB)' },
    ];
  }
  if (os === 'linux') {
    return [
      { method: 'github_release', label: 'Download RTK binary (GitHub)' },
      { method: 'brew', label: 'brew install rtk (Linuxbrew)' },
      { method: 'cargo', label: 'cargo install rtk' },
    ];
  }
  // darwin
  return [
    { method: 'brew', label: 'brew install rtk' },
    { method: 'cargo', label: 'cargo install rtk' },
  ];
}

export async function installRtk(os) {
  const strategies = rtkInstallStrategy(os);
  for (const s of strategies) {
    try {
      if (s.method === 'brew') {
        execSync('brew install rtk', { stdio: 'inherit' });
        return { method: 'brew', ok: true };
      }
      if (s.method === 'github_release') {
        const ok = await tryGithubRelease();
        if (ok) return { method: 'github_release', ok: true };
      }
      if (s.method === 'cargo') {
        console.warn('[myelin] Installing RTK via cargo — this may take a few minutes.');
        if (os === 'windows') {
          console.warn('[myelin] WARNING: cargo on Windows requires ~3GB Visual Studio Build Tools.');
        }
        execSync('cargo install rtk --locked', { stdio: 'inherit' });
        return { method: 'cargo', ok: true };
      }
    } catch (e) {
      console.warn(`[myelin] RTK install via ${s.method} failed: ${e.message}`);
    }
  }
  console.warn('[myelin] SKIP: RTK could not be installed. Shell compression inactive.');
  return { method: null, ok: false };
}

export function runRtkInit(args, { cwd, env } = {}) {
  const child = spawnSync('rtk', args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`.trim();
  if (child.error) {
    return { ok: false, status: child.status ?? null, output, error: child.error.message };
  }
  return { ok: child.status === 0, status: child.status ?? 0, output, error: null };
}

async function tryGithubRelease() {
  try {
    const { platform, arch } = await import('node:os').then(m => ({ platform: m.platform(), arch: m.arch() }));
    const res = await fetch('https://api.github.com/repos/rtk-ai/rtk/releases/latest');
    const data = await res.json();
    const binDir = managedPaths({ home: homedir() }).binDir;
    mkdirSync(binDir, { recursive: true });

    if (platform === 'win32') {
      const asset = data.assets?.find(a => a.name.includes('windows') && a.name.endsWith('.zip'));
      if (!asset) return false;
      execSync(`powershell -Command "Invoke-WebRequest '${asset.browser_download_url}' -OutFile $env:TEMP\\rtk.zip; Expand-Archive $env:TEMP\\rtk.zip -DestinationPath '${binDir}' -Force"`, { stdio: 'inherit' });
      return true;
    }

    if (platform === 'linux') {
      const archStr = arch === 'arm64' ? 'aarch64' : 'x86_64';
      const asset = data.assets?.find(a => a.name.includes(archStr) && a.name.includes('linux') && a.name.endsWith('.tar.gz'));
      if (!asset) return false;
      execSync(`curl -fsSL '${asset.browser_download_url}' | tar -xz -C '${binDir}' && chmod +x '${join(binDir, 'rtk')}'`, { shell: true, stdio: 'inherit' });
      // Add to PATH if not already there
      try { execSync(`export PATH="${binDir}:$PATH" && rtk --version`, { shell: true, stdio: 'pipe' }); } catch {}
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
