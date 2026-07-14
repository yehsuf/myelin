import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { win32 as pathWin32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCopilotHeadroomServiceInstallOptions } from '../src/install.mjs';
import {
  buildCopilotHeadroomTaskEnv,
  buildManagedHeadroomEnv,
  defaultStopManagedCopilotHeadroomProcess,
  defaultRestartCopilotHeadroom,
  defaultRestartManagedHeadroom,
  defaultRestartMitm,
  defaultRestartWatchdog,
  headroomLiteLauncherPath,
  restartEngineInstance,
  restartHeadroomLite,
  runRestart,
  stopManagedHeadroomLite,
} from '../src/cli/restart.mjs';
import {
  installWatchdog as installWindowsWatchdog,
  normalizeWindowsFilesystemPath,
  removeEngineInstance as removeWindowsEngineInstance,
} from '../src/service/windows.mjs';

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

describe('defaultRestartCopilotHeadroom', () => {
  for (const { os, winManager } of [
    { os: 'darwin', winManager: 'registry' },
    { os: 'linux', winManager: 'registry' },
    { os: 'windows', winManager: 'winsw' },
  ]) {
    it(`reinstalls fresh service definitions on ${os}${os === 'windows' ? ' WinSW' : ''} when port, mode, or egress change`, async () => {
      const installs = [];

      await defaultRestartCopilotHeadroom({
        os,
        cfg: {
          proxy: {
            mitm: { egress_port: 9898 },
            copilot_headroom: {
              enabled: true,
              port: 9797,
              mode: 'observe',
            },
            windows_service: { manager: winManager },
          },
        },
        winManager,
        log: () => {},
        warn: () => {},
        homedirImpl: () => os === 'windows' ? 'C:\\Users\\alice' : '/Users/alice',
        headroomBinPathImpl: () => os === 'windows'
          ? 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe'
          : '/Users/alice/.myelin/bin/headroom',
        installCopilotHeadroomServiceImpl: async (opts) => {
          installs.push(opts);
        },
      });

      assert.equal(installs.length, 1);
      assert.deepEqual(installs[0], buildCopilotHeadroomServiceInstallOptions({
        cfg: {
          proxy: {
            mitm: { egress_port: 9898 },
            copilot_headroom: {
              enabled: true,
              port: 9797,
              mode: 'observe',
            },
            windows_service: { manager: winManager },
          },
        },
        headroomBin: os === 'windows'
          ? 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe'
          : '/Users/alice/.myelin/bin/headroom',
        home: os === 'windows' ? 'C:\\Users\\alice' : '/Users/alice',
        manager: winManager,
      }));
    });
  }

  it('rebuilds the registry launcher from current config and stops the previous managed instance before spawn', async () => {
    const actions = [];
    const oldRunValue = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.myelin\\headroom-copilot-8788\\start-copilot-headroom.ps1"';

    await defaultRestartCopilotHeadroom({
      os: 'windows',
      cfg: {
        proxy: {
          mitm: { egress_port: 9898 },
          copilot_headroom: {
            enabled: true,
            port: 9797,
            mode: 'observe',
          },
        },
      },
      winManager: 'registry',
      log: () => {},
      warn: () => {},
      execSyncImpl: () => Buffer.from(`${oldRunValue}\n`),
      homedirImpl: () => 'C:\\Users\\alice',
      headroomBinPathImpl: () => 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe',
      stopManagedCopilotHeadroomProcessImpl: (opts) => actions.push({ type: 'stop', opts }),
      waitImpl: async () => {},
      persistCopilotHeadroomLauncherImpl: (opts) => {
        actions.push({ type: 'persist', opts });
        return {
          exe: 'powershell.exe',
          args: '-NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.myelin\\headroom-copilot-9797\\start-copilot-headroom.ps1"',
        };
      },
      spawnDetachedServiceImpl: (taskName, exe, args) => actions.push({ type: 'spawn', taskName, exe, args }),
    });

    assert.equal(actions.length, 3);
    assert.equal(actions[0].type, 'stop');
    assert.equal(actions[0].opts.runKeyValue, oldRunValue);
    assert.equal(typeof actions[0].opts.execSyncImpl, 'function');
    assert.deepEqual(actions[1], {
      type: 'persist',
      opts: {
        headroomBin: 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe',
        argStr: 'proxy --port 9797 --mode observe --connect-timeout-seconds 10',
        execSyncImpl: actions[1].opts.execSyncImpl,
        taskEnv: buildCopilotHeadroomTaskEnv({
          home: 'C:\\Users\\alice',
          copilotPort: 9797,
          egressPort: 9898,
          mode: 'observe',
        }),
      },
    });
    assert.deepEqual(actions[2], {
      type: 'spawn',
      taskName: 'MyelinCopilotHeadroom',
      exe: 'powershell.exe',
      args: '-NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.myelin\\headroom-copilot-9797\\start-copilot-headroom.ps1"',
    });
  });

  it('writes a PowerShell here-string with a valid closing delimiter', async () => {
    const commands = [];

    await defaultRestartCopilotHeadroom({
      os: 'windows',
      cfg: {
        proxy: {
          mitm: { egress_port: 8889 },
          copilot_headroom: { enabled: true, port: 8788, mode: 'cache' },
        },
      },
      winManager: 'registry',
      log: () => {},
      warn: () => {},
      execSyncImpl: (command) => {
        commands.push(command);
        return Buffer.from('');
      },
      homedirImpl: () => 'C:\\Users\\alice',
      headroomBinPathImpl: () => 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe',
      waitImpl: async () => {},
      spawnDetachedServiceImpl: () => {},
    });

    const persistCommand = commands.find((command) => command.includes("Set-Content -Path 'C:\\Users\\alice\\.myelin\\headroom-copilot-8788\\start-copilot-headroom.ps1'"));
    assert.ok(persistCommand);
    assert.match(persistCommand, /-Value @'\n[\s\S]*\n'@ -Encoding UTF8/);
    assert.doesNotMatch(persistCommand, /\n@' -Encoding UTF8/);
  });

  it('resolves a WSL home to the Windows launcher path before rebuilding the registry launcher', async () => {
    const actions = [];
    await defaultRestartCopilotHeadroom({
      os: 'windows',
      cfg: {
        proxy: {
          mitm: { egress_port: 8889 },
          copilot_headroom: {
            enabled: true,
            port: 8788,
            mode: 'cache',
          },
        },
      },
      winManager: 'registry',
      log: () => {},
      warn: () => {},
      execSyncImpl: () => Buffer.from(''),
      homedirImpl: () => '/home/alice',
      defaultWindowsHomeImpl: () => 'C:\\Users\\alice',
      headroomBinPathImpl: () => 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe',
      stopManagedCopilotHeadroomProcessImpl: (opts) => actions.push({ type: 'stop', opts }),
      waitImpl: async () => {},
      persistCopilotHeadroomLauncherImpl: (opts) => {
        actions.push({ type: 'persist', opts });
        return {
          exe: 'powershell.exe',
          args: '-NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.myelin\\headroom-copilot-8788\\start-copilot-headroom.ps1"',
        };
      },
      spawnDetachedServiceImpl: (taskName, exe, args) => actions.push({ type: 'spawn', taskName, exe, args }),
    });

    assert.equal(actions[1].type, 'persist');
    assert.deepEqual(actions[1].opts.taskEnv, buildCopilotHeadroomTaskEnv({
      home: 'C:\\Users\\alice',
      copilotPort: 8788,
      egressPort: 8889,
      mode: 'cache',
    }));
  });
});

describe('defaultStopManagedCopilotHeadroomProcess', () => {
  it('reads a Windows launcher via PowerShell when the run-key path is not locally accessible', async () => {
    const commands = [];
    let stopCall = null;
    const stopped = await defaultStopManagedCopilotHeadroomProcess({
      runKeyValue: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.myelin\\headroom-copilot-8788\\start-copilot-headroom.ps1"',
      execSyncImpl: (command) => {
        commands.push(command);
        if (command.includes('Get-Content -Path')) {
          return Buffer.from([
            "# Managed by myelin. Keeps Copilot-Headroom env scoped to this process tree.",
            "Start-Process -FilePath 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe' -ArgumentList 'proxy --port 8788 --mode cache --connect-timeout-seconds 10' -WorkingDirectory 'C:\\Users\\alice\\.myelin\\headroom-copilot-8788' -WindowStyle Hidden",
          ].join('\n'));
        }
        return Buffer.from('');
      },
      existsSyncImpl: () => false,
      readFileSyncImpl: () => {
        throw new Error('should not read a Windows path with local fs');
      },
      stopHeadroomProcessByExecutablePathImpl: (opts) => {
        stopCall = opts;
      },
    });

    assert.equal(stopped, true);
    assert.equal(stopCall.port, 8788);
    assert.equal(stopCall.executablePath, 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe');
    assert.ok(commands.some((command) => command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\headroom-copilot-8788\\start-copilot-headroom.ps1' -Raw")));
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
      stopObsoleteOwnedInstancesImpl: async ({ instances }) => {
        calls.push(...instances.map((instance) => `stop:${instance.id}`));
      },
      removeDisabledCopilotInstanceImpl: async () => {},
      restartEngineInstanceImpl: async (instance) => calls.push(instance.id),
      restartMitmImpl: async () => calls.push('mitm'),
      restartWatchdogImpl: async () => {},
      log: () => {},
      warn: () => {},
    });

    assert.deepEqual(calls, ['stop:headroom_lite-primary', 'stop:headroom_lite-copilot', 'headroom-primary', 'mitm']);
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
      stopObsoleteOwnedInstancesImpl: async ({ instances }) => {
        calls.push(...instances.map((instance) => `stop:${instance.id}`));
      },
      removeDisabledCopilotInstanceImpl: async () => {},
      restartEngineInstanceImpl: async (instance) => {
        calls.push(instance.id);
        return true;
      },
      restartMitmImpl: async () => calls.push('mitm'),
      restartWatchdogImpl: async () => {},
      log: () => {},
      warn: () => {},
    });

    assert.deepEqual(calls, ['stop:headroom-primary', 'stop:headroom-copilot', 'headroom_lite-primary', 'mitm']);
  });

  it('keeps Python Headroom disabled when headroom-lite fails to start and still refreshes downstream services', async () => {
    const calls = [];
    const warnings = [];

    await runRestart({
      config: {
        ...baseConfig,
        proxy: {
          ...baseConfig.proxy,
          engine: 'headroom_lite',
          headroom: { enabled: false, port: 8787 },
          headroom_lite: { enabled: true, port: 8790 },
          mitm: { enabled: true, port: 8888 },
          copilot_headroom: { enabled: true, port: 8788 },
        },
      },
      detectOSImpl: () => 'linux',
      stopObsoleteOwnedInstancesImpl: async ({ instances }) => {
        calls.push(...instances.map((instance) => `stop:${instance.id}`));
      },
      restartEngineInstanceImpl: async (instance) => {
        calls.push(`lite:${instance.role}`);
        return false;
      },
      restartMitmImpl: async () => calls.push('mitm'),
      restartWatchdogImpl: async () => calls.push('watchdog'),
      log: () => {},
      warn: (message) => warnings.push(message),
    });

    assert.deepEqual(calls, [
      'stop:headroom-primary',
      'stop:headroom-copilot',
      'lite:primary',
      'lite:copilot',
      'mitm',
      'watchdog',
    ]);
    assert.deepEqual(warnings, []);
  });
});

