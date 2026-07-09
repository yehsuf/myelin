import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePlist, generateGenericPlist } from '../src/service/launchd.mjs';
import { generateSystemdUnit, generateCopilotHeadroomUnit, generateMitmUnit } from '../src/service/systemd.mjs';
import { generateHeadroomRunScript, generateSetUserEnvVarsScript, generateCopilotHeadroomRunScript, generateMitmRunScript, collapseRedundantBackslashes } from '../src/service/windows.mjs';
import { resolveGlobalBinDir, linkGlobalBin } from '../src/service/npmlink.mjs';

const OPTS = {
  headroomBin: '/home/user/.local/bin/headroom',
  port: 8787,
  envVars: { ANTHROPIC_API_KEY: 'sk-test', HEADROOM_PORT: '8787' },
  logPath: '/tmp/headroom.log',
  user: 'testuser',
};

describe('launchd plist generator', () => {
  it('contains the label', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('com.myelin.headroom'));
  });
  it('contains the binary path', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes(OPTS.headroomBin));
  });
  it('contains the port argument', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('8787'));
  });
  it('contains KeepAlive key', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('<key>KeepAlive</key>'));
  });
  it('contains env var', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('HEADROOM_PORT'));
  });
  it('omits --intercept-tool-results by default', () => {
    const xml = generatePlist(OPTS);
    assert.ok(!xml.includes('--intercept-tool-results'));
  });
  it('adds --intercept-tool-results when requested', () => {
    const xml = generatePlist({ ...OPTS, interceptToolResults: true });
    assert.ok(xml.includes('--intercept-tool-results'));
  });
});

describe('generateGenericPlist (mitmproxy / copilot-headroom launchd)', () => {
  const GENERIC_OPTS = {
    label: 'com.myelin.copilot-headroom',
    command: '/home/user/.venv/bin/headroom',
    args: ['proxy', '--port', '8788'],
    envVars: { ANTHROPIC_TARGET_API_URL: 'https://api.business.githubcopilot.com' },
    logPath: '/tmp/copilot-headroom.log',
  };
  it('omits WorkingDirectory key when not provided (backward compatible)', () => {
    const xml = generateGenericPlist(GENERIC_OPTS);
    assert.ok(!xml.includes('<key>WorkingDirectory</key>'));
  });
  it('adds WorkingDirectory key when provided (state isolation between instances)', () => {
    const xml = generateGenericPlist({ ...GENERIC_OPTS, workingDirectory: '/home/user/.myelin/copilot-headroom' });
    assert.ok(xml.includes('<key>WorkingDirectory</key>'));
    assert.ok(xml.includes('/home/user/.myelin/copilot-headroom'));
  });
  it('contains the label and args', () => {
    const xml = generateGenericPlist(GENERIC_OPTS);
    assert.ok(xml.includes('com.myelin.copilot-headroom'));
    assert.ok(xml.includes('--port'));
    assert.ok(xml.includes('8788'));
  });
});

describe('systemd unit generator', () => {
  it('contains ExecStart with binary', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('ExecStart=' + OPTS.headroomBin));
  });
  it('contains Restart=always', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('Restart=always'));
  });
  it('contains WantedBy=default.target', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('WantedBy=default.target'));
  });
  it('contains env var', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('HEADROOM_PORT'));
  });
  it('omits --intercept-tool-results by default', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(!unit.includes('--intercept-tool-results'));
  });
  it('adds --intercept-tool-results when requested', () => {
    const unit = generateSystemdUnit({ ...OPTS, interceptToolResults: true });
    assert.ok(unit.includes('--intercept-tool-results'));
  });
});

