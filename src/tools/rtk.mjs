import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function parseRtkVersion(raw = '') {
  const m = raw.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
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

async function tryGithubRelease() {
  try {
    const { platform, arch } = await import('node:os').then(m => ({ platform: m.platform(), arch: m.arch() }));
    const res = await fetch('https://api.github.com/repos/rtk-ai/rtk/releases/latest');
    const data = await res.json();
    const binDir = join(homedir(), '.tokenstack', 'bin');
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
