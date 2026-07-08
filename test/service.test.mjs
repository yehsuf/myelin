import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { generatePlist } from '../src/service/launchd.mjs';
import { generateSystemdUnit } from '../src/service/systemd.mjs';
import { generateHeadroomRunScript } from '../src/service/windows.mjs';

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
});
