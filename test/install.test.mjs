import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { win32 as pathWin32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyServiceEngineInstallPlan,
  buildDownstreamProxyServiceInstallOptions,
  buildManagedHeadroomRunKeyCleanupCommand,
  buildMitmServiceInstallOptions,
  ensureManagedHeadroomService,
  removeManagedHeadroomRegistration,
  shouldInstallPythonHeadroomPackage,
} from '../src/install.mjs';
import { powerShellExecutable } from '../src/detect/os.mjs';
import { installWatchdog as installWindowsWatchdog, normalizeWindowsFilesystemPath } from '../src/service/windows.mjs';


describe('shouldInstallPythonHeadroomPackage', () => {
  it('skips headroom-ai installation entirely when headroom-lite is the selected engine', () => {
    assert.equal(shouldInstallPythonHeadroomPackage({
      cfg: {
        proxy: {
          engine: 'headroom_lite',
          headroom: { port: 8787 },
          headroom_lite: { port: 8790 },
        },
      },
    }), false);
  });

  it('still installs headroom-ai when Python Headroom is the selected engine', () => {
    assert.equal(shouldInstallPythonHeadroomPackage({
      cfg: {
        proxy: {
          engine: 'headroom',
          headroom: { port: 8787 },
        },
      },
    }), true);
  });
});

describe('ensureManagedHeadroomService', () => {
  for (const os of ['darwin', 'linux', 'windows']) {
    it(`reinstalls durable registration on ${os} when only a transient headroom process is healthy`, async () => {
      const installCalls = [];
      const waitCalls = [];
      const stopCalls = [];

      await ensureManagedHeadroomService({
        os,
        winManager: os === 'windows' ? 'registry' : 'winsw',
        home: '/Users/alice',
        headroomBin: '/usr/local/bin/headroom',
        port: 8787,
        envVars: { HEADROOM_PORT: '8787' },
        interceptToolResults: true,
        registrationStatusImpl: async () => ({
          registered: false,
          ...(os === 'windows' ? { needsMigration: true } : {}),
        }),
        waitForHeadroomImpl: async (port, timeout) => {
          waitCalls.push({ port, timeout });
          return true;
        },
        installServiceImpl: async (opts) => {
          installCalls.push(opts);
        },
        stopHealthyProcessImpl: async (opts) => {
          stopCalls.push(opts);
        },
        logFn: () => {},
        okFn: () => {},
        warnFn: () => {},
      });

      assert.equal(installCalls.length, 1);
      assert.deepEqual(stopCalls, [
        {
          os,
          winManager: os === 'windows' ? 'registry' : 'winsw',
          home: '/Users/alice',
          port: 8787,
          headroomBin: '/usr/local/bin/headroom',
        },
      ]);
      assert.deepEqual(waitCalls, [
        { port: 8787, timeout: 1500 },
        { port: 8787, timeout: os === 'windows' ? 15000 : 10000 },
      ]);
    });
  }

  it('skips reinstall when the managed registration already exists and headroom is healthy', async () => {
    const installCalls = [];
    const messages = [];

    await ensureManagedHeadroomService({
      os: 'linux',
      winManager: 'winsw',
      home: '/home/alice',
      headroomBin: '/usr/local/bin/headroom',
      port: 8787,
      envVars: { HEADROOM_PORT: '8787' },
      registrationStatusImpl: async () => ({ registered: true }),
      waitForHeadroomImpl: async () => true,
      installServiceImpl: async (opts) => {
        installCalls.push(opts);
      },
      logFn: () => {},
      okFn: (message) => {
        messages.push(message);
      },
      warnFn: () => {},
    });

    assert.equal(installCalls.length, 0);
    assert.deepEqual(messages, [
      'service registered (port 8787)',
      'proxy healthy on :8787',
    ]);
  });

  it('does not treat WinSW wrapper files alone as durable registration', async () => {
    const installCalls = [];

    const result = await ensureManagedHeadroomService({
      os: 'windows',
      winManager: 'winsw',
      home: 'C:\\Users\\alice',
      headroomBin: 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe',
      port: 8787,
      envVars: { HEADROOM_PORT: '8787' },
      registrationStatusImpl: async () => ({ registered: false, status: { state: 'NonExistent' } }),
      waitForHeadroomImpl: async () => true,
      installServiceImpl: async (opts) => {
        installCalls.push(opts);
      },
      logFn: () => {},
      okFn: () => {},
      warnFn: () => {},
    });

    assert.equal(installCalls.length, 0);
    assert.equal(result.conflict, true);
  });

  it('reports a Windows conflict without stopping a healthy unregistered Headroom process', async () => {
    const warnings = [];

    const result = await ensureManagedHeadroomService({
      os: 'windows',
      winManager: 'registry',
      home: 'C:\\Users\\alice',
      headroomBin: 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe',
      port: 8787,
      registrationStatusImpl: async () => ({ registered: false, needsMigration: false }),
      waitForHeadroomImpl: async () => true,
      stopHealthyProcessImpl: () => assert.fail('an unmanaged process must not be stopped'),
      installServiceImpl: () => assert.fail('an unmanaged process must not be replaced'),
      logFn: () => {},
      okFn: () => {},
      warnFn: (message) => warnings.push(message),
    });

    assert.equal(result.conflict, true);
    assert.equal(result.installed, false);
    assert.match(result.reason, /unmanaged/i);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unmanaged/i);
  });
});

