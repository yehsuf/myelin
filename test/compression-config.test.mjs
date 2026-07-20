import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateLegacyCompressionConfig,
  resolveCompressionConfig,
} from '../src/config/compression.mjs';

describe('migrateLegacyCompressionConfig', () => {
  it('leaves configs without legacy compression keys unchanged', () => {
    const input = {
      proxy: {
        mitm: { enabled: true, port: 8888 },
      },
    };

    const result = migrateLegacyCompressionConfig(input);

    assert.equal(result.changed, false);
    assert.deepEqual(result.config, input);
    assert.deepEqual(result.warnings, []);
  });

  it('keeps canonical compression and removes legacy compression keys when both exist', () => {
    const input = {
      compression: {
        backend: 'headroom-original',
        port: 9001,
        copilot_proxy: {
          enabled: true,
          port: 9011,
        },
        original: {
          mode: 'token',
          intercept_tool_results: false,
          corporate_proxy: 'http://corp',
          openai_target_url: 'https://example.invalid',
        },
      },
      proxy: {
        mitm: {
          enabled: true,
          port: 8888,
          override_proxy: 'http://proxy.internal:8080',
        },
        headroom: {
          enabled: true,
          port: 8787,
          mode: 'cache',
        },
        headroom_lite: {
          enabled: true,
          port: 8790,
        },
        copilot_headroom: {
          enabled: false,
          port: 8788,
        },
      },
      index_tier: 'default',
    };

    const result = migrateLegacyCompressionConfig(input);

    assert.equal(result.changed, true);
    assert.deepEqual(result.config.compression, input.compression);
    assert.deepEqual(result.config.proxy, {
      mitm: {
        enabled: true,
        port: 8888,
        override_proxy: 'http://proxy.internal:8080',
      },
    });
    assert.deepEqual(result.warnings, [
      'Canonical compression settings were kept; removed legacy proxy.headroom, proxy.headroom_lite, and proxy.copilot_headroom keys.',
    ]);
  });

  it('treats null compression as absent and migrates legacy compression settings', () => {
    const result = migrateLegacyCompressionConfig({
      compression: null,
      proxy: {
        headroom_lite: {
          enabled: true,
          port: 8790,
        },
      },
    });

    assert.equal(result.changed, true);
    assert.deepEqual(result.config.compression, {
      backend: 'headroom-lite',
      port: 8790,
      copilot_proxy: {
        enabled: true,
        port: 8788,
      },
      original: {
        mode: 'cache',
        intercept_tool_results: true,
        corporate_proxy: '',
        openai_target_url: 'https://api.githubcopilot.com',
      },
    });
    assert.deepEqual(result.warnings, []);
  });

  it('selects headroom-lite and removes legacy backend keys', () => {
    const result = migrateLegacyCompressionConfig({
      proxy: {
        headroom: {
          enabled: false,
          port: 8787,
          mode: 'cache',
          intercept_tool_results: true,
          corporate_proxy: '',
          openai_target_url: 'https://api.githubcopilot.com',
        },
        headroom_lite: { enabled: true, port: 8790 },
        mitm: { enabled: true, port: 8888 },
      },
    });

    assert.equal(result.changed, true);
    assert.deepEqual(result.config.compression, {
      backend: 'headroom-lite',
      port: 8790,
      copilot_proxy: {
        enabled: true,
        port: 8788,
      },
      original: {
        mode: 'cache',
        intercept_tool_results: true,
        corporate_proxy: '',
        openai_target_url: 'https://api.githubcopilot.com',
      },
    });
    assert.equal(result.config.proxy.headroom, undefined);
    assert.equal(result.config.proxy.headroom_lite, undefined);
  });

  it('prefers headroom-lite with a warning when both legacy backends are enabled', () => {
    const result = migrateLegacyCompressionConfig({
      proxy: {
        headroom: { enabled: true, port: 8787 },
        headroom_lite: { enabled: true, port: 8790 },
      },
    });
    assert.equal(result.config.compression.backend, 'headroom-lite');
    assert.match(result.warnings.join('\n'), /both legacy compression backends/i);
  });

  it('preserves legacy original settings when lite is explicitly disabled', () => {
    const result = migrateLegacyCompressionConfig({
      proxy: {
        headroom: { port: 9000, mode: 'token' },
        headroom_lite: { enabled: false },
      },
    });

    assert.equal(result.config.compression.backend, 'headroom-original');
    assert.equal(result.config.compression.port, 9000);
    assert.equal(result.config.compression.original.mode, 'token');
  });

  it('keeps the original backend when it was explicitly enabled and lite was never configured', () => {
    const result = migrateLegacyCompressionConfig({
      proxy: {
        headroom: { enabled: true, port: 9000 },
      },
    });

    assert.equal(result.config.compression.backend, 'headroom-original');
    assert.equal(result.config.compression.port, 9000);
    assert.deepEqual(result.warnings, []);
  });

  it('falls back to the original backend when lite was explicitly disabled', () => {
    const result = migrateLegacyCompressionConfig({
      proxy: {
        headroom_lite: { enabled: false },
      },
    });

    assert.equal(result.config.compression.backend, 'headroom-original');
    assert.equal(result.config.compression.port, 8787);
  });

  it('defaults partial legacy configs to headroom-lite instead of disabling compression', () => {
    const result = migrateLegacyCompressionConfig({
      proxy: {
        headroom: { port: 9000 },
      },
    });

    assert.equal(result.config.compression.backend, 'headroom-lite');
    assert.equal(result.config.compression.port, 9000);
    assert.deepEqual(result.warnings, []);
  });
});

