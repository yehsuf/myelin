import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { generatePlist, generateGenericPlist } from '../src/service/launchd.mjs';
import {
  generateSystemdUnit,
  generateCopilotHeadroomUnit,
  generateMitmUnit,
} from '../src/service/systemd.mjs';
import {
  generateHeadroomRunScript,
  generateCopilotHeadroomRunScript,
  generateMitmRunScript,
} from '../src/service/windows.mjs';
import { SERVER_FORBIDDEN_ENV } from '../src/service/wrappers.mjs';

// -----------------------------------------------------------------------------
// Each long-running service must UNSET client-side provider env vars in its
// startup context, regardless of what the parent shell/launchctl/service
// manager carried in. Otherwise a stray ANTHROPIC_BASE_URL from the user's
// shell can silently misroute the service on next restart.
// -----------------------------------------------------------------------------

describe('launchd (macOS) — server-side env isolation', () => {
  it('generatePlist wraps the command through `/bin/sh -c \\\'unset ...; exec\\\'`', () => {
    const plist = generatePlist({
      headroomBin: '/usr/local/bin/headroom',
      port: 8787,
      envVars: { HEADROOM_MODE: 'cache' },
    });
    // The ProgramArguments should now include /bin/sh -c wrapper
    assert.match(plist, /<string>\/bin\/sh<\/string>/);
    assert.match(plist, /<string>-c<\/string>/);
    // The wrapper must contain `unset` for every forbidden var
    for (const v of SERVER_FORBIDDEN_ENV) {
      assert.ok(plist.includes(v),
        `generatePlist must reference '${v}' in its unset prefix so the daemon never inherits it.`);
    }
    assert.match(plist, /unset\s+ANTHROPIC_BASE_URL/);
    // The final exec must call the intended binary
    assert.match(plist, /exec\s+'\/usr\/local\/bin\/headroom'/);
  });

  it('generateGenericPlist (used for copilot-headroom + mitmproxy on macOS) also sh-wraps + unsets', () => {
    const plist = generateGenericPlist({
      label: 'com.myelin.copilot-headroom',
      command: '/usr/local/bin/headroom',
      args: ['proxy', '--port', '8788'],
      envVars: { ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889' },
    });
    assert.match(plist, /<string>\/bin\/sh<\/string>/);
    assert.match(plist, /unset\s+ANTHROPIC_BASE_URL/);
    // Still passes the relevant local loopback target through EnvironmentVariables
    assert.ok(plist.includes('ANTHROPIC_TARGET_API_URL'));
    assert.ok(plist.includes('http://127.0.0.1:8889'));
  });
});

describe('systemd (Linux) — server-side env isolation', () => {
  it('generateSystemdUnit emits UnsetEnvironment= directives for forbidden vars', () => {
    const unit = generateSystemdUnit({
      headroomBin: '/usr/local/bin/headroom',
      port: 8787,
      envVars: { HEADROOM_MODE: 'cache' },
    });
    for (const v of SERVER_FORBIDDEN_ENV) {
      assert.ok(unit.includes(`UnsetEnvironment=${v}`),
        `Systemd unit must emit 'UnsetEnvironment=${v}'`);
    }
    assert.ok(unit.includes('Environment=HEADROOM_MODE=cache'),
      'Relevant env vars must still be passed via Environment=');
  });

  it('generateCopilotHeadroomUnit emits UnsetEnvironment= directives + keeps target URLs', () => {
    const unit = generateCopilotHeadroomUnit({
      headroomBin: '/usr/local/bin/headroom',
      port: 8788,
      mode: 'cache',
      workingDirectory: '/home/user/.myelin/copilot-headroom',
      envVars: { ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889' },
    });
    assert.ok(unit.includes('UnsetEnvironment=ANTHROPIC_BASE_URL'));
    assert.ok(unit.includes('UnsetEnvironment=ENABLE_PROMPT_CACHING_1H'));
    assert.ok(unit.includes('Environment=ANTHROPIC_TARGET_API_URL=http://127.0.0.1:8889'));
  });

  it('generateMitmUnit emits UnsetEnvironment= directives', () => {
    const unit = generateMitmUnit({
      mitmdumpBin: '/usr/local/bin/mitmdump',
      port: 8888,
      addonPath: '/opt/myelin/copilot_addon.py',
      envVars: {},
    });
    for (const v of SERVER_FORBIDDEN_ENV) {
      assert.ok(unit.includes(`UnsetEnvironment=${v}`),
        `Mitm unit must emit 'UnsetEnvironment=${v}'`);
    }
  });
});

describe('Windows registry service scripts — server-side env isolation', () => {
  it('generateHeadroomRunScript clears forbidden env before Start-Process', () => {
    const script = generateHeadroomRunScript({
      headroomBin: 'C:\\Users\\test\\.myelin\\bin\\headroom.exe',
      port: 8787,
      envVars: { HEADROOM_MODE: 'cache' },
    });
    for (const v of SERVER_FORBIDDEN_ENV) {
      assert.ok(script.includes(`SetEnvironmentVariable('${v}', $null, 'Process')`),
        `Windows headroom run-script must clear '${v}' before Start-Process`);
    }
    // Relevant env still set
    assert.ok(script.includes('HEADROOM_MODE'));
  });

  it('generateCopilotHeadroomRunScript clears forbidden env + keeps target URLs', () => {
    const script = generateCopilotHeadroomRunScript({
      headroomBin: 'C:\\Users\\test\\.myelin\\bin\\headroom.exe',
      port: 8788,
      mode: 'cache',
      workingDirectory: 'C:\\Users\\test\\.myelin\\copilot-headroom',
      envVars: { ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889' },
    });
    assert.ok(script.includes(`SetEnvironmentVariable('ANTHROPIC_BASE_URL', $null, 'Process')`));
    assert.ok(script.includes(`SetEnvironmentVariable('ENABLE_PROMPT_CACHING_1H', $null, 'Process')`));
    // Loopback target for headroom's own routing is still passed through
    assert.ok(script.includes('ANTHROPIC_TARGET_API_URL'));
    assert.ok(script.includes('127.0.0.1:8889'));
  });

  it('generateMitmRunScript clears forbidden env before Start-Process', () => {
    const script = generateMitmRunScript({
      mitmdumpBin: 'C:\\Users\\test\\.myelin\\bin\\mitmdump.exe',
      port: 8888,
      addonPath: 'C:\\opt\\myelin\\copilot_addon.py',
      envVars: {},
    });
    for (const v of SERVER_FORBIDDEN_ENV) {
      assert.ok(script.includes(`SetEnvironmentVariable('${v}', $null, 'Process')`),
        `Windows mitmproxy run-script must clear '${v}'`);
    }
  });
});

// -----------------------------------------------------------------------------
// Round-trip: relevant env vars pass through, forbidden vars are always cleared.
// -----------------------------------------------------------------------------

describe('service-side isolation — passes relevants, unsets forbidden', () => {
  const relevantVars = {
    HEADROOM_MODE: 'cache',
    HEADROOM_INTERCEPT_ENABLED: '1',
    ANTHROPIC_TARGET_API_URL: 'https://api.githubcopilot.com',
    OPENAI_TARGET_API_URL: 'https://api.githubcopilot.com',
    SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
  };

  it('systemd — every relevant var appears; every forbidden var is unset', () => {
    const unit = generateSystemdUnit({
      headroomBin: '/usr/local/bin/headroom',
      port: 8787,
      envVars: relevantVars,
    });
    for (const [k, v] of Object.entries(relevantVars)) {
      assert.ok(unit.includes(`Environment=${k}=${v}`), `Missing Environment=${k}`);
    }
    for (const forbidden of SERVER_FORBIDDEN_ENV) {
      assert.ok(unit.includes(`UnsetEnvironment=${forbidden}`),
        `Missing UnsetEnvironment=${forbidden}`);
    }
  });

  it('windows — every relevant var appears; every forbidden var is unset first', () => {
    const script = generateHeadroomRunScript({
      headroomBin: 'C:\\bin\\headroom.exe',
      port: 8787,
      envVars: relevantVars,
    });
    for (const [k] of Object.entries(relevantVars)) {
      assert.ok(script.includes(`$env:${k}`), `Missing $env:${k} assignment`);
    }
    for (const forbidden of SERVER_FORBIDDEN_ENV) {
      const unsetIdx = script.indexOf(`SetEnvironmentVariable('${forbidden}', $null, 'Process')`);
      const setIdx = script.indexOf(`$env:${Object.keys(relevantVars)[0]}`);
      assert.ok(unsetIdx >= 0, `Missing unset for '${forbidden}'`);
      // Ordering matters: unset before set. (Even though on Windows the
      // relevant env is passed via $env:X = ... after the unset block.)
      if (setIdx >= 0) {
        assert.ok(unsetIdx < setIdx,
          `'${forbidden}' unset must come before relevant env sets`);
      }
    }
  });
});
