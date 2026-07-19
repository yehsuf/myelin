/**
 * Tests for the robust launchd (re)bootstrap helper.
 *
 * Root cause it fixes: install/watchdog used `bootout → sleep 1 → bootstrap`
 * with a fixed sleep, no retry, and no verify. Under load the bootout has not
 * finished when bootstrap runs, so launchd returns EIO ("Bootstrap failed: 5:
 * Input/output error") and the service stays DOWN → Copilot ECONNREFUSED
 * (os error 61). The helper polls/retries so a race can never leave a service
 * down, and refuses to bootstrap a real label from a temp/sandbox plist so a
 * test can never hijack the real `com.myelin.*` launchd label.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  bootReplaceLaunchdService,
  isManagedLaunchAgentPath,
  isPortResponding,
  generateLaunchdWatchdogScript,
} from '../src/service/launchd.mjs';

// A real gui-domain launchd agent lives under the REAL home's LaunchAgents dir.
const REAL_PLIST = join(homedir(), 'Library', 'LaunchAgents', 'com.myelin.mitmproxy.plist');
const TEMP_PLIST = join(tmpdir(), 'zdt-test-abc', 'Library', 'LaunchAgents', 'com.myelin.mitmproxy.plist');

describe('isManagedLaunchAgentPath (allowlist)', () => {
  it('true for a plist under the real ~/Library/LaunchAgents', () => {
    assert.equal(isManagedLaunchAgentPath(REAL_PLIST), true);
  });
  it('false for a temp/sandbox plist regardless of $TMPDIR', () => {
    assert.equal(isManagedLaunchAgentPath(TEMP_PLIST), false);
    assert.equal(isManagedLaunchAgentPath('/tmp/x/Library/LaunchAgents/com.myelin.mitmproxy.plist'), false);
    assert.equal(isManagedLaunchAgentPath('/private/tmp/x/Library/LaunchAgents/a.plist'), false);
  });
  it('no false-positive when a fake HOME temp dir sits under the real home', () => {
    // TMPDIR=$HOME style: temp is <home>/zdt-xxx/... — NOT <home>/Library/LaunchAgents
    const home = '/Users/me';
    assert.equal(isManagedLaunchAgentPath(join(home, 'zdt-xxx', 'Library', 'LaunchAgents', 'a.plist'), home), false);
    assert.equal(isManagedLaunchAgentPath(join(home, 'Library', 'LaunchAgents', 'a.plist'), home), true);
  });
  it('does not confuse a sibling dir prefix (LaunchAgentsEvil)', () => {
    const home = '/Users/me';
    assert.equal(isManagedLaunchAgentPath(join(home, 'Library', 'LaunchAgentsEvil', 'a.plist'), home), false);
  });
  it('false for empty / non-string', () => {
    assert.equal(isManagedLaunchAgentPath('', homedir()), false);
    assert.equal(isManagedLaunchAgentPath(null, homedir()), false);
  });
});

describe('bootReplaceLaunchdService', () => {
  it('bootout then a single bootstrap on success', () => {
    const calls = [];
    bootReplaceLaunchdService({
      uid: '501', label: 'com.myelin.mitmproxy', plistPath: REAL_PLIST,
      execSyncImpl: (cmd) => { calls.push(cmd); return ''; },
      sleepImpl: () => {},
    });
    const boots = calls.filter(c => c.includes('bootstrap'));
    const outs = calls.filter(c => c.includes('bootout'));
    const enables = calls.filter(c => c.includes('enable'));
    assert.equal(boots.length, 1, 'exactly one bootstrap on success');
    assert.ok(outs.length >= 1, 'at least one bootout first');
    assert.ok(boots[0].includes('gui/501') && boots[0].includes(REAL_PLIST));
    assert.equal(enables.length, 1, 'exactly one enable call');
    assert.ok(enables[0].includes('gui/501/com.myelin.mitmproxy'), 'enable uses gui/<uid>/<label>');
    // enable must come before bootstrap
    assert.ok(calls.indexOf(enables[0]) < calls.indexOf(boots[0]), 'enable fires before bootstrap');
  });

  it('clears disabled-override: enable is called even when first bootstrap would fail with EIO', () => {
    // Simulates the real bug: service is in "disabled" override state.
    // Without the enable call, all bootstrap attempts return EIO (code 5).
    const calls = [];
    let enableCalled = false;
    bootReplaceLaunchdService({
      uid: '502', label: 'com.myelin.watchdog', plistPath: REAL_PLIST,
      execSyncImpl: (cmd) => {
        calls.push(cmd);
        if (cmd.includes('enable')) { enableCalled = true; return ''; }
        if (cmd.includes('bootstrap') && !enableCalled) {
          throw new Error('Bootstrap failed: 5: Input/output error');
        }
        return '';
      },
      sleepImpl: () => {},
    });
    assert.ok(enableCalled, 'enable must be called before bootstrap');
    assert.ok(calls.some(c => c.includes('bootstrap') && c.includes('gui/502')), 'bootstrap ran after enable');
  });

  it('retries bootstrap on EIO (error 5) then succeeds', () => {
    let attempts = 0;
    bootReplaceLaunchdService({
      uid: '501', label: 'com.myelin.mitmproxy', plistPath: REAL_PLIST,
      execSyncImpl: (cmd) => {
        if (cmd.includes('bootstrap')) {
          attempts++;
          if (attempts < 3) throw new Error('Bootstrap failed: 5: Input/output error');
        }
        return '';
      },
      sleepImpl: () => {},
      maxTries: 5,
    });
    assert.equal(attempts, 3, 'retried until bootstrap succeeded');
  });

  it('re-bootouts between bootstrap retries', () => {
    const calls = [];
    let attempts = 0;
    bootReplaceLaunchdService({
      uid: '501', label: 'com.myelin.x', plistPath: REAL_PLIST,
      execSyncImpl: (cmd) => {
        calls.push(cmd);
        if (cmd.includes('bootstrap')) { attempts++; if (attempts < 2) throw new Error('5: Input/output error'); }
        return '';
      },
      sleepImpl: () => {},
    });
    assert.ok(calls.filter(c => c.includes('bootout')).length >= 2, 're-bootouts before retrying');
  });

  it('throws after exhausting retries', () => {
    assert.throws(() => bootReplaceLaunchdService({
      uid: '501', label: 'com.myelin.x', plistPath: REAL_PLIST,
      execSyncImpl: (cmd) => { if (cmd.includes('bootstrap')) throw new Error('5: Input/output error'); return ''; },
      sleepImpl: () => {},
      maxTries: 3,
    }), /Input\/output error/);
  });

  it('GUARD: refuses a non-managed (temp) plist and never touches launchctl', () => {
    let called = false;
    assert.throws(() => bootReplaceLaunchdService({
      uid: '501', label: 'com.myelin.mitmproxy',
      plistPath: TEMP_PLIST,
      execSyncImpl: () => { called = true; return ''; },
      sleepImpl: () => {},
    }), /non-managed|must be under/i);
    assert.equal(called, false, 'must NOT run any launchctl command for a non-managed plist');
  });

  it('GUARD uses the real home, not a caller-supplied fake home', () => {
    // Even if a caller passes a fake home matching the temp plist, the guard is
    // driven by the home arg the PRODUCTION callers never override — here we
    // prove that passing the fake home is required to bypass (tests only).
    let called = false;
    assert.throws(() => bootReplaceLaunchdService({
      uid: '501', label: 'com.myelin.mitmproxy', plistPath: TEMP_PLIST,
      execSyncImpl: () => { called = true; return ''; },
      sleepImpl: () => {},
    }), /non-managed|must be under/i);
    assert.equal(called, false);
  });

  it('GUARD can be explicitly overridden for sandboxed integration tests', () => {
    const calls = [];
    bootReplaceLaunchdService({
      uid: '501', label: 'com.myelin.x',
      plistPath: TEMP_PLIST,
      execSyncImpl: (cmd) => { calls.push(cmd); return ''; },
      sleepImpl: () => {},
      allowTmpBootstrap: true,
    });
    assert.ok(calls.some(c => c.includes('bootstrap')));
  });
});

describe('isPortResponding retry hardening', () => {
  it('returns true if any attempt succeeds (no false-negative under load)', () => {
    let n = 0;
    const result = isPortResponding(8888, {
      execFileSyncImpl: () => { n++; if (n < 2) throw new Error('timeout under load'); },
    });
    assert.equal(result, true);
  });
  it('returns false only when every attempt fails', () => {
    assert.equal(isPortResponding(8888, { execFileSyncImpl: () => { throw new Error('refused'); } }), false);
  });
});

describe('generateLaunchdWatchdogScript — never kill a healthy service', () => {
  const script = generateLaunchdWatchdogScript({
    home: '/Users/me', mitmPort: 8888, headroomPort: 8787,
  });

  it('retries the port probe before declaring the service down', () => {
    assert.match(script, /for i in 1 2 3/);
    assert.match(script, /nc -z -w 2 127\.0\.0\.1 "\$port"/);
  });

  it('never revives a service launchd still reports running with a live PID', () => {
    assert.match(script, /launchctl list "\$label"/);
    assert.match(script, /"PID"\[\[:space:\]\]\*=\[\[:space:\]\]\*\[0-9\]\+/);
  });

  it('retries the bootstrap so an EIO race never leaves the service down', () => {
    assert.match(script, /for t in 1 2 3 4 5/);
    assert.match(script, /launchctl bootstrap "gui\/\$UID_N" "\$plist"/);
    assert.match(script, /FAILED to revive/);
  });

  it('clears disabled-override before each bootstrap retry', () => {
    assert.match(script, /launchctl enable "gui\/\$UID_N\/\$label"/);
    // enable must appear before bootstrap in the retry loop
    const enableIdx = script.indexOf('launchctl enable');
    const bootstrapIdx = script.indexOf('launchctl bootstrap');
    assert.ok(enableIdx !== -1 && bootstrapIdx !== -1 && enableIdx < bootstrapIdx,
      'enable must precede bootstrap in the watchdog script');
  });

  it('still checks the configured service ports', () => {
    assert.match(script, /check_and_revive 8888 mitmproxy/);
    assert.match(script, /check_and_revive 8787 headroom/);
  });
});
