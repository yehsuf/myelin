import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  assertCompressionRuntime,
  compressionRuntimeEnv,
  compressionServiceIdentities,
  compressionServiceIdentity,
  legacyCompressionServiceIds,
  legacyCompressionServiceIdsFor,
} from '../src/service/compression-identities.mjs';

const PRIMARY = {
  purpose: 'primary',
  backend: 'headroom-lite',
  enabled: true,
  command: '/opt/myelin/headroom-lite',
  args: [],
  env: { HEADROOM_LITE_PORT: '8787' },
  serviceId: 'myelin-compression',
};

describe('compression service identities', () => {
  it('derives canonical identity per platform for the primary runtime', () => {
    assert.equal(compressionServiceIdentity(PRIMARY, 'darwin'), 'com.myelin.compression');
    assert.equal(compressionServiceIdentity(PRIMARY, 'linux'), 'myelin-compression.service');
    assert.equal(compressionServiceIdentity(PRIMARY, 'win32'), 'MyelinCompression');
  });

  it('maps every purpose to a platform identity', () => {
    assert.deepEqual(compressionServiceIdentities('linux'), {
      primary: 'myelin-compression.service',
      copilot: 'myelin-copilot-compression.service',
    });
  });

  it('rejects a runtime whose serviceId does not match its purpose', () => {
    assert.throws(
      () => compressionServiceIdentity({ purpose: 'primary', serviceId: 'wrong' }, 'linux'),
      /Invalid compression service identity/,
    );
  });

  it('exposes the exact allowlisted legacy identities', () => {
    const ids = legacyCompressionServiceIds();
    assert.ok(ids.includes('com.myelin.compression'));
    assert.ok(ids.includes('myelin-headroom-lite'));
    // returns a fresh copy each call (no shared mutable state)
    ids.push('mutated');
    assert.ok(!legacyCompressionServiceIds().includes('mutated'));
  });

  it('filters legacy identities by platform', () => {
    assert.ok(legacyCompressionServiceIdsFor('darwin').every(id => id.startsWith('com.')));
    assert.ok(legacyCompressionServiceIdsFor('linux').every(id => id.startsWith('myelin-')));
  });

  it('strips forbidden and null env values from runtime env', () => {
    const env = compressionRuntimeEnv({ env: { HEADROOM_LITE_PORT: '8787', ANTHROPIC_BASE_URL: 'http://x', DROP: null } });
    assert.equal(env.HEADROOM_LITE_PORT, '8787');
    assert.ok(!('ANTHROPIC_BASE_URL' in env));
    assert.ok(!('DROP' in env));
  });

  it('asserts a valid enabled runtime and rejects a missing command', () => {
    assert.equal(assertCompressionRuntime(PRIMARY), PRIMARY);
    assert.throws(
      () => assertCompressionRuntime({ ...PRIMARY, command: '' }),
      /missing a command/,
    );
  });
});
