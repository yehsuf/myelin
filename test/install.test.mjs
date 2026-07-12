import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  applyServiceEngineInstallPlan,
  buildDownstreamProxyServiceInstallOptions,
  buildManagedHeadroomRunKeyCleanupCommand,
  buildMitmServiceInstallOptions,
  ensureManagedHeadroomService,
  removeManagedHeadroomRegistration,
} from '../src/install.mjs';
import { powerShellExecutable } from '../src/detect/os.mjs';

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
        registrationStatusImpl: async () => ({ registered: false }),
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

    await ensureManagedHeadroomService({
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

    assert.equal(installCalls.length, 1);
  });
});

describe('applyServiceEngineInstallPlan', () => {
  it('stops a previously managed headroom-lite instance before reinstalling Python headroom', async () => {
    const calls = [];
    const enginePlan = {
      selectedEngine: 'headroom',
      selectedPort: 8787,
      headroomPort: 8787,
      shouldRunManagedHeadroom: true,
      shouldRemoveManagedHeadroom: false,
    };

    const result = await applyServiceEngineInstallPlan({
      enginePlan,
      os: 'windows',
      cfg: {
        proxy: {
          headroom: { openai_target_url: 'https://api.githubcopilot.com', mode: 'cache', intercept_tool_results: true },
          headroom_lite: { port: 8790 },
          windows_service: { manager: 'registry' },
        },
      },
      winManager: 'registry',
      home: 'C:\\Users\\alice',
      headroomBin: 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe',
      port: 8787,
      envVars: { HEADROOM_PORT: '8787', HEADROOM_MODE: 'cache' },
      ensureManagedHeadroomServiceImpl: async (opts) => {
        calls.push({ type: 'ensure-headroom', opts });
        return { healthy: true };
      },
      removeManagedHeadroomRegistrationImpl: async () => {
        calls.push({ type: 'remove-headroom' });
      },
      stopObsoleteEngineImpl: async (opts) => {
        calls.push({ type: 'stop-lite', opts });
        return { stopped: true, conflict: false };
      },
      detectToolImpl: async () => ({ installed: true }),
      restartHeadroomLiteImpl: async () => true,
      warnFn: () => {},
      logFn: () => {},
      okFn: () => {},
    });

    assert.equal(result.selectedInstallEngine, 'headroom');
    assert.equal(result.selectedProxyPort, 8787);
    assert.deepEqual(calls.map(({ type }) => type), ['stop-lite', 'ensure-headroom']);
    assert.equal(calls[0].opts.engine, 'headroom_lite');
    assert.equal(calls[0].opts.home, 'C:\\Users\\alice');
    assert.equal(calls[0].opts.winManager, 'registry');
    assert.equal(calls[1].opts.headroomBin, 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe');
  });

  it('falls back from unavailable headroom-lite to managed Python headroom and still cleans up managed Lite', async () => {
    const calls = [];

    const result = await applyServiceEngineInstallPlan({
      enginePlan: {
        selectedEngine: 'headroom_lite',
        selectedPort: 8790,
        headroomPort: 8787,
        shouldRunManagedHeadroom: false,
        shouldRemoveManagedHeadroom: true,
      },
      os: 'windows',
      cfg: {
        proxy: {
          headroom: { openai_target_url: 'https://api.githubcopilot.com', mode: 'cache', intercept_tool_results: true },
          headroom_lite: { port: 8790 },
          windows_service: { manager: 'registry' },
        },
      },
      winManager: 'registry',
      home: 'C:\\Users\\alice',
      headroomBin: 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe',
      port: 8787,
      envVars: { HEADROOM_PORT: '8787', HEADROOM_MODE: 'cache' },
      ensureManagedHeadroomServiceImpl: async (opts) => {
        calls.push({ type: 'ensure-headroom', opts });
        return { healthy: true };
      },
      removeManagedHeadroomRegistrationImpl: async () => {
        calls.push({ type: 'remove-headroom' });
      },
      stopObsoleteEngineImpl: async (opts) => {
        calls.push({ type: 'stop-lite', opts });
        return { stopped: true, conflict: false };
      },
      detectToolImpl: async () => ({ installed: false }),
      warnFn: () => {},
      logFn: () => {},
      okFn: () => {},
    });

    assert.equal(result.persistHeadroomFallback, true);
    assert.equal(result.selectedInstallEngine, 'headroom');
    assert.deepEqual(calls.map(({ type }) => type), ['stop-lite', 'ensure-headroom']);
  });

  it('wires downstream mitm and watchdog options from the resolved fallback engine plan', async () => {
    const cfg = {
      proxy: {
        headroom: { openai_target_url: 'https://api.githubcopilot.com', mode: 'cache', intercept_tool_results: true },
        headroom_lite: { port: 8790 },
        mitm: { port: 8888 },
        copilot_headroom: { enabled: true, port: 8788, mode: 'observe' },
        windows_service: { manager: 'winsw', watchdog_enabled: true, watchdog_interval_minutes: 5 },
      },
    };

    const installPlan = await applyServiceEngineInstallPlan({
      enginePlan: {
        selectedEngine: 'headroom_lite',
        selectedPort: 8790,
        headroomPort: 8787,
        shouldRunManagedHeadroom: false,
        shouldRemoveManagedHeadroom: true,
      },
      os: 'windows',
      cfg,
      winManager: 'winsw',
      home: 'C:\\Users\\alice',
      headroomBin: 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe',
      port: 8787,
      envVars: { HEADROOM_PORT: '8787', HEADROOM_MODE: 'cache' },
      ensureManagedHeadroomServiceImpl: async () => ({ healthy: true }),
      removeManagedHeadroomRegistrationImpl: async () => {},
      stopObsoleteEngineImpl: async () => ({ stopped: true, conflict: false }),
      detectToolImpl: async () => ({ installed: false }),
      warnFn: () => {},
      logFn: () => {},
      okFn: () => {},
    });

    const downstream = buildDownstreamProxyServiceInstallOptions({
      cfg,
      os: 'windows',
      home: 'C:\\Users\\alice',
      mitmdumpBin: 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\mitmdump.exe',
      sslEnv: {},
      winManager: 'winsw',
      installPlan,
    });

    assert.equal(installPlan.selectedProxyPort, 8787);
    assert.equal(downstream.mitmOpts.envVars.MYELIN_HEADROOM_PORT, '8787');
    assert.equal(downstream.watchdogOpts.headroomPort, 8787);
    assert.equal(downstream.watchdogOpts.intervalMinutes, 5);
  });
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
    assert.equal(opts.addonPath, 'C:\\Users\\alice\\.myelin\\repo\\src\\mitm\\copilot_addon.py');
    assert.equal(opts.logPath, 'C:\\Users\\alice\\.myelin\\mitmproxy.log');
    assert.equal(opts.envVars.REQUESTS_CA_BUNDLE, 'C:\\ProgramData\\Corp\\ca.pem');
    assert.equal(opts.envVars.MYELIN_VPN_DOMAINS_FILE, 'C:\\Users\\alice\\.myelin\\vpn-domains.txt');
    assert.equal(opts.envVars.HTTPS_PROXY, 'http://corp-proxy:8080');
    assert.equal(opts.upstreamProxy, 'http://corp-upstream:8888');
    assert.ok(!opts.envVars.HTTPS_PROXY.includes('\\'));
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
