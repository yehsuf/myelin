import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runFixHeadroomWin } from '../src/cli/fix.mjs';

describe('runFixHeadroomWin (WIN-HEADROOM-FALLBACK-001)', () => {
  it('skips on non-Windows', async () => {
    const result = await runFixHeadroomWin({
      os: 'darwin',
      log: () => {},
      warn: () => {},
    });
    assert.equal(result.status, 'skip');
    assert.equal(result.reason, 'not-windows');
  });

  it('skips on Linux', async () => {
    const result = await runFixHeadroomWin({
      os: 'linux',
      log: () => {},
      warn: () => {},
    });
    assert.equal(result.status, 'skip');
  });

  it('returns failed when Defender exclusion step fails', async () => {
    const result = await runFixHeadroomWin({
      os: 'windows',
      log: () => {},
      warn: () => {},
      execSyncFn: () => { throw new Error('UAC cancelled'); },
      execFileSyncFn: () => {},
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.step, 'defender');
  });

  it('returns failed when component install fails after Defender step', async () => {
    const result = await runFixHeadroomWin({
      os: 'windows',
      log: () => {},
      warn: () => {},
      // Defender step succeeds
      execSyncFn: () => {},
      // Component stage fails
      execFileSyncFn: () => { throw new Error('still blocked'); },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.step, 'install');
  });
});