describe('systemd copilot-headroom unit generator', () => {
  const CH_OPTS = {
    headroomBin: OPTS.headroomBin,
    port: 8788,
    mode: 'cache',
    workingDirectory: '/home/user/.myelin/copilot-headroom',
    envVars: { ANTHROPIC_TARGET_API_URL: 'https://api.business.githubcopilot.com' },
  };
  it('contains WorkingDirectory pointing at the isolated state dir', () => {
    const unit = generateCopilotHeadroomUnit(CH_OPTS);
    assert.ok(unit.includes('WorkingDirectory=/home/user/.myelin/copilot-headroom'));
  });
  it('contains the port and mode in ExecStart', () => {
    const unit = generateCopilotHeadroomUnit(CH_OPTS);
    assert.ok(unit.includes('--port 8788'));
    assert.ok(unit.includes('--mode cache'));
  });
  it('has a distinct description from the Claude-Headroom unit', () => {
    const unit = generateCopilotHeadroomUnit(CH_OPTS);
    assert.ok(unit.includes('Copilot-Headroom'));
  });
});

describe('systemd mitm unit generator — egress dual-listener', () => {
  it('supports two --mode regular@PORT args for ingress + egress', () => {
    const args = ['--mode', 'regular@8888', '--mode', 'regular@8889', '-s', '/path/addon.py'];
    const unit = generateMitmUnit({ mitmdumpBin: '/usr/bin/mitmdump', args });
    assert.ok(unit.includes('regular@8888'));
    assert.ok(unit.includes('regular@8889'));
  });
});