describe('applyServiceEngineInstallPlan', () => {
  const liteCopilotConfig = {
    proxy: {
      engine: 'headroom_lite',
      headroom_lite: { port: 8790 },
      mitm: { port: 8888, egress_port: 8889 },
      copilot_headroom: { enabled: true, port: 8788 },
    },
  };

  it('installs Lite primary and Lite Copilot without probing Python Headroom', async () => {
    const events = [];
    const installCalls = [];

    await applyServiceEngineInstallPlan({
      cfg: liteCopilotConfig,
      os: 'linux',
      home: '/home/alice',
      installEngineInstanceImpl: async (instance, options) => {
        events.push(`install:${instance.engine}:${instance.role}`);
        installCalls.push({ instance, options });
      },
      removeManagedHeadroomRegistrationImpl: async () => {},
      removeEngineInstanceImpl: async (instance) => {
        events.push(`remove:${instance.engine}:${instance.role}`);
      },
      ensureManagedHeadroomServiceImpl: () => assert.fail('Python must not run'),
      detectToolImpl: async () => ({ installed: true, path: '/usr/local/bin/headroom-lite' }),
      restartHeadroomLiteImpl: () => assert.fail('Lite must not be revived during installation'),
    });

    assert.deepEqual(events, [
      'remove:headroom:primary', 'remove:headroom:copilot',
      'install:headroom_lite:primary', 'install:headroom_lite:copilot',
    ]);
    assert.deepEqual(installCalls.map(({ instance }) => `${instance.engine}:${instance.role}`), [
      'headroom_lite:primary', 'headroom_lite:copilot',
    ]);
    assert.equal(installCalls[0].options.headroomBin, undefined);
    assert.equal(installCalls[0].options.headroomLiteBin, '/usr/local/bin/headroom-lite');
  });

  it('keeps shared Python provider settings out of the Lite Copilot descriptor', async () => {
    const installCalls = [];
    const pythonPrimaryEnv = {
      OPENAI_TARGET_API_URL: 'https://api.githubcopilot.com',
      HEADROOM_MODE: 'cache',
      REQUESTS_CA_BUNDLE: '/etc/ssl/corp.pem',
    };

    await applyServiceEngineInstallPlan({
      cfg: liteCopilotConfig,
      os: 'linux',
      home: '/home/alice',
      envVars: pythonPrimaryEnv,
      installEngineInstanceImpl: async (instance, options) => installCalls.push({ instance, options }),
      removeEngineInstanceImpl: async () => {},
      detectToolImpl: async () => ({ installed: true, path: '/usr/local/bin/headroom-lite' }),
    });

    const copilot = installCalls.find(({ instance }) => instance.role === 'copilot');
    assert.deepEqual(copilot.instance.env, {
      HEADROOM_LITE_UPSTREAM: 'http://127.0.0.1:8889',
      HEADROOM_LITE_COMPRESS_PROXY: 'true',
    });
    assert.deepEqual(copilot.options.envVars, {});
  });

  it('keeps shared connection settings on Lite primary without its Python provider settings', async () => {
    const installCalls = [];
    const sharedEnv = {
      HEADROOM_PORT: '8790',
      OPENAI_TARGET_API_URL: 'https://api.githubcopilot.com',
      HEADROOM_MODE: 'cache',
      REQUESTS_CA_BUNDLE: '/etc/ssl/corp.pem',
      HTTPS_PROXY: 'http://corp-proxy:8080',
    };

    await applyServiceEngineInstallPlan({
      cfg: liteCopilotConfig,
      os: 'linux',
      home: '/home/alice',
      envVars: sharedEnv,
      installEngineInstanceImpl: async (instance, options) => installCalls.push({ instance, options }),
      removeEngineInstanceImpl: async () => {},
      detectToolImpl: async () => ({ installed: true, path: '/usr/local/bin/headroom-lite' }),
    });

    const primary = installCalls.find(({ instance }) => instance.role === 'primary');
    assert.deepEqual(primary.options.envVars, {
      REQUESTS_CA_BUNDLE: '/etc/ssl/corp.pem',
      HTTPS_PROXY: 'http://corp-proxy:8080',
    });
  });

  it('installs only the selected Python primary and does not detect Lite', async () => {
    const installCalls = [];
    const removed = [];

    await applyServiceEngineInstallPlan({
      cfg: { proxy: { engine: 'headroom', headroom: { port: 8787 } } },
      os: 'linux',
      home: '/home/alice',
      headroomBin: '/opt/myelin/headroom',
      installEngineInstanceImpl: async (instance, options) => installCalls.push({ instance, options }),
      removeManagedHeadroomRegistrationImpl: async () => {},
      removeEngineInstanceImpl: async (instance) => removed.push(instance),
      detectToolImpl: () => assert.fail('Lite must not be detected for Python'),
      restartHeadroomLiteImpl: () => assert.fail('Lite must not be revived for Python'),
      ensureManagedHeadroomServiceImpl: () => assert.fail('legacy Python installer must not run'),
      stopObsoleteEngineImpl: () => assert.fail('restart orchestration must not run'),
    });

    assert.deepEqual(removed.map(({ engine, role }) => `${engine}:${role}`), [
      'headroom_lite:primary', 'headroom_lite:copilot',
      'headroom:copilot',
    ]);
    assert.deepEqual(installCalls.map(({ instance }) => `${instance.engine}:${instance.role}`), ['headroom:primary']);
    assert.equal(installCalls[0].options.headroomBin, '/opt/myelin/headroom');
    assert.equal(installCalls[0].options.headroomLiteBin, undefined);
  });

  it('fails explicitly for missing Lite after disabling only owned Python descriptors', async () => {
    const removed = [];
    const installed = [];

    await assert.rejects(
      applyServiceEngineInstallPlan({
        cfg: liteCopilotConfig,
        os: 'linux',
        installEngineInstanceImpl: async (instance) => installed.push(instance),
        removeManagedHeadroomRegistrationImpl: async () => {},
        removeEngineInstanceImpl: async (instance) => removed.push(instance),
        ensureManagedHeadroomServiceImpl: () => assert.fail('Python must not run'),
        detectToolImpl: async () => ({ installed: false, path: null }),
        restartHeadroomLiteImpl: () => assert.fail('Lite must not be revived during installation'),
      }),
      /headroom-lite selected but not installed/,
    );

    assert.deepEqual(removed.map(({ engine, role }) => `${engine}:${role}`), [
      'headroom:primary', 'headroom:copilot',
    ]);
    assert.deepEqual(installed, []);
  });

  it('surfaces a Lite registration failure without falling back to Python', async () => {
    const installed = [];

    await assert.rejects(
      applyServiceEngineInstallPlan({
        cfg: liteCopilotConfig,
        os: 'linux',
        installEngineInstanceImpl: async (instance) => {
          installed.push(instance);
          throw new Error('headroom-lite service is unhealthy');
        },
        removeManagedHeadroomRegistrationImpl: async () => {},
        removeEngineInstanceImpl: async () => {},
        ensureManagedHeadroomServiceImpl: () => assert.fail('Python must not run'),
        detectToolImpl: async () => ({ installed: true, path: '/usr/local/bin/headroom-lite' }),
        restartHeadroomLiteImpl: () => assert.fail('Lite must not be revived during installation'),
      }),
      /headroom-lite service is unhealthy/,
    );

    assert.deepEqual(installed.map(({ engine, role }) => `${engine}:${role}`), ['headroom_lite:primary']);
  });

  for (const manager of ['registry', 'winsw']) {
    for (const [selectedEngine, obsoleteEngine] of [
      ['headroom_lite', 'headroom'],
      ['headroom', 'headroom_lite'],
    ]) {
      it(`passes port-bearing ${obsoleteEngine} descriptors to ${manager} cleanup when installing ${selectedEngine}`, async () => {
        const removed = [];

        await applyServiceEngineInstallPlan({
          cfg: {
            proxy: {
              engine: selectedEngine,
              headroom: { port: 8787 },
              headroom_lite: { port: 8790 },
              copilot_headroom: { enabled: true, port: 8788 },
              windows_service: { manager },
            },
          },
          os: 'windows',
          home: 'C:\\Users\\alice',
          headroomBin: 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe',
          installEngineInstanceImpl: async () => {},
          removeEngineInstanceImpl: async (instance) => removed.push(instance),
          detectToolImpl: async () => ({ installed: true, path: 'C:\\Users\\alice\\.myelin\\bin\\headroom-lite.exe' }),
        });

        const obsoletePort = obsoleteEngine === 'headroom' ? 8787 : 8790;
        assert.deepEqual(removed.map(({ id, port, healthUrl }) => ({ id, port, healthUrl })), [
          {
            id: `${obsoleteEngine}-primary`,
            port: obsoletePort,
            healthUrl: `http://127.0.0.1:${obsoletePort}/health`,
          },
          {
            id: `${obsoleteEngine}-copilot`,
            port: 8788,
            healthUrl: 'http://127.0.0.1:8788/health',
          },
        ]);
      });
    }
  }

  for (const selectedEngine of ['headroom', 'headroom_lite']) {
    it(`removes only the disabled ${selectedEngine} Copilot descriptor while retaining its primary`, async () => {
      const removed = [];
      const installed = [];
      const obsoleteEngine = selectedEngine === 'headroom' ? 'headroom_lite' : 'headroom';

      await applyServiceEngineInstallPlan({
        cfg: {
          proxy: {
            engine: selectedEngine,
            headroom: { port: 8787 },
            headroom_lite: { port: 8790 },
            copilot_headroom: { enabled: false, port: 8788 },
          },
        },
        os: 'linux',
        home: '/home/alice',
        headroomBin: '/opt/myelin/headroom',
        installEngineInstanceImpl: async (instance) => installed.push(instance),
        removeEngineInstanceImpl: async (instance) => removed.push(instance),
        detectToolImpl: async () => ({ installed: true, path: '/opt/myelin/headroom-lite' }),
      });

      assert.deepEqual(installed.map(({ id }) => id), [`${selectedEngine}-primary`]);
      assert.deepEqual(removed.map(({ id }) => id), [
        `${obsoleteEngine}-primary`,
        `${obsoleteEngine}-copilot`,
        `${selectedEngine}-copilot`,
      ]);
      assert.ok(!removed.some(({ id }) => id === `${selectedEngine}-primary`));
      assert.ok(removed.every(({ engine, role }) =>
        engine === obsoleteEngine || (engine === selectedEngine && role === 'copilot')));
    });
  }
});

