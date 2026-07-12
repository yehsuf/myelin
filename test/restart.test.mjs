import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildCopilotHeadroomTaskEnv, buildManagedHeadroomEnv, defaultRestartManagedHeadroom, runRestart } from '../src/cli/restart.mjs';

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

describe('buildManagedHeadroomEnv', () => {
  it('preserves the configured corporate proxy when rebuilding a managed service env', () => {
    const env = buildManagedHeadroomEnv({
      proxy: {
        headroom: {
          port: 8787,
          mode: 'cache',
          corporate_proxy: 'http://corp-proxy:8080',
          openai_target_url: 'https://api.githubcopilot.com',
        },
      },
    }, {});

    assert.equal(env.HTTPS_PROXY, 'http://corp-proxy:8080');
  });

  it('does not persist a loopback wrapper proxy into the durable managed env', () => {
    const env = buildManagedHeadroomEnv({
      proxy: {
        headroom: {
          port: 8787,
        },
      },
    }, {
      HTTPS_PROXY: 'http://127.0.0.1:8888',
      NO_PROXY: '127.0.0.1,localhost,::1',
    });

    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.NO_PROXY, '127.0.0.1,localhost,::1');
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

describe('defaultRestartManagedHeadroom', () => {
  it('reinstalls a missing managed registration instead of spawning a transient-only restart', async () => {
    const calls = [];
    const cfg = {
      proxy: {
        headroom: {
          port: 8787,
          mode: 'cache',
          corporate_proxy: 'http://corp-proxy:8080',
          openai_target_url: 'https://api.githubcopilot.com',
          intercept_tool_results: true,
        },
      },
    };

    await defaultRestartManagedHeadroom({
      os: 'windows',
      cfg,
      winManager: 'registry',
      log: () => {},
      warn: () => {},
      homedirImpl: () => 'C:\\Users\\alice',
      headroomBinPathImpl: () => 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe',
      managedHeadroomRegistrationStatusImpl: async () => ({ registered: false }),
      ensureManagedHeadroomServiceImpl: async (opts) => {
        calls.push(opts);
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].home, 'C:\\Users\\alice');
    assert.equal(calls[0].headroomBin, 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe');
    assert.deepEqual(calls[0].envVars, buildManagedHeadroomEnv(cfg));
    assert.equal(calls[0].interceptToolResults, true);
  });
});