describe('runRestart descriptor plan', () => {
  it('restarts selected Lite instances before MITM without reviving Python', async () => {
    const order = [];

    await runRestart({
      config: {
        proxy: {
          engine: 'headroom_lite',
          headroom: { port: 8787 },
          headroom_lite: { port: 8790 },
          mitm: { enabled: true, port: 8888, egress_port: 8889 },
          copilot_headroom: { enabled: true, port: 8788 },
          windows_service: { manager: 'registry' },
        },
      },
      detectOSImpl: () => 'linux',
      stopObsoleteEngineImpl: () => assert.fail('legacy engine stop must not run'),
      restartHeadroomLiteImpl: () => assert.fail('Lite must restart through its descriptor'),
      restartManagedHeadroomImpl: () => assert.fail('Python must not restart'),
      restartCopilotHeadroomImpl: () => assert.fail('Copilot must restart through its descriptor'),
      stopObsoleteOwnedInstancesImpl: async ({ instances }) => {
        order.push(...instances.map((instance) => `stop:${instance.role}`));
      },
      restartEngineInstanceImpl: async (instance) => {
        order.push(instance.role);
        return true;
      },
      restartMitmImpl: async () => order.push('mitm'),
      restartWatchdogImpl: async () => {},
      log: () => {},
      warn: () => {},
    });

    assert.deepEqual(order, ['stop:primary', 'stop:copilot', 'primary', 'copilot', 'mitm']);
  });

  it('installs and waits on every descriptor health URL through generic adapters', async () => {
    const calls = [];

    await runRestart({
      config: {
        proxy: {
          engine: 'headroom',
          headroom: { port: 9787 },
          mitm: { enabled: true, port: 9888 },
          copilot_headroom: { enabled: false, port: 9788 },
          windows_service: { manager: 'registry' },
        },
      },
      detectOSImpl: () => 'linux',
      stopObsoleteEngineImpl: () => assert.fail('legacy engine stop must not run'),
      stopObsoleteOwnedInstancesImpl: async () => {},
      removeDisabledCopilotInstanceImpl: async () => {},
      removeEngineInstanceImpl: async (instance) => {
        calls.push(`remove:${instance.id}`);
      },
      installEngineInstanceImpl: async (instance, options) => {
        calls.push(`install:${instance.id}:${options.headroomBin}`);
      },
      headroomBinPathImpl: () => '/opt/myelin/headroom',
      waitForHealthUrlImpl: async (healthUrl) => {
        calls.push(`health:${healthUrl}`);
        return true;
      },
      restartMitmImpl: async () => calls.push('mitm'),
      restartWatchdogImpl: async () => {},
      log: () => {},
      warn: () => {},
    });

    assert.deepEqual(calls, [
      'remove:headroom-primary',
      'install:headroom-primary:/opt/myelin/headroom',
      'health:http://127.0.0.1:9787/health',
      'mitm',
    ]);
  });

  it('does not restart a Copilot descriptor when compression is disabled', async () => {
    const restarted = [];
    const removedPlans = [];

    await runRestart({
      config: {
        proxy: {
          engine: 'headroom',
          compression: { enabled: false },
          headroom: { port: 8787 },
          copilot_headroom: { enabled: true, port: 8788 },
          mitm: { enabled: true, port: 8888, egress_port: 8889 },
          windows_service: { manager: 'registry' },
        },
      },
      detectOSImpl: () => 'linux',
      stopObsoleteOwnedInstancesImpl: async () => {},
      removeDisabledCopilotInstanceImpl: async ({ plan }) => removedPlans.push(plan.instances),
      restartEngineInstanceImpl: async (instance) => restarted.push(instance.id),
      restartMitmImpl: async () => {},
      restartWatchdogImpl: async () => {},
      log: () => {},
      warn: () => {},
    });

    assert.deepEqual(restarted, ['headroom-primary']);
    assert.deepEqual(removedPlans[0].map(({ id }) => id), ['headroom-primary']);
  });

  describe('restartEngineInstance WSL executable resolution', () => {
    for (const {
      engine,
      binaryKey,
      candidate,
      resolved,
    } of [
      {
        engine: 'headroom',
        binaryKey: 'headroomBin',
        candidate: '/home/alice/.myelin/venv/bin/headroom',
        resolved: 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\headroom.exe',
      },
      {
        engine: 'headroom_lite',
        binaryKey: 'headroomLiteBin',
        candidate: '/home/alice/.local/bin/headroom-lite',
        resolved: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\headroom-lite.cmd',
      },
    ]) {
      it(`uses a Windows ${engine} executable instead of a \\\\home path`, async () => {
        const resolverCalls = [];
        const installed = [];
        const instance = {
          engine,
          role: 'primary',
          id: `${engine}-primary`,
          port: engine === 'headroom' ? 8787 : 8790,
          stateDir: `C:\\Users\\alice\\.myelin\\state\\${engine}-primary`,
          logPath: `C:\\Users\\alice\\.myelin\\${engine}-primary.log`,
          healthUrl: `http://127.0.0.1:${engine === 'headroom' ? 8787 : 8790}/health`,
          env: {},
        };

        const restarted = await restartEngineInstance(instance, {
          os: 'windows',
          winManager: 'winsw',
          home: '/home/alice',
          isWslImpl: () => true,
          defaultWindowsHomeImpl: () => 'C:\\Users\\alice',
          resolveWindowsServiceExecutableImpl: (options) => {
            resolverCalls.push(options);
            return resolved;
          },
          headroomBinPathImpl: () => candidate,
          detectToolImpl: async () => ({ installed: true, path: candidate }),
          removeEngineInstanceImpl: async () => {},
          installEngineInstanceImpl: async (_instance, options) => installed.push(options),
          waitForHealthUrlImpl: async () => true,
          log: () => {},
          warn: () => {},
        });

        assert.equal(restarted, true);
        assert.deepEqual(resolverCalls, [{
          engine,
          candidate,
          serviceHome: 'C:\\Users\\alice',
          servicePlatform: 'windows',
          wsl: true,
        }]);
        assert.equal(installed[0][binaryKey], resolved);
        assert.ok(!installed[0][binaryKey].startsWith('\\home'));
      });
    }
  });

  it('keeps Python Copilot restart env scoped to its descriptor loopback targets', async () => {
    const installed = [];
    const instance = {
      engine: 'headroom',
      role: 'copilot',
      id: 'headroom-copilot',
      port: 9788,
      stateDir: '/Users/alice/.myelin/state/headroom-copilot',
      logPath: '/Users/alice/.myelin/headroom-copilot.log',
      healthUrl: 'http://127.0.0.1:9788/health',
      env: {
        ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889',
        OPENAI_TARGET_API_URL: 'http://127.0.0.1:8889',
        HEADROOM_MODE: 'observe',
        NO_PROXY: '127.0.0.1,localhost,::1',
      },
    };

    const restarted = await restartEngineInstance(instance, {
      os: 'linux',
      cfg: {
        proxy: {
          headroom: {
            port: 8787,
            openai_target_url: 'https://api.githubcopilot.com',
            mode: 'cache',
          },
        },
      },
      home: '/Users/alice',
      headroomBinPathImpl: () => '/opt/myelin/headroom',
      removeEngineInstanceImpl: async () => {},
      installEngineInstanceImpl: async (installedInstance, options) => installed.push({ installedInstance, options }),
      waitForHealthUrlImpl: async () => true,
      log: () => {},
      warn: () => {},
    });

    assert.equal(restarted, true);
    assert.equal(installed[0].options.envVars.HEADROOM_PORT, undefined);
    assert.equal(installed[0].options.envVars.OPENAI_TARGET_API_URL, undefined);
    assert.deepEqual(installed[0].installedInstance.env, instance.env);
  });

  it('passes only connection env to a primary Lite descriptor restart', async () => {
    const installed = [];
    const originalCa = process.env.SSL_CERT_FILE;
    process.env.SSL_CERT_FILE = 'C:\\ProgramData\\Corp\\ca.pem';
    try {
      const restarted = await restartEngineInstance({
        engine: 'headroom_lite',
        role: 'primary',
        id: 'headroom_lite-primary',
        port: 8790,
        stateDir: '/Users/alice/.myelin/state/headroom_lite-primary',
        logPath: '/Users/alice/.myelin/headroom_lite-primary.log',
        healthUrl: 'http://127.0.0.1:8790/health',
        env: {},
      }, {
        os: 'linux',
        cfg: {
          proxy: {
            headroom: {
              port: 8787,
              openai_target_url: 'https://api.githubcopilot.com',
              mode: 'cache',
              corporate_proxy: 'http://corp-proxy:8080',
            },
          },
        },
        home: '/Users/alice',
        detectToolImpl: async () => ({ installed: true, path: '/opt/myelin/headroom-lite' }),
        removeEngineInstanceImpl: async () => {},
        installEngineInstanceImpl: async (_instance, options) => installed.push(options),
        waitForHealthUrlImpl: async () => true,
        log: () => {},
        warn: () => {},
      });

      assert.equal(restarted, true);
      assert.equal(installed[0].envVars.HTTPS_PROXY, 'http://corp-proxy:8080');
      assert.equal(installed[0].envVars.SSL_CERT_FILE, 'C:\\ProgramData\\Corp\\ca.pem');
      assert.equal(installed[0].envVars.HEADROOM_PORT, undefined);
      assert.equal(installed[0].envVars.OPENAI_TARGET_API_URL, undefined);
      assert.equal(installed[0].envVars.HEADROOM_MODE, undefined);
    } finally {
      if (originalCa === undefined) delete process.env.SSL_CERT_FILE;
      else process.env.SSL_CERT_FILE = originalCa;
    }
  });

  it('removes the disabled same-engine Copilot role through the generic owner', async () => {
    const removed = [];

    await runRestart({
      config: {
        proxy: {
          engine: 'headroom_lite',
          headroom: { port: 8787 },
          headroom_lite: { port: 8790 },
          mitm: { enabled: true, port: 8888 },
          copilot_headroom: { enabled: false, port: 8788 },
          windows_service: { manager: 'winsw' },
        },
      },
      detectOSImpl: () => 'windows',
      stopObsoleteOwnedInstancesImpl: async () => {},
      removeEngineInstanceImpl: async (instance, options) => removed.push({ instance, options }),
      restartEngineInstanceImpl: async () => true,
      restartMitmImpl: async () => {},
      restartWatchdogImpl: async () => {},
      log: () => {},
      warn: () => {},
    });

    assert.deepEqual(removed.map(({ instance, options }) => ({
      id: instance.id,
      engine: instance.engine,
      role: instance.role,
      manager: options.manager,
    })), [{
      id: 'headroom_lite-copilot',
      engine: 'headroom_lite',
      role: 'copilot',
      manager: 'winsw',
    }]);
  });

  it('skips an obsolete role with an invalid stale port without blocking the active restart', async () => {
    const restarted = [];
    const warnings = [];

    await runRestart({
      config: {
        proxy: {
          engine: 'headroom',
          headroom: { port: 9787 },
          headroom_lite: { port: '' },
          mitm: { enabled: true, port: 9888 },
          copilot_headroom: { enabled: false },
          windows_service: { manager: 'winsw' },
        },
      },
      detectOSImpl: () => 'windows',
      removeEngineInstanceImpl: async () => {},
      restartEngineInstanceImpl: async (instance) => restarted.push(instance.id),
      restartMitmImpl: async () => {},
      restartWatchdogImpl: async () => {},
      log: () => {},
      warn: (message) => warnings.push(message),
    });

    assert.deepEqual(restarted, ['headroom-primary']);
    assert.ok(warnings.some((message) => message.includes('headroom_lite-primary')));
  });

  for (const {
    label,
    headroomPort,
    copilotPort,
    config,
  } of [
    {
      label: 'default ports',
      headroomPort: 8787,
      copilotPort: 8788,
      config: {
        proxy: {
          engine: 'headroom_lite',
          headroom_lite: { port: 8790 },
          mitm: { enabled: true, port: 8888 },
          copilot_headroom: { enabled: false },
          windows_service: { manager: 'winsw' },
        },
      },
    },
    {
      label: 'custom normalized ports',
      headroomPort: 9787,
      copilotPort: 9788,
      config: {
        proxy: {
          engine: 'headroom_lite',
          headroom: { port: '9787' },
          headroom_lite: { port: 9790 },
          mitm: { enabled: true, port: 9888 },
          copilot_headroom: { enabled: false, port: '9788' },
          windows_service: { manager: 'winsw' },
        },
      },
    },
  ]) {
    it(`removes obsolete and disabled Windows roles with ${label}`, async () => {
      const removed = [];

      await runRestart({
        config,
        detectOSImpl: () => 'windows',
        removeEngineInstanceImpl: (instance, options) => {
          const expectedPort = instance.role === 'primary' ? headroomPort : copilotPort;
          const portIdentity = instance.engine === 'headroom_lite'
            ? `<env name="HEADROOM_LITE_PORT" value="${expectedPort}"/>`
            : `<arguments>proxy --port ${expectedPort}</arguments>`;
          return removeWindowsEngineInstance(instance, {
            ...options,
            existsSyncImpl: () => true,
            readFileSyncImpl: () => [
              '<service>',
              `  <id>${instance.id}</id>`,
              `  <workingdirectory>${instance.stateDir.replaceAll('/', '\\')}</workingdirectory>`,
              `  ${portIdentity}`,
              `  <executable>C:\\Users\\alice\\.myelin\\bin\\${instance.engine === 'headroom_lite' ? 'headroom-lite.exe' : 'headroom.exe'}</executable>`,
              '</service>',
            ].join('\n'),
            uninstallWinswServiceImpl: ({ id }) => {
              removed.push(id);
              return true;
            },
            uninstallWindowsWatchdogTaskImpl: () => {},
            runPsFn: () => {},
          });
        },
        restartEngineInstanceImpl: async () => true,
        restartMitmImpl: async () => {},
        restartWatchdogImpl: async () => {},
        log: () => {},
        warn: () => {},
      });

      assert.deepEqual(removed, [
        'headroom-primary',
        'headroom-copilot',
        'headroom_lite-copilot',
      ]);
    });
  }
});

