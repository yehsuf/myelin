import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { runStatus } from '../src/cli/status.mjs';

const FAKE_CACHE = JSON.stringify({
  avgCompressionPct: 27.5,
  reqCount: 2,
  topModel: 'gpt-5.4-nano',
  cachedAt: new Date().toISOString(),
});

function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  const result = fn();
  return Promise.resolve(result).then(() => {
    process.stdout.write = orig;
    return chunks.join('');
  }).catch((err) => {
    process.stdout.write = orig;
    throw err;
  });
}

const FAKE_CFG = {
  proxy: {
    headroom_lite: { port: 8790 },
    mitm: { enabled: true, port: 8888 },
    engine: 'headroom_lite',
  },
};

const baseOpts = {
  _probeAlive: () => true,
  _readFile: () => FAKE_CACHE,
  _exec: () => {},
  _existsSync: () => true,
  _loadConfig: async () => FAKE_CFG,
};

describe('runStatus (STATUSBAR-001)', () => {
  it('plain format includes health mark and engine', async () => {
    const out = await captureStdout(() => runStatus({ ...baseOpts, format: 'plain' }));
    assert.ok(out.includes('myelin'), 'has "myelin"');
    assert.ok(out.includes('✓'), 'has health mark');
    assert.ok(out.includes('hlite'), 'has engine');
  });

  it('plain format includes avg compression when log has data', async () => {
    const out = await captureStdout(() => runStatus({ ...baseOpts, format: 'plain' }));
    assert.ok(out.includes('saved'), 'has savings');
    assert.ok(out.includes('27.5'), '27.5% avg of 25+30');
  });

  it('plain format includes top model from log', async () => {
    const out = await captureStdout(() => runStatus({ ...baseOpts, format: 'plain' }));
    assert.ok(out.includes('gpt-5.4-nano'), 'has top model');
  });

  it('json format outputs valid JSON with all keys', async () => {
    const out = await captureStdout(() => runStatus({ ...baseOpts, format: 'json' }));
    const data = JSON.parse(out);
    assert.ok('engine' in data);
    assert.ok('hlite' in data);
    assert.ok('avgCompressionPct' in data);
    assert.ok('topModel' in data);
    assert.ok('cachedAt' in data, 'must include cachedAt for staleness detection');
    assert.equal(data.hlite, true);
    assert.equal(data.topModel, 'gpt-5.4-nano');
    assert.ok(Math.abs(data.avgCompressionPct - 27.5) < 0.1);
    assert.ok(data.cachedAt !== null, 'cachedAt should be the timestamp string');
  });

  it('prompt format contains ANSI codes and health mark', async () => {
    const out = await captureStdout(() => runStatus({ ...baseOpts, format: 'prompt' }));
    assert.ok(out.includes('\x1b['), 'has ANSI escape codes');
    assert.ok(out.includes('✓'), 'has health mark');
    assert.ok(out.includes('myelin'), 'has "myelin"');
  });

  it('plain format shows ✗ when hlite is down', async () => {
    const opts = { ...baseOpts, _probeAlive: () => false };
    const out = await captureStdout(() => runStatus({ ...opts, format: 'plain' }));
    assert.ok(out.includes('✗'), 'shows failure mark');
  });

  it('json format works with no log data', async () => {
    const opts = {
      ...baseOpts,
      _existsSync: () => false,
      _readFile: () => { throw new Error('no file'); },
    };
    const out = await captureStdout(() => runStatus({ ...opts, format: 'json' }));
    const data = JSON.parse(out);
    assert.equal(data.avgCompressionPct, null);
    assert.equal(data.topModel, null);
    assert.equal(data.reqCount, 0);
  });
});
