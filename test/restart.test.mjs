import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildCopilotHeadroomTaskEnv, runRestart } from '../src/cli/restart.mjs';

describe('buildCopilotHeadroomTaskEnv', () => {
  it('points Copilot-Headroom at the local mitm egress listener', () => {
    const env = buildCopilotHeadroomTaskEnv({
      home: '/Users/alice',
      copilotPort: 8788,
      egressPort: 8889,
      mode: 'cache',
    });

    assert.equal(env.ANTHROPIC_TARGET_API_URL, 'http://127.0.0.1:8889');
    assert.equal(env.OPENAI_TARGET_API_URL, 'http://127.0.0.1:8889');
    assert.equal(env.HEADROOM_MODE, 'cache');
    assert.equal(env.NO_PROXY, '127.0.0.1,localhost,::1');
    assert.match(env.HEADROOM_WORKSPACE_DIR, /[\\/]Users[\\/]alice[\\/]\.myelin[\\/]headroom-copilot-8788$/);
  });
});

describe('runRestart engine selection', () => {
  const baseConfig = {
    proxy: {
      headroom: { enabled: true, port: 8787 },
      headroom_lite: { enabled: false, port: 8790 },
      mitm: { enabled: true, port: 8888 },
      copilot_headroom: { enabled: false, port: 8788 },
      windows_service: { manager: 'registry' },
    },
  };

  it('does not start headroom-lite when Python headroom is selected', async () => {
    const calls = [];

    await runRestart({
      config: { ...baseConfig, proxy: { ...baseConfig.proxy, engine: 'headroom' } },
      detectOSImpl: () => 'linux',
      stopObsoleteEngineImpl: async ({ engine }) => calls.push(`stop:${engine}`),
      restartHeadroomLiteImpl: async () => calls.push('lite'),
      restartManagedHeadroomImpl: async () => calls.push('headroom'),
      restartMitmImpl: async () => calls.push('mitm'),
      waitForSelectedEngineImpl: async () => true,
      log: () => {},
      warn: () => {},
    });

    assert.deepEqual(calls, ['stop:headroom_lite', 'headroom', 'mitm']);
  });

  it('does not start Python headroom when headroom-lite is selected', async () => {
    const calls = [];

    await runRestart({
      config: {
        ...baseConfig,
        proxy: {
          ...baseConfig.proxy,
          engine: 'headroom_lite',
          headroom: { enabled: false, port: 8787 },
          headroom_lite: { enabled: true, port: 8790 },
        },
      },
      detectOSImpl: () => 'linux',
      stopObsoleteEngineImpl: async ({ engine }) => calls.push(`stop:${engine}`),
      restartHeadroomLiteImpl: async () => {
        calls.push('lite');
        return true;
      },
      restartManagedHeadroomImpl: async () => calls.push('headroom'),
      restartMitmImpl: async () => calls.push('mitm'),
      waitForSelectedEngineImpl: async () => true,
      log: () => {},
      warn: () => {},
    });

    assert.deepEqual(calls, ['lite', 'stop:headroom', 'mitm']);
  });

  it('keeps Python headroom running when headroom-lite fails to start', async () => {
    const calls = [];

    await runRestart({
      config: {
        ...baseConfig,
        proxy: {
          ...baseConfig.proxy,
          engine: 'headroom_lite',
          headroom: { enabled: false, port: 8787 },
          headroom_lite: { enabled: true, port: 8790 },
        },
      },
      detectOSImpl: () => 'linux',
      stopObsoleteEngineImpl: async ({ engine }) => calls.push(`stop:${engine}`),
      restartHeadroomLiteImpl: async () => {
        calls.push('lite');
        return false;
      },
      restartManagedHeadroomImpl: async () => calls.push('headroom'),
      restartMitmImpl: async () => calls.push('mitm'),
      waitForSelectedEngineImpl: async () => true,
      log: () => {},
      warn: () => {},
    });

    assert.deepEqual(calls, ['lite']);
  });
});