describe('buildMitmServiceInstallOptions', () => {
  it('normalizes WSL filesystem inputs for Windows registry-managed mitm services without touching URL env vars', () => {
    const opts = buildMitmServiceInstallOptions({
      os: 'windows',
      home: '/mnt/c/Users/alice',
      mitmdumpBin: '/mnt/c/Users/alice/.myelin/venv/Scripts/mitmdump.exe',
      winManager: 'registry',
      sslEnv: {
        REQUESTS_CA_BUNDLE: '/mnt/c/ProgramData/Corp/ca.pem',
        HTTPS_PROXY: 'http://corp-proxy:8080',
      },
      cfg: {
        proxy: {
          headroom: { corporate_proxy: 'http://corp-upstream:8888' },
          mitm: {
            vpn_domains_file: '/mnt/c/Users/alice/.myelin/vpn-domains.txt',
          },
          windows_service: { manager: 'registry' },
          copilot_headroom: { enabled: true, port: 8788 },
        },
      },
    });

    assert.equal(opts.home, 'C:\\Users\\alice');
    assert.equal(opts.mitmdumpBin, 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\mitmdump.exe');
    const canonicalRepo = 'C:\\Users\\alice\\.myelin\\repo';
    const currentRepo = normalizeWindowsFilesystemPath(fileURLToPath(new URL('../', import.meta.url)));
    const useCanonicalRepo = existsSync(pathWin32.join(canonicalRepo, 'src', 'cli', 'index.mjs'))
      || (!/^[a-zA-Z]:\\/u.test(currentRepo) && !currentRepo.startsWith('\\\\'));
    assert.equal(
      opts.addonPath,
      pathWin32.join(
        useCanonicalRepo ? canonicalRepo : currentRepo,
        'src',
        'mitm',
        'copilot_addon.py',
      ),
    );
    assert.equal(opts.logPath, 'C:\\Users\\alice\\.myelin\\mitmproxy.log');
    assert.equal(opts.envVars.REQUESTS_CA_BUNDLE, 'C:\\ProgramData\\Corp\\ca.pem');
    assert.equal(opts.envVars.MYELIN_VPN_DOMAINS_FILE, 'C:\\Users\\alice\\.myelin\\vpn-domains.txt');
    assert.equal(opts.envVars.HTTPS_PROXY, 'http://corp-proxy:8080');
    assert.equal(opts.upstreamProxy, 'http://corp-upstream:8888');
    assert.ok(!opts.envVars.HTTPS_PROXY.includes('\\'));
  });

  it('wires Lite plus Copilot into MITM even though Python Headroom is unselected', () => {
    const opts = buildMitmServiceInstallOptions({
      os: 'linux',
      home: '/home/alice',
      mitmdumpBin: '/usr/local/bin/mitmdump',
      enginePlan: {
        instances: [
          { engine: 'headroom_lite', role: 'primary', port: 8790 },
          { engine: 'headroom_lite', role: 'copilot', port: 9797 },
        ],
      },
      cfg: {
        proxy: {
          engine: 'headroom_lite',
          compression: { enabled: true },
          headroom: { enabled: false },
          headroom_lite: { enabled: true, port: 8790 },
          copilot_headroom: { enabled: true, port: 8788 },
          mitm: { egress_port: 8889 },
        },
      },
    });

    assert.equal(opts.envVars.MYELIN_COMPRESS, '1');
    assert.equal(opts.envVars.MYELIN_COPILOT_ENGINE_URL, 'http://127.0.0.1:9797');
    assert.equal(opts.envVars.MYELIN_COPILOT_HEADROOM_PORT, undefined);
    assert.equal(opts.egressPort, 8889);
  });

  it('does not add the Copilot redirect or egress listener when compression is disabled', () => {
    const opts = buildMitmServiceInstallOptions({
      os: 'linux',
      home: '/home/alice',
      mitmdumpBin: '/usr/local/bin/mitmdump',
      enginePlan: {
        instances: [
          { engine: 'headroom_lite', role: 'primary', port: 8790 },
          { engine: 'headroom_lite', role: 'copilot', port: 9797 },
        ],
      },
      cfg: {
        proxy: {
          engine: 'headroom_lite',
          compression: { enabled: false },
          headroom: { enabled: true },
          headroom_lite: { enabled: true, port: 8790 },
          copilot_headroom: { enabled: true, port: 8788 },
          mitm: { egress_port: 8889 },
        },
      },
    });

    assert.equal(opts.envVars.MYELIN_COMPRESS, '0');
    assert.equal(opts.envVars.MYELIN_COPILOT_ENGINE_URL, undefined);
    assert.equal(opts.egressPort, undefined);
  });
});

describe('buildDownstreamProxyServiceInstallOptions', () => {
  it('passes selected descriptor IDs to a WinSW install watchdog instead of legacy service IDs', () => {
    const instances = [
      {
        id: 'headroom-primary',
        role: 'primary',
        port: 8787,
        healthUrl: 'http://127.0.0.1:8787/health',
      },
      {
        id: 'headroom-copilot',
        role: 'copilot',
        port: 9788,
        healthUrl: 'http://127.0.0.1:9788/health',
      },
    ];
    const installed = [];
    const options = buildDownstreamProxyServiceInstallOptions({
      cfg: {
        proxy: {
          mitm: { port: 8888, egress_port: 8889 },
          windows_service: { manager: 'winsw', watchdog_enabled: true },
        },
      },
      os: 'windows',
      home: 'C:\\Users\\alice',
      winManager: 'winsw',
      installPlan: {
        enginePlan: {
          engine: 'headroom',
          selectedPort: 8787,
          shouldRunManagedHeadroom: true,
          instances,
        },
      },
    });

    assert.deepEqual(options.watchdogOpts.instances, instances);
    installWindowsWatchdog({
      ...options.watchdogOpts,
      installWindowsWatchdogTaskImpl: (task) => installed.push(task),
      uninstallWindowsWatchdogTaskImpl: () => assert.fail('enabled descriptor watchdog must not uninstall'),
    });

    assert.deepEqual(installed.map(({ id }) => id), ['headroom-primary', 'headroom-copilot']);
    assert.ok(installed.every(({ id }) => id !== 'myelin-headroom'));
  });
});

describe('buildManagedHeadroomRunKeyCleanupCommand', () => {
  it('supports default PowerShell selection when no override is provided', () => {
    const command = buildManagedHeadroomRunKeyCleanupCommand();

    assert.ok(command.startsWith(`${powerShellExecutable()} `));
    assert.ok(command.includes("Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'MyelinHeadroom'"));
  });

  it('uses the WSL-aware PowerShell executable for obsolete Run-key cleanup', () => {
    const command = buildManagedHeadroomRunKeyCleanupCommand({
      powershellExe: powerShellExecutable({
        platformImpl: () => 'linux',
        isWslImpl: () => true,
      }),
    });

    assert.ok(command.startsWith('powershell.exe '));
    assert.ok(command.includes("Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'MyelinHeadroom'"));
  });
});

describe('removeManagedHeadroomRegistration', () => {
  it('uses the default PowerShell selection for cleanup command and stop invocation', async () => {
    const commands = [];
    const stops = [];

    await removeManagedHeadroomRegistration({
      os: 'windows',
      winManager: 'registry',
      home: 'C:\\Users\\alice',
      headroomPort: 8787,
      execSyncImpl: (command) => {
        commands.push(command);
        return Buffer.from('');
      },
      stopManagedHeadroomProcessImpl: (opts) => stops.push(opts),
      warnFn: () => {},
      okFn: () => {},
    });

    assert.equal(stops.length, 1);
    assert.equal(stops[0].powershellExe, powerShellExecutable());
    assert.ok(commands[0].startsWith(`${powerShellExecutable()} `));
  });

  it('routes obsolete Run-key cleanup through the WSL-aware PowerShell executable', async () => {
    const commands = [];
    const stops = [];
    const powershellExe = powerShellExecutable({
      platformImpl: () => 'linux',
      isWslImpl: () => true,
    });

    await removeManagedHeadroomRegistration({
      os: 'windows',
      winManager: 'registry',
      home: 'C:\\Users\\alice',
      headroomPort: 8787,
      powershellExe,
      execSyncImpl: (command) => {
        commands.push(command);
        return Buffer.from('');
      },
      stopManagedHeadroomProcessImpl: (opts) => stops.push(opts),
      warnFn: () => {},
      okFn: () => {},
    });

    assert.equal(stops.length, 1);
    assert.equal(stops[0].powershellExe, 'powershell.exe');
    assert.equal(stops[0].home, 'C:\\Users\\alice');
    assert.equal(stops[0].port, 8787);
    assert.ok(commands[0].startsWith('powershell.exe '));
  });
});
