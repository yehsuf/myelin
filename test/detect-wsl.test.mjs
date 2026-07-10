import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectOS } from '../src/detect/os.mjs';
import { isWsl } from '../src/detect/wsl.mjs';
import { printVerifyEnvironmentNote } from '../src/cli/verify.mjs';

function missing() {
  throw new Error('missing');
}

function captureLogs() {
  const logs = [];
  return {
    logs,
    log: (message = '') => logs.push(message),
  };
}

describe('isWsl', () => {
  it('returns false on non-linux platforms', () => {
    assert.equal(isWsl({ platform: 'darwin' }), false);
    assert.equal(isWsl({ platform: 'win32' }), false);
  });

  it('returns true when os.release reports microsoft on WSL1 and WSL2', () => {
    assert.equal(isWsl({
      platform: 'linux',
      release: () => '4.4.0-19041-Microsoft',
      statSyncImpl: missing,
    }), true);
    assert.equal(isWsl({
      platform: 'linux',
      release: () => '5.15.167.4-microsoft-standard-WSL2',
      statSyncImpl: missing,
    }), true);
  });

  it('returns false when microsoft is present but a container marker exists', () => {
    assert.equal(isWsl({
      platform: 'linux',
      release: () => '5.15.167.4-microsoft-standard-WSL2',
      statSyncImpl: (path) => {
        if (path === '/.dockerenv') return {};
        throw new Error('missing');
      },
    }), false);
    assert.equal(isWsl({
      platform: 'linux',
      release: () => '5.15.167.4-microsoft-standard-WSL2',
      statSyncImpl: (path) => {
        if (path === '/run/.containerenv') return {};
        throw new Error('missing');
      },
    }), false);
  });

  it('falls back to /proc/version when os.release does not include the marker', () => {
    assert.equal(isWsl({
      platform: 'linux',
      release: () => '5.15.0-generic',
      readFileSyncImpl: () => 'Linux version 5.15.167.4-microsoft-standard-WSL2',
      statSyncImpl: missing,
    }), true);
  });

  it('falls back to WSLInterop markers when release and /proc/version do not include the marker', () => {
    assert.equal(isWsl({
      platform: 'linux',
      release: () => '5.15.0-generic',
      readFileSyncImpl: () => 'Linux version 5.15.0-generic',
      existsSyncImpl: (path) => path === '/proc/sys/fs/binfmt_misc/WSLInterop',
      statSyncImpl: missing,
    }), true);
    assert.equal(isWsl({
      platform: 'linux',
      release: () => '5.15.0-generic',
      readFileSyncImpl: () => 'Linux version 5.15.0-generic',
      existsSyncImpl: (path) => path === '/run/WSL',
      statSyncImpl: missing,
    }), true);
  });
});

describe('detectOS', () => {
  it('routes WSL linux sessions to windows in the non-detailed response', () => {
    assert.equal(detectOS(false, {
      platformImpl: () => 'linux',
      isWslImpl: () => true,
    }), 'windows');
    assert.equal(detectOS(false, {
      platformImpl: () => 'linux',
      isWslImpl: () => false,
    }), 'linux');
  });

  it('keeps darwin and win32 unchanged', () => {
    assert.equal(detectOS(false, { platformImpl: () => 'darwin' }), 'darwin');
    assert.equal(detectOS(false, { platformImpl: () => 'win32' }), 'windows');
  });

  it('includes a wsl field in the detailed response', () => {
    assert.deepEqual(detectOS(true, {
      platformImpl: () => 'linux',
      archImpl: () => 'x64',
      isWslImpl: () => true,
    }), {
      os: 'windows',
      arch: 'x64',
      platform: 'linux',
      wsl: true,
    });
    assert.deepEqual(detectOS(true, {
      platformImpl: () => 'linux',
      archImpl: () => 'arm64',
      isWslImpl: () => false,
    }), {
      os: 'linux',
      arch: 'arm64',
      platform: 'linux',
      wsl: false,
    });
  });
});

describe('printVerifyEnvironmentNote', () => {
  it('prints the WSL diagnostic note only when WSL is detected', () => {
    const wslCapture = captureLogs();
    printVerifyEnvironmentNote({
      detectOSImpl: () => ({ wsl: true }),
      log: wslCapture.log,
    });
    assert.deepEqual(wslCapture.logs, [
      'ℹ Detected: running inside WSL — bridging to Windows service management via PowerShell interop.',
    ]);

    const nativeCapture = captureLogs();
    printVerifyEnvironmentNote({
      detectOSImpl: () => ({ wsl: false }),
      log: nativeCapture.log,
    });
    assert.deepEqual(nativeCapture.logs, []);
  });
});
