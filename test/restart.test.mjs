import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildCopilotHeadroomTaskEnv,
  buildManagedHeadroomEnv,
  defaultRestartManagedHeadroom,
  defaultRestartMitm,
  restartHeadroomLite,
  runRestart,
  stopManagedHeadroomLite,
} from '../src/cli/restart.mjs';

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

describe('headroom-lite ownership guards', () => {
  it('surfaces a conflict instead of killing an unmanaged Unix port owner', async () => {
    const killed = [];
    const result = await stopManagedHeadroomLite({
      port: 8790,
      osKind: 'linux',
      home: '/Users/alice',
      execSyncImpl: (command) => {
        if (command.includes('lsof -nP -tiTCP:8790')) return Buffer.from('4242\n');
        if (command.includes('ps -p 4242 -o command=')) return Buffer.from('python3 /opt/other-service.js\n');
        if (command.includes('ps -p 4242 -o ppid=')) return Buffer.from('1\n');
        if (command.includes('ps -p 1 -o command=')) return Buffer.from('/sbin/init\n');
        return Buffer.from('');
      },
      existsSyncImpl: () => false,
      stopPidImpl: (pid) => killed.push(pid),
      waitImpl: async () => {},
    });

    assert.equal(result.conflict, true);
    assert.equal(result.reason, 'headroom-lite port 8790 is owned by an unmanaged process (pid 4242)');
    assert.deepEqual(killed, []);
  });

  it('does not spawn headroom-lite when an unmanaged owner already holds the port', async () => {
    const spawned = [];
    const warnings = [];
    const started = await restartHeadroomLite(8790, 'linux', {}, {
      home: '/Users/alice',
      execSyncImpl: () => Buffer.from('/usr/local/bin/headroom-lite\n'),
      stopManagedHeadroomLiteImpl: async () => ({
        conflict: true,
        reason: 'headroom-lite port 8790 is owned by an unmanaged process (pid 4242)',
      }),
      spawnImpl: (...args) => {
        spawned.push(args);
        return { unref() {} };
      },
      mkdirSyncImpl: () => {},
      writeFileSyncImpl: () => {},
      chmodSyncImpl: () => {},
      waitForHeadroomLiteImpl: async () => true,
      log: () => {},
      warn: (msg) => warnings.push(msg),
    });

    assert.equal(started, false);
    assert.deepEqual(spawned, []);
    assert.deepEqual(warnings, ['  ⚠ headroom-lite port 8790 is owned by an unmanaged process (pid 4242)']);
  });

  it('stops a managed Unix headroom-lite owner when the pid file matches the listener', async () => {
    const killed = [];
    const result = await stopManagedHeadroomLite({
      port: 8790,
      osKind: 'linux',
      home: '/Users/alice',
      execSyncImpl: (command) => {
        if (command.includes('lsof -nP -tiTCP:8790')) return Buffer.from('5150\n');
        if (command.includes('ps -p 5150 -o command=')) return Buffer.from('/usr/local/bin/headroom-lite\n');
        if (command.includes('ps -p 5150 -o ppid=')) return Buffer.from('999\n');
        if (command.includes('ps -p 999 -o command=')) return Buffer.from('/bin/sh /Users/alice/.myelin/state/headroom-lite/start-headroom-lite.sh\n');
        return Buffer.from('');
      },
      existsSyncImpl: () => true,
      readFileSyncImpl: () => '5150\n',
      unlinkSyncImpl: () => {},
      stopPidImpl: (pid) => killed.push(pid),
      waitImpl: async () => {},
      binaryPath: '/usr/local/bin/headroom-lite',
    });

    assert.equal(result.stopped, true);
    assert.equal(result.conflict, false);
    assert.deepEqual(killed, [5150]);
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

describe('defaultRestartMitm', () => {
  for (const os of ['darwin', 'linux', 'windows']) {
    it(`reinstalls the mitm service definition for ${os} with the selected engine port`, async () => {
      const installs = [];
      await defaultRestartMitm({
        os,
        cfg: {
          proxy: {
            engine: 'headroom_lite',
            headroom: { port: 8787, corporate_proxy: 'http://corp-proxy:8080' },
            headroom_lite: { port: 8790 },
            mitm: { port: 8888, egress_port: 8889, block_bypass: true },
            copilot_headroom: { enabled: true, port: 8788 },
            windows_service: { manager: 'registry' },
          },
        },
        winManager: 'registry',
        homedirImpl: () => '/Users/alice',
        detectMitmdumpImpl: () => '/usr/local/bin/mitmdump',
        installMitmServiceImpl: async (opts) => installs.push(opts),
        log: () => {},
        warn: () => {},
      });

      assert.equal(installs.length, 1);
      assert.equal(installs[0].port, 8888);
      assert.equal(installs[0].egressPort, 8889);
      assert.equal(installs[0].manager, 'registry');
      assert.equal(installs[0].mitmdumpBin, '/usr/local/bin/mitmdump');
      assert.equal(installs[0].envVars.MYELIN_HEADROOM_PORT, '8790');
      assert.equal(installs[0].envVars.MYELIN_COPILOT_HEADROOM_PORT, '8788');
      assert.equal(installs[0].envVars.MYELIN_BLOCK_BYPASS, '1');
    });
  }
});
