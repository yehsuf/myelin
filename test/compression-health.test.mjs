import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  evaluateCompressionHealth,
  probeCompressionHealth,
} from '../src/service/compression-health.mjs';

const COMPRESSION_RUNTIME = {
  purpose: 'primary',
  backend: 'headroom-lite',
  port: 8787,
  enabled: true,
  command: '/opt/myelin/headroom-lite',
  args: [],
  env: { HEADROOM_LITE_PORT: '8787' },
  serviceId: 'myelin-compression',
};

describe('compression runtime health', () => {
  it('identifies the backend from the selected runtime health response', () => {
    assert.deepEqual(
      evaluateCompressionHealth(COMPRESSION_RUNTIME, {
        status: 'ok',
        service: 'headroom-lite',
      }),
      {
        ok: true,
        backend: 'headroom-lite',
        response: { status: 'ok', service: 'headroom-lite' },
      },
    );
  });

  it('rejects a healthy response from the non-selected backend', async () => {
    const result = await probeCompressionHealth({
      ...COMPRESSION_RUNTIME,
      healthUrl: 'http://127.0.0.1:8787/health',
    }, {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ status: 'healthy', service: 'headroom' }),
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.backend, 'headroom-original');
  });

  it('rejects unidentified HTTP 200 health responses', () => {
    const result = evaluateCompressionHealth(COMPRESSION_RUNTIME, {}, true);
    assert.equal(result.ok, false);
    assert.equal(result.backend, 'unknown');
  });

  it('recognizes the original Headroom health response shape', () => {
    const result = evaluateCompressionHealth(
      {
        ...COMPRESSION_RUNTIME,
        backend: 'headroom-original',
      },
      { status: 'healthy' },
      true,
    );
    assert.equal(result.ok, true);
    assert.equal(result.backend, 'headroom-original');
  });

  it('treats a disabled runtime without a health URL as healthy', async () => {
    const result = await probeCompressionHealth({
      ...COMPRESSION_RUNTIME,
      backend: 'disabled',
      enabled: false,
      healthUrl: undefined,
    });
    assert.deepEqual(result, { ok: true, backend: 'disabled', response: null });
  });
});
