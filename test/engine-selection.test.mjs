import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  selectedBackend,
  resolveCompressionConfig,
} from '../src/update/engine-selection.mjs';

describe('engine-selection canonical backend (PR #23)', () => {
  it('reads a canonical compression.backend directly', () => {
    assert.equal(selectedBackend({ compression: { backend: 'headroom-original' } }), 'headroom-original');
    assert.equal(selectedBackend({ compression: { backend: 'headroom-lite' } }), 'headroom-lite');
    assert.equal(selectedBackend({ compression: { backend: 'disabled' } }), 'disabled');
  });

  it('prefers canonical compression.backend over the legacy proxy.engine alias', () => {
    const config = {
      compression: { backend: 'headroom-original' },
      proxy: { engine: 'headroom_lite' },
    };
    assert.equal(selectedBackend(config), 'headroom-original');
  });

  it('throws on an invalid canonical compression.backend', () => {
    assert.throws(
      () => selectedBackend({ compression: { backend: 'nope' } }),
      /invalid compression\.backend "nope"/,
    );
  });

  it('falls back to the legacy proxy.engine model when compression is absent', () => {
    assert.equal(selectedBackend({ proxy: { engine: 'headroom' } }), 'headroom-original');
    assert.equal(selectedBackend({ proxy: { engine: 'headroom_lite' } }), 'headroom-lite');
    assert.equal(selectedBackend({ proxy: { compression: { enabled: false } } }), 'disabled');
  });

  it('resolves copilotProxy from the canonical compression.copilot_proxy', () => {
    const selection = resolveCompressionConfig({
      compression: { backend: 'headroom-lite', copilot_proxy: { enabled: true, port: 8899 } },
    });
    assert.deepEqual(selection, {
      backend: 'headroom-lite',
      copilotProxy: { enabled: true, port: 8899 },
    });
  });

  it('resolves copilotProxy from the legacy proxy.copilot_headroom when compression is absent', () => {
    const selection = resolveCompressionConfig({
      proxy: { engine: 'headroom_lite', copilot_headroom: { enabled: true, port: 8788 } },
    });
    assert.deepEqual(selection, {
      backend: 'headroom-lite',
      copilotProxy: { enabled: true, port: 8788 },
    });
  });

  it('lets an explicit legacy copilot_headroom.enabled=false win over a canonical copilot_proxy.enabled=true (per-key precedence)', () => {
    // Both keys explicitly set: the legacy per-key override wins, mirroring
    // reader.mjs proxyAliasFor. Raw-YAML update path (no loadConfig).
    const selection = resolveCompressionConfig({
      compression: { backend: 'headroom-lite', copilot_proxy: { enabled: true, port: 8899 } },
      proxy: { copilot_headroom: { enabled: false } },
    });
    assert.equal(selection.copilotProxy.enabled, false);
  });

  it('lets an explicit legacy copilot_headroom.enabled=true win over a canonical copilot_proxy.enabled=false', () => {
    const selection = resolveCompressionConfig({
      compression: { backend: 'headroom-lite', copilot_proxy: { enabled: false } },
      proxy: { copilot_headroom: { enabled: true } },
    });
    assert.equal(selection.copilotProxy.enabled, true);
  });
});
