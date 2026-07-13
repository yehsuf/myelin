import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMitmCompression } from '../src/config/compression-env.mjs';

test('compression enabled by default (kompress-base backend)', () => {
  const r = resolveMitmCompression({
    proxy: { headroom: { enabled: true, backend: 'kompress-base' } },
  });
  assert.equal(r.compressEnabled, true);
  assert.equal(r.MYELIN_COMPRESS, '1');
});

test('legacy top-level compression.backend=disabled turns compression off', () => {
  const r = resolveMitmCompression({
    compression: { backend: 'disabled' },
    proxy: { headroom: { enabled: true, backend: 'kompress-base' } },
  });
  assert.equal(r.compressEnabled, false);
  assert.equal(r.MYELIN_COMPRESS, '0');
});

test('migrated proxy.headroom.backend=disabled turns compression off', () => {
  const r = resolveMitmCompression({
    proxy: { headroom: { enabled: true, backend: 'disabled' } },
  });
  assert.equal(r.MYELIN_COMPRESS, '0');
});

test('proxy.headroom.enabled=false turns compression off', () => {
  const r = resolveMitmCompression({ proxy: { headroom: { enabled: false } } });
  assert.equal(r.MYELIN_COMPRESS, '0');
});

test('litellm front-end disables sidecar compression', () => {
  const r = resolveMitmCompression({
    proxy: { headroom: { enabled: true, backend: 'kompress-base' } },
    budget_routing: { litellm: true },
  });
  assert.equal(r.MYELIN_COMPRESS, '0');
});

test('MYELIN_COMPRESS is always explicit (never undefined)', () => {
  const r = resolveMitmCompression({});
  assert.ok(r.MYELIN_COMPRESS === '0' || r.MYELIN_COMPRESS === '1');
});

test('copilot_headroom redirect suppressed when compression disabled', () => {
  const r = resolveMitmCompression({
    compression: { backend: 'disabled' },
    proxy: {
      headroom: { enabled: true },
      copilot_headroom: { enabled: true, port: 8788 },
    },
  });
  assert.equal(r.copilotHeadroomPort, undefined);
});

test('copilot_headroom redirect active when enabled and compression on', () => {
  const r = resolveMitmCompression({
    proxy: {
      headroom: { enabled: true, backend: 'kompress-base' },
      copilot_headroom: { enabled: true, port: 8799 },
    },
  });
  assert.equal(r.copilotHeadroomPort, 8799);
});
