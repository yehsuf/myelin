import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildCopilotHeadroomTaskEnv,
  buildManagedHeadroomEnv,
  defaultStopManagedCopilotHeadroomProcess,
  defaultRestartCopilotHeadroom,
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

describe('defaultRestartCopilotHeadroom', () => {
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
    const result = await stopManagedHeadroomLite({
      port: 8791,
      osKind: 'linux',
      home: '/Users/alice',
      execSyncImpl: (command) => {
        if (command.includes('lsof -nP -tiTCP:8791')) return Buffer.from('');
        if (command.includes('ps -p 5150 -o command=')) return Buffer.from('/usr/local/bin/headroom-lite\n');
        if (command.includes('ps -p 5150 -o ppid=')) return Buffer.from('999\n');
        if (command.includes('ps -p 999 -o command=')) return Buffer.from('/bin/sh /Users/alice/.myelin/state/headroom-lite/start-headroom-lite.sh\n');
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
        homedirImpl: () => os === 'windows' ? '/mnt/c/Users/alice' : '/Users/alice',
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
      assert.equal(installs[0].envVars.MYELIN_COPILOT_HEADROOM_PORT, '8788');
      assert.equal(installs[0].envVars.MYELIN_BLOCK_BYPASS, '1');
      if (os === 'windows') {
        assert.equal(installs[0].home, 'C:\\Users\\alice');
        assert.equal(installs[0].addonPath, 'C:\\Users\\alice\\.myelin\\repo\\src\\mitm\\copilot_addon.py');
      }
    });
  }
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
    assert.ok(!persistCommand.includes('/mnt/c/Users/alice'));
    assert.ok(!persistCommand.includes('\\mnt\\'));
    assert.deepEqual(spawns, [{
      exe: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Users\\alice\\.myelin\\state\\headroom-lite\\start-headroom-lite.ps1'],
      opts: { detached: true, stdio: 'ignore' },
    }]);
  });
});
