import { existsSync, readFileSync, statSync } from 'node:fs';
import { release as osRelease } from 'node:os';

function isInsideContainer({ statSyncImpl = statSync } = {}) {
  try {
    statSyncImpl('/run/.containerenv');
    return true;
  } catch {}
  try {
    statSyncImpl('/.dockerenv');
    return true;
  } catch {}
  return false;
}

export function isWsl({
  platform = process.platform,
  release = osRelease,
  readFileSyncImpl = readFileSync,
  existsSyncImpl = existsSync,
  statSyncImpl = statSync,
} = {}) {
  if (platform !== 'linux') return false;
  if (release().toLowerCase().includes('microsoft')) {
    return !isInsideContainer({ statSyncImpl });
  }
  try {
    if (readFileSyncImpl('/proc/version', 'utf8').toLowerCase().includes('microsoft')) {
      return !isInsideContainer({ statSyncImpl });
    }
  } catch {}
  if (existsSyncImpl('/proc/sys/fs/binfmt_misc/WSLInterop') || existsSyncImpl('/run/WSL')) {
    return !isInsideContainer({ statSyncImpl });
  }
  return false;
}