describe('windows run-script generator', () => {
  it('contains registry run key name', () => {
    const script = generateHeadroomRunScript(OPTS);
    assert.ok(script.includes('MyelinHeadroom'));
  });
  it('contains command path', () => {
    const script = generateHeadroomRunScript(OPTS);
    assert.ok(script.includes(OPTS.headroomBin.replace(/\//g, '\\')));
  });
  it('contains port argument', () => {
    const script = generateHeadroomRunScript(OPTS);
    assert.ok(script.includes('8787'));
  });
  it('omits --intercept-tool-results by default', () => {
    const script = generateHeadroomRunScript(OPTS);
    assert.ok(!script.includes('--intercept-tool-results'));
  });
  it('adds --intercept-tool-results when requested', () => {
    const script = generateHeadroomRunScript({ ...OPTS, interceptToolResults: true });
    assert.ok(script.includes('--intercept-tool-results'));
  });
  it('stops only the process matching this exact port (not all headroom.exe instances)', () => {
    const script = generateHeadroomRunScript(OPTS);
    assert.ok(script.includes(`--port ${OPTS.port}`));
    assert.ok(script.includes('Win32_Process'));
    assert.ok(!script.includes('Stop-Process -Name headroom '));
  });
});

describe('windows copilot-headroom run-script generator', () => {
  const CH_OPTS = {
    headroomBin: OPTS.headroomBin,
    port: 8788,
    mode: 'cache',
    workingDirectory: 'C:\\Users\\yehsuf\\.myelin\\copilot-headroom',
    envVars: { ANTHROPIC_TARGET_API_URL: 'https://api.business.githubcopilot.com' },
  };
  it('contains a distinct registry run key name from the Claude-Headroom instance', () => {
    const script = generateCopilotHeadroomRunScript(CH_OPTS);
    assert.ok(script.includes('MyelinCopilotHeadroom'));
  });
  it('sets -WorkingDirectory for state isolation', () => {
    const script = generateCopilotHeadroomRunScript(CH_OPTS);
    assert.ok(script.includes('-WorkingDirectory'));
    assert.ok(script.includes('copilot-headroom'));
  });
  it('contains the port and mode', () => {
    const script = generateCopilotHeadroomRunScript(CH_OPTS);
    assert.ok(script.includes('--port 8788'));
    assert.ok(script.includes('--mode cache'));
  });
  it('stops only the process on this exact port', () => {
    const script = generateCopilotHeadroomRunScript(CH_OPTS);
    assert.ok(script.includes('Win32_Process'));
  });
});

describe('windows mitm run-script generator — egress dual-listener', () => {
  const MITM_OPTS = {
    mitmdumpBin: '/usr/bin/mitmdump',
    port: 8888,
    addonPath: '/path/addon.py',
    envVars: {},
  };
  it('uses --listen-port when no egressPort is given (backward compatible)', () => {
    const script = generateMitmRunScript(MITM_OPTS);
    assert.ok(script.includes('--listen-port 8888'));
    assert.ok(!script.includes('regular@'));
  });
  it('uses two --mode regular@PORT args when egressPort is given', () => {
    const script = generateMitmRunScript({ ...MITM_OPTS, egressPort: 8889 });
    assert.ok(script.includes('--mode regular@8888'));
    assert.ok(script.includes('--mode regular@8889'));
    assert.ok(!script.includes('--listen-port'));
  });
  it('sets MYELIN_EGRESS_PORT when egressPort is given', () => {
    const script = generateMitmRunScript({ ...MITM_OPTS, egressPort: 8889 });
    assert.ok(script.includes('MYELIN_EGRESS_PORT'));
  });

  // Regression test for a live bug: a real Windows path (e.g. a NetFree
  // corporate CA file) got persisted with every backslash doubled, and
  // because this script persists to the registry (User scope) and the
  // doubled value gets read back as input on the next `myelin restart`,
  // it silently compounded across runs - observed live as
  // C:\\\\\\\\ProgramData\\\\\\\\NetFree\\\\\\\\CA\\\\\\\\netfree-ca-list.crt
  // (8 backslashes per separator) after 3 restarts.
  it('does not double backslashes in a persisted env var value (regression)', () => {
    const script = generateMitmRunScript({
      ...MITM_OPTS,
      envVars: { NODE_EXTRA_CA_CERTS: 'C:\\Users\\yehsuf\\.myelin\\ca-bundle.pem' },
    });
    assert.ok(script.includes("SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'C:\\Users\\yehsuf\\.myelin\\ca-bundle.pem', 'User')"));
    assert.ok(!script.includes('C:\\\\Users'));
  });

  it('self-heals an already-doubled value instead of doubling it further', () => {
    const script = generateMitmRunScript({
      ...MITM_OPTS,
      envVars: { NODE_EXTRA_CA_CERTS: 'C:\\\\ProgramData\\\\NetFree\\\\CA\\\\netfree-ca-list.crt' },
    });
    assert.ok(script.includes("SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'C:\\ProgramData\\NetFree\\CA\\netfree-ca-list.crt', 'User')"));
  });

  it('self-heals a severely compounded value (the exact 8-backslash case observed live)', () => {
    const corrupted = 'C:' + '\\\\\\\\ProgramData' + '\\\\\\\\NetFree' + '\\\\\\\\CA' + '\\\\\\\\netfree-ca-list.crt';
    const script = generateMitmRunScript({ ...MITM_OPTS, envVars: { NODE_EXTRA_CA_CERTS: corrupted } });
    assert.ok(script.includes("SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'C:\\ProgramData\\NetFree\\CA\\netfree-ca-list.crt', 'User')"));
  });

  it('still escapes a literal single-quote in the value', () => {
    const script = generateMitmRunScript({ ...MITM_OPTS, envVars: { SOME_VAR: "it's a path" } });
    assert.ok(script.includes("SetEnvironmentVariable('SOME_VAR', 'it''s a path', 'User')"));
  });
});

describe('collapseRedundantBackslashes', () => {
  it('leaves a normal single-backslash Windows path untouched', () => {
    assert.equal(collapseRedundantBackslashes('C:\\Users\\yehsuf\\.myelin\\ca-bundle.pem'), 'C:\\Users\\yehsuf\\.myelin\\ca-bundle.pem');
  });

  it('collapses a doubled path down to single backslashes', () => {
    assert.equal(collapseRedundantBackslashes('C:\\\\ProgramData\\\\NetFree'), 'C:\\ProgramData\\NetFree');
  });

  it('collapses a quadrupled/octupled path down to single backslashes', () => {
    assert.equal(collapseRedundantBackslashes('C:\\\\\\\\ProgramData\\\\\\\\NetFree'), 'C:\\ProgramData\\NetFree');
  });

  it('preserves a genuine UNC path prefix (\\\\server\\share) instead of collapsing it to one backslash', () => {
    assert.equal(collapseRedundantBackslashes('\\\\server\\share\\file.pem'), '\\\\server\\share\\file.pem');
  });

  it('still collapses corruption elsewhere in a UNC path while preserving its prefix', () => {
    assert.equal(collapseRedundantBackslashes('\\\\server\\\\share\\\\file.pem'), '\\\\server\\share\\file.pem');
  });

  it('handles empty/null/undefined without throwing', () => {
    assert.equal(collapseRedundantBackslashes(''), '');
    assert.equal(collapseRedundantBackslashes(null), '');
    assert.equal(collapseRedundantBackslashes(undefined), '');
  });

  it('is idempotent - collapsing an already-clean value is a no-op', () => {
    const once = collapseRedundantBackslashes('C:\\\\\\\\Program');
    assert.equal(collapseRedundantBackslashes(once), once);
  });
});

describe('windows registry env var script generator', () => {
  it('sets each var via [Environment]::SetEnvironmentVariable with User scope', () => {
    const script = generateSetUserEnvVarsScript({ HEADROOM_PORT: '8787' });
    assert.ok(script.includes("[Environment]::SetEnvironmentVariable('HEADROOM_PORT', '8787', 'User')"));
  });
  it('does not double backslashes (single-quoted PS strings need none)', () => {
    const script = generateSetUserEnvVarsScript({ SSL_CERT_FILE: 'C:\\Users\\yehsuf\\ca-bundle.pem' });
    assert.ok(script.includes("'C:\\Users\\yehsuf\\ca-bundle.pem'"));
    assert.ok(!script.includes('\\\\'));
  });
  it('doubles a literal single-quote in a value', () => {
    const script = generateSetUserEnvVarsScript({ WEIRD: "it's a test" });
    assert.ok(script.includes("'it''s a test'"));
  });
  it('handles multiple vars, one line each', () => {
    const script = generateSetUserEnvVarsScript({ A: '1', B: '2' });
    assert.equal(script.trim().split('\n').length, 2);
  });
  it('self-heals an already-doubled value instead of leaving it corrupted', () => {
    const script = generateSetUserEnvVarsScript({ SSL_CERT_FILE: 'C:\\\\ProgramData\\\\NetFree\\\\netfree-ca-list.crt' });
    assert.ok(script.includes("'C:\\ProgramData\\NetFree\\netfree-ca-list.crt'"));
  });
});

describe('npm global bin dir resolver', () => {
  it('appends bin/ on posix', () => {
    assert.equal(resolveGlobalBinDir('/usr/local', 'darwin'), '/usr/local/bin');
    assert.equal(resolveGlobalBinDir('/usr/local', 'linux'), '/usr/local/bin');
  });
  it('uses the prefix directly on windows (no bin/ subfolder)', () => {
    assert.equal(resolveGlobalBinDir('C:\\nvm4w\\nodejs', 'windows'), 'C:\\nvm4w\\nodejs');
  });
});

describe('linkGlobalBin', () => {
  it('gracefully reports failure (not throwing) for a non-writable prefix', () => {
    const roDir = mkdtempSync(join(tmpdir(), 'myelin-ro-'));
    const binDir = join(roDir, 'bin');
    mkdirSync(binDir);
    chmodSync(binDir, 0o555);
    try {
      const result = linkGlobalBin({ repoRoot: process.cwd(), os: 'darwin', prefix: roDir });
      assert.equal(result.linked, false);
      assert.ok(result.reason.includes('no write access'));
    } finally {
      chmodSync(binDir, 0o755);
      rmSync(roDir, { recursive: true, force: true });
    }
  });
});
