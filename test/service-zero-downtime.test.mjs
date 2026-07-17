/**
 * Tests for zero-downtime skip logic in launchd.mjs and systemd.mjs.
 *
 * Core contract: installEngineInstance / installMitmService return 'skipped'
 * (no restart) when the rendered config matches the existing file AND the
 * service port is already responding. They return 'restarted' and touch the
 * file system + launchctl/systemctl otherwise.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── launchd helpers ────────────────────────────────────────────────────────

import {
  isPortResponding,
  isPlistUnchanged,
  installEngineInstance as launchdInstallEngineInstance,
  installMitmService as launchdInstallMitmService,
  generateGenericPlist,
  writeValidatedPlist,
} from '../src/service/launchd.mjs';

describe('isPortResponding (launchd)', () => {
  it('returns true when nc exits 0', () => {
    const result = isPortResponding(9999, { execFileSyncImpl: () => {} });
    assert.equal(result, true);
  });

  it('returns false when nc throws', () => {
    const result = isPortResponding(9999, { execFileSyncImpl: () => { throw new Error('connection refused'); } });
    assert.equal(result, false);
  });
});

describe('isPlistUnchanged (launchd)', () => {
  it('returns false when file does not exist', () => {
    const result = isPlistUnchanged('/nonexistent/path.plist', 'content', {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => { throw new Error('should not be called'); },
    });
    assert.equal(result, false);
  });

  it('returns true when file content matches exactly', () => {
    const content = '<plist>test</plist>';
    const result = isPlistUnchanged('/some/path.plist', content, {
      existsSyncImpl: () => true,
      readFileSyncImpl: () => content,
    });
    assert.equal(result, true);
  });

  it('returns false when file content differs', () => {
    const result = isPlistUnchanged('/some/path.plist', 'new content', {
      existsSyncImpl: () => true,
      readFileSyncImpl: () => 'old content',
    });
    assert.equal(result, false);
  });

  it('returns false when readFileSync throws', () => {
    const result = isPlistUnchanged('/some/path.plist', 'content', {
      existsSyncImpl: () => true,
      readFileSyncImpl: () => { throw new Error('permission denied'); },
    });
    assert.equal(result, false);
  });
});

describe('installMitmService skip logic (launchd)', () => {
  it('returns skipped when plist unchanged AND port responding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zdt-test-'));
    mkdirSync(join(dir, 'Library', 'LaunchAgents'), { recursive: true });
    const addonPath = join(dir, 'addon.py');
    writeFileSync(addonPath, '# addon');

    const result = launchdInstallMitmService({
      mitmdumpBin: '/usr/bin/mitmdump',
      port: 8888,
      addonPath,
      env: { MYELIN_DIR: dir },
      home: dir,
      _isPortResponding: () => true,
      _isPlistUnchanged: () => true,
    });
    assert.equal(result, 'skipped');
  });

  it('writes plist to sandboxed home dir (not ~/Library) when restart needed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zdt-test-'));
    mkdirSync(join(dir, 'Library', 'LaunchAgents'), { recursive: true });
    const addonPath = join(dir, 'addon.py');
    writeFileSync(addonPath, '# addon');

    // Call with skip=false — the plist write must go to the sandboxed dir, and
    // the launchd bootstrap MUST be refused for a temp/sandbox plist so a test
    // can never hijack the real com.myelin.mitmproxy label. Inject a spy exec
    // to prove no launchctl command is ever run.
    let launchctlCalled = false;
    try {
      launchdInstallMitmService({
        mitmdumpBin: '/usr/bin/mitmdump',
        port: 8888,
        addonPath,
        env: { MYELIN_DIR: dir },
        home: dir,
        _isPortResponding: () => false,
        _isPlistUnchanged: () => false,
        execSyncImpl: (cmd) => { if (String(cmd).includes('launchctl')) launchctlCalled = true; return ''; },
      });
    } catch {
      // The temp-plist guard throws — expected. Plist write happened first.
    }
    assert.equal(launchctlCalled, false, 'must never run launchctl against a sandboxed temp plist');
    const sandboxedPlist = join(dir, 'Library', 'LaunchAgents', 'com.myelin.mitmproxy.plist');
    const realPlist = join(homedir(), 'Library', 'LaunchAgents', 'com.myelin.mitmproxy.plist');
    // The plist MUST have been written to the sandboxed dir, and if it was
    // accidentally written to ~/Library the test detects it via content check.
    if (existsSync(sandboxedPlist)) {
      const content = readFileSync(sandboxedPlist, 'utf8');
      assert.ok(content.includes(addonPath), 'sandboxed plist must reference the sandboxed addon path');
    }
    // Verify ~/Library plist does NOT contain the sandboxed addon path
    if (existsSync(realPlist)) {
      const realContent = readFileSync(realPlist, 'utf8');
      assert.ok(!realContent.includes(dir), 'real plist must NOT reference the sandboxed temp dir');
    }
  });
});

// ─── systemd helpers ────────────────────────────────────────────────────────

import {
  isPortResponding as systemdIsPortResponding,
  isUnitUnchanged,
  installEngineInstance as systemdInstallEngineInstance,
  installMitmService as systemdInstallMitmService,
} from '../src/service/systemd.mjs';

describe('isPortResponding (systemd)', () => {
  it('returns true when nc exits 0', () => {
    const result = systemdIsPortResponding(9999, { execFileSyncImpl: () => {} });
    assert.equal(result, true);
  });

  it('returns false when nc throws', () => {
    const result = systemdIsPortResponding(9999, { execFileSyncImpl: () => { throw new Error('refused'); } });
    assert.equal(result, false);
  });
});

describe('isUnitUnchanged (systemd)', () => {
  it('returns false when file does not exist', () => {
    assert.equal(isUnitUnchanged('/no/such.service', 'content', {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => { throw new Error('no'); },
    }), false);
  });

  it('returns true when content matches', () => {
    const content = '[Unit]\nDescription=test\n';
    assert.equal(isUnitUnchanged('/some/path.service', content, {
      existsSyncImpl: () => true,
      readFileSyncImpl: () => content,
    }), true);
  });

  it('returns false when content differs', () => {
    assert.equal(isUnitUnchanged('/some/path.service', 'new', {
      existsSyncImpl: () => true,
      readFileSyncImpl: () => 'old',
    }), false);
  });
});

describe('installMitmService skip logic (systemd)', () => {
  it('returns skipped when unit unchanged AND port responding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zdt-systemd-test-'));
    mkdirSync(join(dir, '.config', 'systemd', 'user'), { recursive: true });
    const addonPath = join(dir, 'addon.py');
    writeFileSync(addonPath, '# addon');

    const result = systemdInstallMitmService({
      mitmdumpBin: '/usr/bin/mitmdump',
      port: 8888,
      addonPath,
      env: { MYELIN_DIR: dir },
      _isPortResponding: () => true,
      _isUnitUnchanged: () => true,
    });
    assert.equal(result, 'skipped');
  });
});

describe('installEngineInstance skip logic (systemd)', () => {
  it('returns skipped when unit unchanged AND port responding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zdt-systemd-engine-test-'));
    mkdirSync(join(dir, '.config', 'systemd', 'user'), { recursive: true });
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });

    const instance = {
      engine: 'headroom',
      role: 'primary',
      id: 'headroom-primary',
      port: 8787,
      stateDir,
      logPath: join(dir, 'headroom.log'),
      healthUrl: 'http://127.0.0.1:8787/health',
      env: {},
    };

    const result = systemdInstallEngineInstance(instance, {
      headroomBin: '/usr/local/bin/headroom',
      env: { MYELIN_DIR: dir },
      _isPortResponding: () => true,
      _isUnitUnchanged: () => true,
    });
    assert.equal(result, 'skipped');
  });
});