describe('resolveCompressionConfig', () => {
  it('migrates the dedicated Copilot proxy independently of backend type', () => {
    const result = migrateLegacyCompressionConfig({
      proxy: {
        headroom: { enabled: false, port: 8787 },
        headroom_lite: { enabled: true, port: 8787 },
        copilot_headroom: { enabled: true, port: 8788, mode: 'cache' },
      },
    });
    assert.deepEqual(result.config.compression.copilot_proxy, {
      enabled: true,
      port: 8788,
    });
    assert.equal(result.config.proxy.copilot_headroom, undefined);
  });

  it('returns canonical compression settings with defaults applied', () => {
    const result = resolveCompressionConfig({
      compression: {
        backend: 'headroom-original',
        port: '8791',
        copilot_proxy: {
          enabled: true,
          port: '8789',
        },
        original: {
          mode: 'token',
          intercept_tool_results: false,
          corporate_proxy: 'http://corp',
          openai_target_url: 'https://example.invalid',
        },
      },
    });

    assert.deepEqual(result, {
      backend: 'headroom-original',
      port: 8791,
      copilotProxy: {
        enabled: true,
        port: 8789,
      },
      original: {
        mode: 'token',
        intercept_tool_results: false,
        corporate_proxy: 'http://corp',
        openai_target_url: 'https://example.invalid',
      },
    });
  });

  it('rejects invalid backends', () => {
    assert.throws(
      () => resolveCompressionConfig({ compression: { backend: 'unknown' } }),
      /Invalid compression\.backend: unknown/,
    );
  });
});

describe('migration preserves copilot_proxy default-enabled', () => {
  it('migrateLegacyCompressionConfig: absent copilot_headroom.enabled defaults to true (not false)', () => {
    const result = migrateLegacyCompressionConfig({
      proxy: {
        headroom: { enabled: false },
        headroom_lite: { enabled: true, port: 8787 },
        // copilot_headroom deliberately absent — should inherit default true
      },
    });
    assert.equal(result.config.compression.copilot_proxy.enabled, true);
  });

  it('migrateLegacyCompressionConfig: explicit copilot_headroom.enabled=false is preserved', () => {
    const result = migrateLegacyCompressionConfig({
      proxy: {
        headroom: { enabled: false },
        headroom_lite: { enabled: true, port: 8787 },
        copilot_headroom: { enabled: false, port: 8788 },
      },
    });
    assert.equal(result.config.compression.copilot_proxy.enabled, false);
  });

  it('resolveCompressionConfig: absent copilot toggle defaults to true', () => {
    const r = resolveCompressionConfig({
      compression: { backend: 'headroom-lite', port: 8787 },
    });
    assert.equal(r.copilotProxy.enabled, true);
  });

  it('resolveCompressionConfig: explicit false is preserved', () => {
    const r = resolveCompressionConfig({
      compression: { backend: 'headroom-lite', port: 8787, copilot_proxy: { enabled: false } },
    });
    assert.equal(r.copilotProxy.enabled, false);
  });
});
