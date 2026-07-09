import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

function hasCopilotHook(config) {
  const pascal = config?.hooks?.PreToolUse;
  const camel = config?.hooks?.preToolUse;
  const hasPascal = Array.isArray(pascal) && pascal.some((entry) =>
    typeof entry?.command === 'string' && entry.command.includes('rtk hook copilot'));
  const hasCamel = Array.isArray(camel) && camel.some((entry) =>
    (typeof entry?.bash === 'string' && entry.bash.includes('rtk hook copilot'))
    || (typeof entry?.powershell === 'string' && entry.powershell.includes('rtk hook copilot')));
  return hasPascal || hasCamel;
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
    hookConfigured: hasCopilotHook(copilotHook.value),
    instructionsPresent: (copilotInstructions?.includes('<!-- rtk-instructions') || copilotInstructions?.includes('# RTK')) ?? false,
    hookUnreadable: copilotHook.unreadable,
  };
  copilot.ok = copilot.hookConfigured && copilot.instructionsPresent;
  copilot.detail = copilot.ok ? 'hook file + copilot-instructions.md present' : [
    !copilot.hookConfigured && (copilot.hookUnreadable ? 'hook file unreadable' : 'hook file missing or incomplete'),
    !copilot.instructionsPresent && 'copilot-instructions.md missing',
  ].filter(Boolean).join('; ');

  return { claude, copilot };
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
    const binDir = join(homedir(), '.myelin', 'bin');
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
