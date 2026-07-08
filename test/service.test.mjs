import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePlist } from '../src/service/launchd.mjs';
import { generateSystemdUnit } from '../src/service/systemd.mjs';
import { generateHeadroomRunScript, generateSetUserEnvVarsScript } from '../src/service/windows.mjs';
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