describe('Windows descriptor watchdogs', () => {
  const instances = [
    {
      engine: 'headroom_lite',
      role: 'primary',
      id: 'headroom_lite-primary',
      port: 8790,
      stateDir: 'C:\\Users\\alice\\.myelin\\state\\headroom_lite-primary',
      logPath: 'C:\\Users\\alice\\.myelin\\headroom_lite-primary.log',
      healthUrl: 'http://127.0.0.1:8790/health',
      env: {},
    },
    {
      engine: 'headroom_lite',
      role: 'copilot',
      id: 'headroom_lite-copilot',
      port: 8788,
      stateDir: 'C:\\Users\\alice\\.myelin\\state\\headroom_lite-copilot',
      logPath: 'C:\\Users\\alice\\.myelin\\headroom_lite-copilot.log',
      healthUrl: 'http://127.0.0.1:8788/health',
      env: {},
    },
  ];

  it('installs a watchdog for each selected descriptor ID', () => {
    const installed = [];

    installWindowsWatchdog({
      home: 'C:\\Users\\alice',
      enabled: true,
      instances,
      intervalMinutes: 5,
      installWindowsWatchdogTaskImpl: (options) => {
        installed.push(options);
        return options;
      },
      uninstallWindowsWatchdogTaskImpl: () => assert.fail('selected roles must not be removed'),
    });

    assert.deepEqual(installed.map(({ id, healthUrl }) => ({ id, healthUrl })), [
      { id: 'headroom_lite-primary', healthUrl: 'http://127.0.0.1:8790/health' },
      { id: 'headroom_lite-copilot', healthUrl: 'http://127.0.0.1:8788/health' },
    ]);
  });

  it('removes every selected descriptor watchdog when disabled', () => {
    const removed = [];

    installWindowsWatchdog({
      home: 'C:\\Users\\alice',
      enabled: false,
      instances,
      uninstallWindowsWatchdogTaskImpl: (options) => removed.push(options),
    });

    assert.deepEqual(removed.map(({ id }) => id), [
      'headroom_lite-primary',
      'headroom_lite-copilot',
    ]);
  });

  it('removes a matching descriptor-owned WinSW service and watchdog by descriptor ID', () => {
    const removedServices = [];
    const removedWatchdogs = [];
    const instance = instances[1];

    const removed = removeWindowsEngineInstance(instance, {
      manager: 'winsw',
      home: 'C:\\Users\\alice',
      existsSyncImpl: () => true,
      readFileSyncImpl: () => [
        '<service>',
        '  <id>headroom_lite-copilot</id>',
        '  <workingdirectory>C:\\Users\\alice\\.myelin\\state\\headroom_lite-copilot</workingdirectory>',
        '  <env name="HEADROOM_LITE_PORT" value="8788"/>',
        '  <executable>C:\\Users\\alice\\.myelin\\bin\\headroom-lite.exe</executable>',
        '</service>',
      ].join('\n'),
      uninstallWinswServiceImpl: (options) => {
        removedServices.push(options);
        return true;
      },
      uninstallWindowsWatchdogTaskImpl: (options) => removedWatchdogs.push(options),
      runPsFn: () => {},
    });

    assert.equal(removed, true);
    assert.deepEqual(removedServices.map(({ id, home }) => ({ id, home })), [
      { id: 'headroom_lite-copilot', home: 'C:\\Users\\alice' },
    ]);
    assert.deepEqual(removedWatchdogs.map(({ id, home }) => ({ id, home })), [
      { id: 'headroom_lite-copilot', home: 'C:\\Users\\alice' },
      { id: 'myelin-copilot-headroom', home: 'C:\\Users\\alice' },
    ]);
    assert.ok([...removedServices, ...removedWatchdogs].every(({ isWslImpl }) => typeof isWslImpl === 'function'));
  });

  it('removes the owned legacy role registration and watchdog during descriptor migration', () => {
    const removedServices = [];
    const removedWatchdogs = [];
    const instance = instances[1];

    removeWindowsEngineInstance(instance, {
      manager: 'winsw',
      home: 'C:\\Users\\alice',
      existsSyncImpl: () => true,
      readFileSyncImpl: (path) => {
        const legacy = String(path).includes('myelin-copilot-headroom');
        const id = legacy ? 'myelin-copilot-headroom' : 'headroom_lite-copilot';
        return [
          '<service>',
          `  <id>${id}</id>`,
          legacy
            ? '  <workingdirectory>C:\\Users\\alice\\.myelin\\copilot-headroom</workingdirectory>'
            : '  <workingdirectory>C:\\Users\\alice\\.myelin\\state\\headroom_lite-copilot</workingdirectory>',
          legacy
            ? '  <arguments>proxy --port 8788</arguments>'
            : '  <env name="HEADROOM_LITE_PORT" value="8788"/>',
          legacy
            ? '  <executable>C:\\Users\\alice\\.myelin\\bin\\headroom.exe</executable>'
            : '  <executable>C:\\Users\\alice\\.myelin\\bin\\headroom-lite.exe</executable>',
          '</service>',
        ].join('\n');
      },
      uninstallWinswServiceImpl: (options) => {
        removedServices.push(options);
        return true;
      },
      uninstallWindowsWatchdogTaskImpl: (options) => removedWatchdogs.push(options),
      runPsFn: () => {},
    });

    assert.deepEqual(removedServices.map(({ id }) => id), [
      'headroom_lite-copilot',
      'myelin-copilot-headroom',
    ]);
    assert.deepEqual(removedWatchdogs.map(({ id }) => id), [
      'headroom_lite-copilot',
      'myelin-copilot-headroom',
    ]);
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
    const home = '/Users/alice';
    const launcherPath = headroomLiteLauncherPath({ home, osKind: 'linux' });
    const result = await stopManagedHeadroomLite({
      port: 8790,
      osKind: 'linux',
      home,
      execSyncImpl: (command) => {
        if (command.includes('lsof -nP -tiTCP:8790')) return Buffer.from('5150\n');
        if (command.includes('ps -p 5150 -o command=')) return Buffer.from('/usr/local/bin/headroom-lite\n');
        if (command.includes('ps -p 5150 -o ppid=')) return Buffer.from('999\n');
        if (command.includes('ps -p 999 -o command=')) return Buffer.from(`/bin/sh ${launcherPath}\n`);
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

  it('clears a stale reused pid without killing when only the executable/port match remains', async () => {
    const killed = [];
    let unlinked = 0;
    const result = await stopManagedHeadroomLite({
      port: 8790,
      osKind: 'linux',
      home: '/Users/alice',
      execSyncImpl: (command) => {
        if (command.includes('lsof -nP -tiTCP:8790')) return Buffer.from('5150\n');
        if (command.includes('ps -p 5150 -o command=')) return Buffer.from('/usr/local/bin/headroom-lite\n');
        if (command.includes('ps -p 5150 -o ppid=')) return Buffer.from('999\n');
        if (command.includes('ps -p 999 -o command=')) return Buffer.from('/bin/sh /opt/other-service.sh\n');
        return Buffer.from('');
      },
      existsSyncImpl: () => true,
      readFileSyncImpl: () => '5150\n',
      unlinkSyncImpl: () => { unlinked += 1; },
      stopPidImpl: (pid) => killed.push(pid),
      waitImpl: async () => {},
      binaryPath: '/usr/local/bin/headroom-lite',
    });

    assert.equal(result.stopped, false);
    assert.equal(result.conflict, true);
    assert.equal(result.reason, 'headroom-lite port 8790 is owned by an unmanaged process (pid 5150)');
    assert.deepEqual(killed, []);
    assert.equal(unlinked, 1);
  });

  it('stops the recorded managed pid before replacing state when the configured Lite port changes', async () => {
    const killed = [];
    let unlinked = 0;
    const home = '/Users/alice';
    const launcherPath = headroomLiteLauncherPath({ home, osKind: 'linux' });
    const result = await stopManagedHeadroomLite({
      port: 8791,
      osKind: 'linux',
      home,
      execSyncImpl: (command) => {
        if (command.includes('lsof -nP -tiTCP:8791')) return Buffer.from('');
        if (command.includes('ps -p 5150 -o command=')) return Buffer.from('/usr/local/bin/headroom-lite\n');
        if (command.includes('ps -p 5150 -o ppid=')) return Buffer.from('999\n');
        if (command.includes('ps -p 999 -o command=')) return Buffer.from(`/bin/sh ${launcherPath}\n`);
        return Buffer.from('');
      },
      existsSyncImpl: () => true,
      readFileSyncImpl: () => '5150\n',
      unlinkSyncImpl: () => { unlinked += 1; },
      stopPidImpl: (pid) => killed.push(pid),
      waitImpl: async () => {},
      binaryPath: '/usr/local/bin/headroom-lite',
    });

    assert.equal(result.stopped, true);
    assert.equal(result.conflict, false);
    assert.deepEqual(killed, [5150]);
    assert.equal(unlinked, 1);
  });

  it('clears a stale reused pid without killing when the tracked process moved off-port', async () => {
    const killed = [];
    let unlinked = 0;
    const result = await stopManagedHeadroomLite({
      port: 8791,
      osKind: 'linux',
      home: '/Users/alice',
      execSyncImpl: (command) => {
        if (command.includes('lsof -nP -tiTCP:8791')) return Buffer.from('');
        if (command.includes('ps -p 5150 -o command=')) return Buffer.from('/usr/local/bin/headroom-lite\n');
        if (command.includes('ps -p 5150 -o ppid=')) return Buffer.from('999\n');
        if (command.includes('ps -p 999 -o command=')) return Buffer.from('/bin/sh /opt/other-service.sh\n');
        return Buffer.from('');
      },
      existsSyncImpl: () => true,
      readFileSyncImpl: () => '5150\n',
      unlinkSyncImpl: () => { unlinked += 1; },
      stopPidImpl: (pid) => killed.push(pid),
      waitImpl: async () => {},
      binaryPath: '/usr/local/bin/headroom-lite',
    });

    assert.equal(result.stopped, false);
    assert.equal(result.conflict, false);
    assert.equal(result.running, false);
    assert.deepEqual(killed, []);
    assert.equal(unlinked, 1);
  });

  it('reads and matches WSL-managed Windows Lite state without emitting mnt paths during cleanup', async () => {
    const commands = [];
    const killed = [];
    const result = await stopManagedHeadroomLite({
      port: 8790,
      osKind: 'windows',
      home: '/mnt/c/Users/alice',
      execSyncImpl: (command) => {
        commands.push(command);
        if (command.includes('Get-Command headroom-lite')) return Buffer.from('/mnt/c/Users/alice/.myelin/bin/headroom-lite.exe\n');
        if (command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\state\\headroom-lite\\headroom-lite.pid'")) return Buffer.from('5150\n');
        if (command.includes('Get-NetTCPConnection -State Listen -LocalPort 8790')) return Buffer.from('5150\n');
        if (command.includes('ProcessId = 5150')) {
          return Buffer.from(JSON.stringify({
            command: 'C:\\Users\\alice\\.myelin\\bin\\headroom-lite.exe',
            executablePath: 'C:\\Users\\alice\\.myelin\\bin\\headroom-lite.exe',
            parentCommand: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.myelin\\state\\headroom-lite\\start-headroom-lite.ps1"',
            grandparentCommand: '',
          }));
        }
        if (command.includes('Stop-Process -Id 5150')) return Buffer.from('');
        return Buffer.from('');
      },
      existsSyncImpl: () => false,
      readFileSyncImpl: () => {
        throw new Error('should read Windows pid state via PowerShell');
      },
      unlinkSyncImpl: () => {},
      stopPidImpl: (pid) => killed.push(pid),
      waitImpl: async () => {},
      defaultWindowsHomeImpl: () => 'C:\\Users\\alice',
    });

    assert.equal(result.stopped, true);
    assert.equal(result.conflict, false);
    assert.deepEqual(killed, [5150]);
    assert.ok(commands.some((command) => command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\state\\headroom-lite\\headroom-lite.pid'")));
    assert.ok(commands.every((command) => !command.includes('/mnt/c/Users/alice')));
    assert.ok(commands.every((command) => !command.includes('\\mnt\\')));
  });
});

describe('defaultRestartManagedHeadroom', () => {
  for (const { os, winManager, home } of [
    { os: 'darwin', winManager: 'registry', home: '/Users/alice' },
    { os: 'linux', winManager: 'registry', home: '/home/alice' },
    { os: 'windows', winManager: 'winsw', home: 'C:\\Users\\alice' },
  ]) {
    it(`reinstalls fresh ${os === 'windows' ? 'WinSW' : os} service definitions from current config`, async () => {
      const installs = [];
      const cfg = {
        proxy: {
          headroom: {
            port: 9797,
            mode: 'observe',
            corporate_proxy: 'http://corp-proxy:8080',
            openai_target_url: 'https://api.githubcopilot.com',
            intercept_tool_results: true,
          },
        },
      };
 
      await defaultRestartManagedHeadroom({
        os,
        cfg,
        winManager,
        log: () => {},
        warn: () => {},
        homedirImpl: () => home,
        headroomBinPathImpl: () => os === 'windows'
          ? 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe'
          : '/Users/alice/.myelin/bin/headroom',
        managedHeadroomRegistrationStatusImpl: async () => ({ registered: true }),
        installServiceImpl: async (opts) => {
          installs.push(opts);
        },
      });
 
      assert.equal(installs.length, 1);
      assert.equal(installs[0].port, 9797);
      assert.equal(installs[0].home, home);
      assert.equal(installs[0].manager, winManager);
      assert.equal(installs[0].interceptToolResults, true);
      assert.deepEqual(installs[0].envVars, buildManagedHeadroomEnv(cfg));
    });
  }

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

describe('defaultRestartWatchdog', () => {
  it('reinstalls watchdog definitions with current ports instead of a stale Python Headroom target', async () => {
    const installs = [];

    await defaultRestartWatchdog({
      os: 'windows',
      cfg: {
        proxy: {
          engine: 'headroom_lite',
          headroom: { port: 8787 },
          headroom_lite: { port: 8790 },
          mitm: { port: 9888, egress_port: 9889 },
          copilot_headroom: { enabled: true, port: 9788 },
          windows_service: { manager: 'winsw', watchdog_enabled: true, watchdog_interval_minutes: 5 },
        },
      },
      winManager: 'winsw',
      log: () => {},
      warn: () => {},
      homedirImpl: () => 'C:\\Users\\alice',
      installWatchdogImpl: async (opts) => {
        installs.push(opts);
        return true;
      },
    });

    assert.equal(installs.length, 1);
    assert.equal(installs[0].home, 'C:\\Users\\alice');
    assert.equal(installs[0].enabled, true);
    assert.equal(installs[0].intervalMinutes, 5);
    assert.equal(installs[0].headroomPort, 8790); // primary port; Windows ignores this when instances is provided
    assert.equal(installs[0].mitmPort, 9888);
    assert.equal(installs[0].copilotHeadroomPort, 9788);
    assert.equal(installs[0].egressPort, 9889);
    assert.deepEqual(installs[0].instances.map(({ id, role, healthUrl }) => ({ id, role, healthUrl })), [
      { id: 'headroom_lite-primary', role: 'primary', healthUrl: 'http://127.0.0.1:8790/health' },
      { id: 'headroom_lite-copilot', role: 'copilot', healthUrl: 'http://127.0.0.1:9788/health' },
    ]);
  });

  it('passes primary port to launchd watchdog for headroom_lite engine on macOS', async () => {
    const installs = [];

    await defaultRestartWatchdog({
      os: 'darwin',
      cfg: {
        proxy: {
          engine: 'headroom_lite',
          headroom_lite: { port: 8790 },
          mitm: { port: 8888 },
          copilot_headroom: { enabled: false },
          windows_service: { manager: 'winsw', watchdog_enabled: false },
        },
      },
      winManager: 'registry',
      log: () => {},
      warn: () => {},
      homedirImpl: () => '/Users/alice',
      installWatchdogImpl: async (opts) => {
        installs.push(opts);
        return true;
      },
    });

    assert.equal(installs.length, 1);
    assert.equal(installs[0].headroomPort, 8790,
      'launchd watchdog must receive primary port for headroom_lite so it can revive the service');
    assert.equal(installs[0].mitmPort, 8888);
  });

  it('does not retain a Copilot watchdog or egress port when compression is disabled', async () => {
    const installs = [];

    await defaultRestartWatchdog({
      os: 'windows',
      cfg: {
        proxy: {
          engine: 'headroom_lite',
          compression: { enabled: false },
          headroom_lite: { port: 8790 },
          copilot_headroom: { enabled: true, port: 9788 },
          mitm: { port: 8888, egress_port: 8889 },
          windows_service: { manager: 'winsw', watchdog_enabled: true },
        },
      },
      winManager: 'winsw',
      homedirImpl: () => 'C:\\Users\\alice',
      installWatchdogImpl: async (options) => installs.push(options),
      log: () => {},
      warn: () => {},
    });

    assert.deepEqual(installs[0].instances.map(({ id }) => id), ['headroom_lite-primary']);
    assert.equal(installs[0].copilotHeadroomPort, undefined);
    assert.equal(installs[0].egressPort, undefined);
  });

  it('does not hand disabled MITM ports to the watchdog', async () => {
    const installs = [];

    await defaultRestartWatchdog({
      os: 'darwin',
      cfg: {
        proxy: {
          engine: 'headroom',
          headroom: { port: 8787 },
          copilot_headroom: { enabled: false, port: 8788 },
          mitm: { enabled: false, port: 8888, egress_port: 8889 },
          windows_service: { manager: 'registry' },
        },
      },
      winManager: 'registry',
      homedirImpl: () => '/Users/alice',
      installWatchdogImpl: async (options) => installs.push(options),
      log: () => {},
      warn: () => {},
    });

    assert.equal(installs[0].mitmPort, undefined);
    assert.equal(installs[0].egressPort, undefined);
    assert.equal(installs[0].copilotHeadroomPort, undefined);
  });
});

describe('defaultRestartMitm', () => {
  it('removes only the registered Myelin MITM service without probing or recreating it when disabled', async () => {
    const removals = [];

    await defaultRestartMitm({
      os: 'windows',
      cfg: {
        proxy: {
          mitm: { enabled: false, port: 8888, egress_port: 8889 },
          windows_service: { manager: 'winsw' },
        },
      },
      winManager: 'winsw',
      homedirImpl: () => 'C:\\Users\\alice',
      detectMitmdumpImpl: () => assert.fail('disabled MITM must not be probed'),
      installMitmServiceImpl: () => assert.fail('disabled MITM must not be installed'),
      removeMitmServiceImpl: async (options) => removals.push(options),
      log: () => {},
      warn: () => {},
    });

    assert.deepEqual(removals, [{
      os: 'windows',
      manager: 'winsw',
      home: 'C:\\Users\\alice',
    }]);
  });

  for (const os of ['darwin', 'linux', 'windows']) {
    it(`reinstalls the mitm service definition for ${os} with the selected engine port`, async () => {
      const installs = [];
      await defaultRestartMitm({
        os,
        cfg: {
          proxy: {
            engine: 'headroom_lite',
            compression: { enabled: true },
            headroom: { enabled: false, port: 8787, corporate_proxy: 'http://corp-proxy:8080' },
            headroom_lite: { enabled: true, port: 8790 },
            mitm: { port: 8888, egress_port: 8889, block_bypass: true },
            copilot_headroom: { enabled: true, port: 8788 },
            windows_service: { manager: 'registry' },
          },
        },
        winManager: 'registry',
        homedirImpl: () => os === 'windows' ? 'C:\\Users\\alice' : '/Users/alice',
        detectMitmdumpImpl: () => os === 'windows'
          ? '/mnt/c/Users/alice/.myelin/venv/Scripts/mitmdump.exe'
          : '/usr/local/bin/mitmdump',
        installMitmServiceImpl: async (opts) => installs.push(opts),
        log: () => {},
        warn: () => {},
      });

      assert.equal(installs.length, 1);
      assert.equal(installs[0].port, 8888);
      assert.equal(installs[0].egressPort, 8889);
      assert.equal(installs[0].manager, 'registry');
      assert.equal(
        installs[0].mitmdumpBin,
        os === 'windows'
          ? 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\mitmdump.exe'
          : '/usr/local/bin/mitmdump',
      );
      assert.equal(installs[0].envVars.MYELIN_HEADROOM_PORT, '8790');
      assert.equal(installs[0].envVars.MYELIN_COMPRESS, '1');
      assert.equal(installs[0].envVars.MYELIN_COPILOT_ENGINE_URL, 'http://127.0.0.1:8788');
      assert.equal(installs[0].envVars.MYELIN_BLOCK_BYPASS, '1');
      if (os === 'windows') {
        assert.equal(installs[0].home, 'C:\\Users\\alice');
        const canonicalRepo = 'C:\\Users\\alice\\.myelin\\repo';
        const currentRepo = normalizeWindowsFilesystemPath(fileURLToPath(new URL('../', import.meta.url)));
        const useCanonicalRepo = existsSync(pathWin32.join(canonicalRepo, 'src', 'cli', 'index.mjs'))
          || (!/^[a-zA-Z]:\\/u.test(currentRepo) && !currentRepo.startsWith('\\\\'));
        assert.equal(
          installs[0].addonPath,
          pathWin32.join(
            useCanonicalRepo ? canonicalRepo : currentRepo,
            'src',
            'mitm',
            'copilot_addon.py',
          ),
        );
      }
    });
  }

  it('does not wire Lite Copilot egress when compression is explicitly disabled', async () => {
    const installs = [];

    await defaultRestartMitm({
      os: 'linux',
      cfg: {
        proxy: {
          engine: 'headroom_lite',
          compression: { enabled: false },
          headroom: { enabled: true, port: 8787 },
          headroom_lite: { enabled: true, port: 8790 },
          mitm: { port: 8888, egress_port: 8889 },
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
    assert.equal(installs[0].envVars.MYELIN_COMPRESS, '0');
    assert.equal(installs[0].envVars.MYELIN_COPILOT_ENGINE_URL, undefined);
    assert.equal(installs[0].egressPort, undefined);
  });
});

describe('restartHeadroomLite WSL Windows paths', () => {
  it('emits only Windows launcher, pid, and binary paths when restarting from WSL', async () => {
    const commands = [];
    const spawns = [];

    const started = await restartHeadroomLite(8790, 'windows', {}, {
      home: '/mnt/c/Users/alice',
      execSyncImpl: (command) => {
        commands.push(command);
        if (command.includes('Get-Command headroom-lite')) {
          return Buffer.from('/mnt/c/Users/alice/.myelin/bin/headroom-lite.exe\n');
        }
        return Buffer.from('');
      },
      stopManagedHeadroomLiteImpl: async () => ({ stopped: false, conflict: false, running: false }),
      spawnImpl: (exe, args, opts) => {
        spawns.push({ exe, args, opts });
        return { unref() {} };
      },
      mkdirSyncImpl: () => {
        throw new Error('Windows launcher persistence should not use local mkdir');
      },
      writeFileSyncImpl: () => {
        throw new Error('Windows launcher persistence should not use local writeFileSync');
      },
      chmodSyncImpl: () => {},
      waitForHeadroomLiteImpl: async () => true,
      log: () => {},
      warn: () => {},
      defaultWindowsHomeImpl: () => 'C:\\Users\\alice',
    });

    const persistCommand = commands.find((command) =>
      command.includes("Set-Content -Path 'C:\\Users\\alice\\.myelin\\state\\headroom-lite\\start-headroom-lite.ps1'")
    );

    assert.equal(started, true);
    assert.ok(persistCommand);
    assert.ok(persistCommand.includes("Remove-Item -Path 'C:\\Users\\alice\\.myelin\\state\\headroom-lite\\headroom-lite.pid'"));
    assert.ok(persistCommand.includes('C:\\Users\\alice\\.myelin\\bin\\headroom-lite.exe'));
    assert.match(persistCommand, /-Value @'\n[\s\S]*\n'@ -Encoding UTF8/);
    assert.doesNotMatch(persistCommand, /\n@' -Encoding UTF8/);
    assert.ok(!persistCommand.includes('/mnt/c/Users/alice'));
    assert.ok(!persistCommand.includes('\\mnt\\'));
    assert.deepEqual(spawns, [{
      exe: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Users\\alice\\.myelin\\state\\headroom-lite\\start-headroom-lite.ps1'],
      opts: { detached: true, stdio: 'ignore' },
    }]);
  });
});
