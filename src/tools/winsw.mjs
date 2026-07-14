import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { win32 as pathWin32 } from 'node:path';
import { isWsl } from '../detect/wsl.mjs';

export const WINSW_REPO = 'winsw/winsw';
// Pinned to the current 3.x line this Windows keepalive work was researched
// against. Revisit after a real Windows validation pass on this repo's target
// machines.
export const WINSW_PINNED_VERSION = 'v3.0.0-alpha.11';

function normalizePinnedVersion(version = WINSW_PINNED_VERSION) {
  return String(version).replace(/^v/, '');
}

export function parseWinswVersion(raw = '') {
  const m = String(raw).match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return m ? m[1] : null;
}

export function getWinswVersionStatus(raw = '') {
  const parsedVersion = parseWinswVersion(raw);
  return {
    parsedVersion,
    pinnedVersion: normalizePinnedVersion(),
    pinnedVersionMatches: parsedVersion === normalizePinnedVersion(),
  };
}

export function winswBinPath({ home = homedir() } = {}) {
  return pathWin32.join(home, '.myelin', 'bin', 'winsw.exe');
}

export function winswFilesystemPath(value = '', { wsl = isWsl() } = {}) {
  const commandPath = String(value ?? '');
  if (!wsl) return commandPath;
  const match = commandPath.replace(/\\/g, '/').match(/^([a-zA-Z]):\/?(.*)$/u);
  if (match) {
    const [, drive, rest = ''] = match;
    return `/mnt/${drive.toLowerCase()}${rest ? `/${rest}` : ''}`;
  }
  if (/^[/\\]{2}/u.test(commandPath)) {
    throw new Error(`Cannot access UNC WinSW assets from WSL with Node filesystem APIs: ${commandPath}`);
  }
  return commandPath;
}

export function winswReleaseApiUrl(version = WINSW_PINNED_VERSION) {
  return `https://api.github.com/repos/${WINSW_REPO}/releases/tags/${version}`;
}

export function selectWinswAsset(release = {}, { arch = process.arch, preferNetFx = false } = {}) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const findAsset = (predicate) => assets.find((asset) => predicate(String(asset?.name ?? '').toLowerCase(), asset)) ?? null;

  if (preferNetFx) {
    return findAsset((name) => name === 'winsw-net461.exe' || name === 'winsw.net461.exe')
      ?? findAsset((name) => name === 'winsw-net4.exe' || name === 'winsw.net4.exe');
  }

  if (arch === 'x64') {
    return findAsset((name) => name === 'winsw-x64.exe')
      ?? findAsset((name) => name === 'winsw-net461.exe' || name === 'winsw.net461.exe');
  }

  if (arch === 'arm64') {
    return findAsset((name) => name === 'winsw-arm64.exe' || name === 'winsw-aarch64.exe')
      ?? findAsset((name) => name === 'winsw-x64.exe')
      ?? findAsset((name) => name === 'winsw-net461.exe' || name === 'winsw.net461.exe');
  }

  if (arch === 'ia32') {
    return findAsset((name) => name === 'winsw-x86.exe')
      ?? findAsset((name) => name === 'winsw-net461.exe' || name === 'winsw.net461.exe');
  }

  return findAsset((name) => name.endsWith('.exe') && name.startsWith('winsw-'))
    ?? findAsset((name) => name.endsWith('.exe') && name.startsWith('winsw.'));
}

export function detectWinsw({
  home = homedir(),
  execFileSyncImpl = execFileSync,
  existsSyncImpl = existsSync,
  filesystemPathImpl = winswFilesystemPath,
  wsl = isWsl(),
} = {}) {
  const path = winswBinPath({ home });
  const filesystemPath = filesystemPathImpl(path, { wsl });
  if (!existsSyncImpl(filesystemPath)) {
    return { installed: false, version: null, path: null, ...getWinswVersionStatus('') };
  }
  try {
    const version = execFileSyncImpl(filesystemPath, ['--version'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim().split('\n')[0].trim();
    return { installed: true, version, path, filesystemPath, ...getWinswVersionStatus(version) };
  } catch {
    return { installed: false, version: null, path: null, ...getWinswVersionStatus('') };
  }
}

export async function downloadWinsw({
  home = homedir(),
  version = WINSW_PINNED_VERSION,
  arch = process.arch,
  preferNetFx = false,
  fetchImpl = globalThis.fetch,
  mkdirSyncImpl = mkdirSync,
  writeFileSyncImpl = writeFileSync,
  chmodSyncImpl = chmodSync,
  filesystemPathImpl = winswFilesystemPath,
  wsl = isWsl(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable — cannot download WinSW');
  const releaseRes = await fetchImpl(winswReleaseApiUrl(version), {
    headers: {
      'User-Agent': 'myelin',
      'Accept': 'application/vnd.github+json',
    },
  });
  if (!releaseRes.ok) {
    throw new Error(`WinSW release lookup failed: ${releaseRes.status} ${releaseRes.statusText}`);
  }

  const release = await releaseRes.json();
  const asset = selectWinswAsset(release, { arch, preferNetFx });
  if (!asset?.browser_download_url) {
    throw new Error(`No WinSW asset found for arch=${arch} in ${version}`);
  }

  const assetRes = await fetchImpl(asset.browser_download_url, {
    headers: {
      'User-Agent': 'myelin',
      'Accept': 'application/octet-stream',
    },
    redirect: 'follow',
  });
  if (!assetRes.ok) {
    throw new Error(`WinSW asset download failed: ${assetRes.status} ${assetRes.statusText}`);
  }

  const target = winswBinPath({ home });
  const filesystemTarget = filesystemPathImpl(target, { wsl });
  const filesystemDir = filesystemPathImpl(pathWin32.dirname(target), { wsl });
  mkdirSyncImpl(filesystemDir, { recursive: true });
  writeFileSyncImpl(filesystemTarget, Buffer.from(await assetRes.arrayBuffer()));
  try { chmodSyncImpl(filesystemTarget, 0o755); } catch {}

  return {
    ok: true,
    path: target,
    filesystemPath: filesystemTarget,
    version: normalizePinnedVersion(version),
    assetName: asset.name,
    downloaded: true,
  };
}

export async function installWinsw(opts = {}) {
  const detected = detectWinsw(opts);
  if (detected.installed && detected.pinnedVersionMatches) {
    return { ...detected, ok: true, alreadyPresent: true };
  }

  const downloaded = await downloadWinsw(opts);
  const verified = detectWinsw(opts);
  if (!verified.installed) throw new Error('WinSW download completed but verification failed');
  return { ...verified, ...downloaded, ok: true, alreadyPresent: false };
}
