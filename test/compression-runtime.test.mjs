import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompressionRuntimes } from '../src/service/compression-runtime.mjs';

describe('buildCompressionRuntimes', () => {
  it('uses headroom-lite for both primary and Copilot full-proxy instances', () => {
    const plans = buildCompressionRuntimes(
      {
        compression: {
          backend: 'headroom-lite',
          port: 8787,
          copilot_proxy: { enabled: true, port: 8788 },
        },
      },
      {
        headroomLiteBin: '/tools/headroom-lite',
        headroomOriginalBin: '/tools/headroom',
      },
      { egressPort: 8889 },
    );

    assert.deepEqual(plans.primary, {
      purpose: 'primary',
      backend: 'headroom-lite',
      port: 8787,
      enabled: true,
      command: '/tools/headroom-lite',
      args: [],
      env: { HEADROOM_LITE_PORT: '8787' },
      healthUrl: 'http://127.0.0.1:8787/health',
      serviceId: 'myelin-compression',
    });
    assert.deepEqual(plans.copilot, {
      purpose: 'copilot',
      backend: 'headroom-lite',
      port: 8788,
      enabled: true,
      command: '/tools/headroom-lite',
      args: [],
      env: {
        HEADROOM_LITE_PORT: '8788',
        HEADROOM_LITE_COMPRESS_PROXY: 'true',
        HEADROOM_LITE_UPSTREAM: 'http://127.0.0.1:8889',
      },
      healthUrl: 'http://127.0.0.1:8788/health',
      serviceId: 'myelin-copilot-compression',
    });
  });

  it('uses headroom-original for both primary and Copilot instances without auth changes', () => {
    const plans = buildCompressionRuntimes(
      {
        compression: {
          backend: 'headroom-original',
          port: 9001,
          copilot_proxy: { enabled: true, port: 9002 },
          original: {
            mode: 'cache',
            intercept_tool_results: false,
            corporate_proxy: 'http://corp.invalid:8080',
            openai_target_url: 'https://api.githubcopilot.com',
          },
        },
      },
      {
        headroomLiteBin: '/tools/headroom-lite',
        headroomOriginalBin: 'C:\\Tools\\headroom.cmd',
      },
      { egressPort: 9010 },
    );

    assert.deepEqual(plans.primary, {
      purpose: 'primary',
      backend: 'headroom-original',
      port: 9001,
      enabled: true,
      command: 'C:\\Tools\\headroom.cmd',
      args: ['proxy', '--port', '9001', '--mode', 'cache'],
      env: {
        HEADROOM_PORT: '9001',
        HEADROOM_MODE: 'cache',
        HEADROOM_INTERCEPT_ENABLED: '0',
        OPENAI_TARGET_API_URL: 'https://api.githubcopilot.com',
        HTTPS_PROXY: 'http://corp.invalid:8080',
      },
      healthUrl: 'http://127.0.0.1:9001/health',
      serviceId: 'myelin-compression',
    });
    assert.deepEqual(plans.copilot, {
      purpose: 'copilot',
      backend: 'headroom-original',
      port: 9002,
      enabled: true,
      command: 'C:\\Tools\\headroom.cmd',
      args: ['proxy', '--port', '9002', '--mode', 'cache'],
      env: {
        HEADROOM_PORT: '9002',
        HEADROOM_MODE: 'cache',
        ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:9010',
        OPENAI_TARGET_API_URL: 'http://127.0.0.1:9010',
        NO_PROXY: '127.0.0.1,localhost,::1',
      },
      healthUrl: 'http://127.0.0.1:9002/health',
      serviceId: 'myelin-copilot-compression',
    });
    assert.equal('ANTHROPIC_AUTH_TOKEN' in plans.copilot.env, false);
  });

  it('fills default original env values from canonical config', () => {
    const plans = buildCompressionRuntimes(
      {
        compression: {
          backend: 'headroom-original',
          port: 9101,
          copilot_proxy: { enabled: true, port: 9102 },
        },
      },
      {
        headroomLiteBin: '/tools/headroom-lite',
        headroomOriginalBin: '/tools/headroom',
      },
    );

    assert.equal(plans.primary.env.HEADROOM_INTERCEPT_ENABLED, '1');
    assert.equal(plans.primary.env.OPENAI_TARGET_API_URL, 'https://api.githubcopilot.com');
    assert.equal(plans.copilot.env.ANTHROPIC_TARGET_API_URL, 'http://127.0.0.1:8889');
    assert.equal(plans.copilot.env.OPENAI_TARGET_API_URL, 'http://127.0.0.1:8889');
    assert.equal('HTTPS_PROXY' in plans.primary.env, false);
  });

  it('disables both services without inventing commands', () => {
    const plans = buildCompressionRuntimes(
      { compression: { backend: 'disabled', port: 8787 } },
      { headroomLiteBin: '/lite', headroomOriginalBin: '/original' },
    );

    assert.deepEqual(plans.primary, {
      purpose: 'primary',
      backend: 'disabled',
      port: 8787,
      enabled: false,
      command: null,
      args: [],
      env: { MYELIN_COMPRESS: '0' },
      healthUrl: null,
      serviceId: 'myelin-compression',
    });
    assert.deepEqual(plans.copilot, {
      purpose: 'copilot',
      backend: 'disabled',
      port: 8788,
      enabled: false,
      command: null,
      args: [],
      env: { MYELIN_COMPRESS: '0' },
      healthUrl: null,
      serviceId: 'myelin-copilot-compression',
    });
  });

  it('keeps copilot disabled even when its flag is on but the shared backend is disabled', () => {
    const plans = buildCompressionRuntimes(
      {
        compression: {
          backend: 'disabled',
          port: 8787,
          copilot_proxy: { enabled: true, port: 8788 },
        },
      },
      { headroomLiteBin: '/lite', headroomOriginalBin: '/original' },
    );

    assert.equal(plans.primary.enabled, false);
    assert.equal(plans.copilot.enabled, false);
    assert.equal(plans.copilot.command, null);
    assert.deepEqual(plans.copilot.env, { MYELIN_COMPRESS: '0' });
  });

  it('disables the optional Copilot runtime when the shared backend is enabled but copilot proxy is off', () => {
    const plans = buildCompressionRuntimes(
      { compression: { backend: 'headroom-lite', port: 8787, copilot_proxy: { enabled: false } } },
      { headroomLiteBin: '/lite', headroomOriginalBin: '/original' },
    );

    assert.equal(plans.primary.backend, 'headroom-lite');
    assert.equal(plans.primary.enabled, true);
    assert.deepEqual(plans.copilot, {
      purpose: 'copilot',
      backend: 'disabled',
      port: 8788,
      enabled: false,
      command: null,
      args: [],
      env: { MYELIN_COMPRESS: '0' },
      healthUrl: null,
      serviceId: 'myelin-copilot-compression',
    });
  });

  it('rejects conflicting enabled primary and Copilot ports', () => {
    assert.throws(
      () => buildCompressionRuntimes({
        compression: {
          backend: 'headroom-lite',
          port: 8787,
          copilot_proxy: { enabled: true, port: 8787 },
        },
      }, {
        headroomLiteBin: '/tools/headroom-lite',
        headroomOriginalBin: '/tools/headroom',
      }),
      /compression runtime ports conflict: 8787 is configured for both primary and copilot/,
    );
  });

  it('rejects invalid explicit egress ports even when Copilot proxy is disabled', () => {
    assert.throws(
      () => buildCompressionRuntimes(
        { compression: { backend: 'headroom-lite', port: 8787 } },
        {
          headroomLiteBin: '/tools/headroom-lite',
          headroomOriginalBin: '/tools/headroom',
        },
        { egressPort: '70000' },
      ),
      /Invalid compression runtime egress port: 70000\. Expected a TCP port between 1 and 65535\./,
    );
  });

  it('rejects null as an explicit egress port override', () => {
    assert.throws(
      () => buildCompressionRuntimes(
        {
          compression: {
            backend: 'headroom-lite',
            port: 8787,
            copilot_proxy: { enabled: true, port: 8788 },
          },
        },
        {
          headroomLiteBin: '/tools/headroom-lite',
          headroomOriginalBin: '/tools/headroom',
        },
        { egressPort: null },
      ),
      /Invalid compression runtime egress port: null\. Expected a TCP port between 1 and 65535\./,
    );
  });

  it('rejects conflicting enabled copilot and egress ports', () => {
    assert.throws(
      () => buildCompressionRuntimes(
        {
          compression: {
            backend: 'headroom-lite',
            port: 8787,
            copilot_proxy: { enabled: true, port: 8889 },
          },
        },
        {
          headroomLiteBin: '/tools/headroom-lite',
          headroomOriginalBin: '/tools/headroom',
        },
        { egressPort: 8889 },
      ),
      /compression runtime ports conflict: 8889 is configured for both copilot and egress/,
    );
  });

  it('rejects conflicting enabled primary and egress ports when Copilot proxy is enabled', () => {
    assert.throws(
      () => buildCompressionRuntimes(
        {
          compression: {
            backend: 'headroom-lite',
            port: 8889,
            copilot_proxy: { enabled: true, port: 8788 },
          },
        },
        {
          headroomLiteBin: '/tools/headroom-lite',
          headroomOriginalBin: '/tools/headroom',
        },
        { egressPort: 8889 },
      ),
      /compression runtime ports conflict: 8889 is configured for both primary and egress/,
    );
  });

  it('does not conflict-check egress when Copilot proxy is disabled', () => {
    const plans = buildCompressionRuntimes(
      { compression: { backend: 'headroom-lite', port: 8889, copilot_proxy: { enabled: false } } },
      {
        headroomLiteBin: '/tools/headroom-lite',
        headroomOriginalBin: '/tools/headroom',
      },
      { egressPort: 8889 },
    );

    assert.equal(plans.primary.enabled, true);
    assert.equal(plans.primary.port, 8889);
    assert.equal(plans.copilot.enabled, false);
  });
});
