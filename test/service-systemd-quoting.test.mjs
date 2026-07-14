import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  generateEngineInstanceUnit,
  generateMitmUnit,
  validateSystemdUnit,
} from '../src/service/systemd.mjs';

const ENGINE_BINS = { headroomBin: '/opt/myelin/bin/headroom' };

function headroomInstance(overrides = {}) {
  return {
    engine: 'headroom',
    role: 'primary',
    port: 8787,
    id: 'headroom-primary',
    stateDir: '/srv/managed/state/headroom-primary',
    logPath: '/srv/managed/headroom-primary.log',
    healthUrl: 'http://127.0.0.1:8787/health',
    env: {},
    ...overrides,
  };
}

/** Systemd word-splitting oracle: honors double-quote grouping + backslash. */
function systemdWords(execValue) {
  const words = [];
  let cur = '';
  let inWord = false;
  let inQuote = false;
  for (let i = 0; i < execValue.length; i++) {
    const c = execValue[i];
    if (c === '\\') { inWord = true; cur += execValue[++i] ?? ''; continue; }
    if (c === '"') { inWord = true; inQuote = !inQuote; continue; }
    if (!inQuote && /\s/.test(c)) { if (inWord) { words.push(cur); cur = ''; inWord = false; } continue; }
    inWord = true; cur += c;
  }
  if (inWord) words.push(cur);
  return words;
}

function execStartLine(unit) {
  return unit.split('\n').find((l) => l.startsWith('ExecStart='));
}

describe('I7 systemd ExecStart quoting', () => {
  it('quotes an executable path containing spaces so it stays one token', () => {
    const instance = headroomInstance();
    const unit = generateEngineInstanceUnit({
      instance,
      headroomBin: '/srv/Myelin Data/bin/headroom',
    });
    const exec = execStartLine(unit).slice('ExecStart='.length);
    const words = systemdWords(exec);
    assert.equal(words[0], '/srv/Myelin Data/bin/headroom', 'spacey path is a single exec token');
    assert.deepEqual(words, ['/srv/Myelin Data/bin/headroom', 'proxy', '--port', '8787']);
    assert.ok(exec.includes('"/srv/Myelin Data/bin/headroom"'));
  });

  it('leaves a simple executable + args unquoted (backward compatible)', () => {
    const unit = generateEngineInstanceUnit({ instance: headroomInstance(), ...ENGINE_BINS });
    assert.ok(unit.includes('ExecStart=/opt/myelin/bin/headroom proxy --port 8787'));
  });

  it('escapes special characters ($ % " backslash) in the exec path', () => {
    const weird = '/srv/we$rd %path "q"/he\\adroom';
    const unit = generateEngineInstanceUnit({ instance: headroomInstance(), headroomBin: weird });
    const exec = execStartLine(unit).slice('ExecStart='.length);
    const words = systemdWords(exec);
    assert.equal(words[0].replace(/\$\$/g, '$').replace(/%%/g, '%').replace(/\\\\/g, '\\'), weird);
    assert.equal(words.length, 4, 'special-char path stays a single token');
    assert.ok(validateSystemdUnit(unit) === unit);
  });

  it('quotes an Environment value containing spaces', () => {
    const instance = headroomInstance({ env: { MYELIN_DIR: '/srv/Myelin Data' } });
    const unit = generateEngineInstanceUnit({ instance, ...ENGINE_BINS });
    assert.ok(unit.includes('Environment="MYELIN_DIR=/srv/Myelin Data"'));
  });

  it('leaves a simple Environment value unquoted', () => {
    const instance = headroomInstance({ env: { MYELIN_DIR: '/srv/managed-myelin' } });
    const unit = generateEngineInstanceUnit({ instance, ...ENGINE_BINS });
    assert.match(unit, /Environment=MYELIN_DIR=\/srv\/managed-myelin/);
  });

  it('escapes quotes/backslash/percent in an Environment value', () => {
    const instance = headroomInstance({ env: { X: 'a "b" c\\d %e' } });
    const unit = generateEngineInstanceUnit({ instance, ...ENGINE_BINS });
    assert.ok(unit.includes('Environment="X=a \\"b\\" c\\\\d %%e"'));
  });
});

describe('I7 systemd mitm unit quoting', () => {
  it('quotes a mitmdump path and addon path containing spaces', () => {
    const unit = generateMitmUnit({
      mitmdumpBin: '/opt/My Tools/mitmdump',
      args: ['--listen-port', '8888', '-s', '/srv/My Addons/addon.py'],
    });
    const exec = execStartLine(unit).slice('ExecStart='.length);
    const words = systemdWords(exec);
    assert.deepEqual(words, ['/opt/My Tools/mitmdump', '--listen-port', '8888', '-s', '/srv/My Addons/addon.py']);
  });

  it('keeps simple mitm args unquoted', () => {
    const unit = generateMitmUnit({
      mitmdumpBin: '/usr/bin/mitmdump',
      args: ['--mode', 'regular@8888', '--mode', 'regular@127.0.0.1:8889', '-s', '/path/addon.py'],
    });
    assert.ok(unit.includes('regular@8888'));
    assert.ok(unit.includes('ExecStart=/usr/bin/mitmdump --mode regular@8888'));
  });
});

describe('I7 validateSystemdUnit', () => {
  it('returns the unit unchanged for a well-formed unit', () => {
    const unit = generateEngineInstanceUnit({ instance: headroomInstance(), ...ENGINE_BINS });
    assert.equal(validateSystemdUnit(unit), unit);
  });

  it('throws on an ExecStart with an unbalanced (unterminated) quote', () => {
    const broken = [
      '[Service]',
      'ExecStart="/srv/Myelin Data/bin/headroom proxy --port 8787',
      'Restart=always',
    ].join('\n');
    assert.throws(() => validateSystemdUnit(broken), /unbalanced quoting/);
  });

  it('accepts an ExecStart whose spacey path is properly quoted', () => {
    const ok = [
      '[Service]',
      'ExecStart="/srv/Myelin Data/bin/headroom" proxy --port 8787',
      'Restart=always',
    ].join('\n');
    assert.equal(validateSystemdUnit(ok), ok);
  });
});
