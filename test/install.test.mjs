import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { installCopilotSkills } from '../src/install.mjs';
import {
  applyServiceEngineInstallPlan,
  applyMitmServiceInstallPlan,
  buildDownstreamProxyServiceInstallOptions,
  buildManagedHeadroomRunKeyCleanupCommand,
  buildMitmServiceInstallOptions,
  buildHeadroomStopExec,
  ensureManagedHeadroomService,
  ensureManagedVenv,
  installPipPackageInManagedVenv,
  mitmAddonPath,
  provisionManagedCompressionComponent,
  removeManagedHeadroomRegistration,
  resolveInstallComponentStoragePlatform,
  shouldInstallPythonHeadroomPackage,
  stopLegacyManagedProxies,
  stopManagedUvToolProcess,
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

describe('ensureManagedVenv / installPipPackageInManagedVenv (C: MYELIN_DIR venv never reaches a shell)', () => {
  // A venv path derived from a relocated MYELIN_DIR is arbitrary user text. It
  // MUST reach `uv` as a single literal argv element via execFileSync — never
  // interpolated into an execSync shell string where `"`, `$(...)`, backticks or
  // `'` could break out into command execution.
  const HOSTILE_VENV = 'C:\\Users\\dev\\my "weird" $(calc) `bt` \'root\'\\venv';

  it('ensureManagedVenv calls execFileSync(uv, [venv, <venv>]) with the venv as ONE literal argv element', () => {
    const calls = [];
    ensureManagedVenv(HOSTILE_VENV, {
      existsSyncImpl: () => false, // pyvenv.cfg missing → must create
      execFileSyncImpl: (file, args, opts) => { calls.push({ file, args, opts }); return Buffer.from(''); },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'uv', 'must invoke the uv binary directly (no shell)');
    assert.ok(Array.isArray(calls[0].args), 'args must be an argv array, not a shell string');
    assert.deepEqual(calls[0].args, ['venv', HOSTILE_VENV]);
    // The venv is a discrete, byte-for-byte-verbatim element — never escaped,
    // split, or embedded in a larger command string.
    assert.equal(calls[0].args[1], HOSTILE_VENV);
    assert.ok(!calls[0].args.some((a) => /uv venv/.test(a)), 'no shell command string may be built');
  });

  it('ensureManagedVenv does NOT recreate the venv when pyvenv.cfg already exists', () => {
    const calls = [];
    ensureManagedVenv(HOSTILE_VENV, {
      existsSyncImpl: () => true, // already present
      execFileSyncImpl: (file, args) => { calls.push({ file, args }); },
    });
    assert.deepEqual(calls, []);
  });

  it('installPipPackageInManagedVenv passes venv + spec as literal argv (no shell parses [extras] / >=)', () => {
    const calls = [];
    installPipPackageInManagedVenv(HOSTILE_VENV, 'headroom-ai[all]', {
      execFileSyncImpl: (file, args, opts) => { calls.push({ file, args, opts }); },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'uv');
    assert.deepEqual(calls[0].args, ['pip', 'install', '--python', HOSTILE_VENV, 'headroom-ai[all]']);
    // venv + spec are each ONE argv element, verbatim.
    assert.equal(calls[0].args[3], HOSTILE_VENV);
    assert.equal(calls[0].args[4], 'headroom-ai[all]');
  });

  it('installPipPackageInManagedVenv keeps a litellm[proxy]>=1.92 spec intact as a literal argv element', () => {
    const calls = [];
    installPipPackageInManagedVenv(HOSTILE_VENV, 'litellm[proxy]>=1.92', {
      execFileSyncImpl: (file, args) => { calls.push({ file, args }); },
    });
    assert.deepEqual(calls[0].args, ['pip', 'install', '--python', HOSTILE_VENV, 'litellm[proxy]>=1.92']);
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

describe('resolveInstallComponentStoragePlatform', () => {
  it('uses the raw os for a native (non-WSL) Windows install', () => {
    assert.equal(resolveInstallComponentStoragePlatform('windows', { isWslImpl: () => false }), 'windows');
  });

  it('storage falls back to linux under WSL even though the service target is windows (finding 4)', () => {
    assert.equal(resolveInstallComponentStoragePlatform('windows', { isWslImpl: () => true }), 'linux');
  });

  it('never calls isWsl for non-Windows service targets', () => {
    let called = false;
    assert.equal(
      resolveInstallComponentStoragePlatform('linux', { isWslImpl: () => { called = true; return true; } }),
      'linux',
    );
    assert.equal(called, false);
  });

  it('passes darwin through unchanged', () => {
    assert.equal(resolveInstallComponentStoragePlatform('darwin', { isWslImpl: () => false }), 'darwin');
  });
});

describe('provisionManagedCompressionComponent', () => {
  it('stages and activates the pinned headroom-lite component, then resolves its binary', async () => {
    const calls = [];
    const bin = await provisionManagedCompressionComponent({
      home: '/home/alice',
      os: 'linux',
      isWslImpl: () => false,
      stageComponentImpl: async (args) => calls.push(['stage', args]),
      activateComponentImpl: async (args) => calls.push(['activate', args]),
      resolveManagedCompressionBinaryImpl: (args) => {
        calls.push(['resolve', args]);
        return { binPath: '/home/alice/.myelin/components/headroomLite/current/bin/headroom-lite' };
      },
      componentsImpl: { headroomLite: { kind: 'npm-git', version: '0.31.0', bin: 'headroom-lite' } },
    });

    assert.equal(bin, '/home/alice/.myelin/components/headroomLite/current/bin/headroom-lite');
    assert.equal(calls[0][0], 'stage');
    assert.equal(calls[0][1].name, 'headroomLite');
    assert.equal(calls[0][1].platform, 'linux');
    assert.equal(calls[0][1].root, join('/home/alice', '.myelin', 'components'));
    assert.equal(calls[1][0], 'activate');
    assert.equal(calls[1][1].version, '0.31.0');
    assert.equal(calls[1][1].platform, 'linux');
    assert.equal(calls[2][0], 'resolve');
    assert.equal(calls[2][1].backend, 'headroom-lite');
    assert.equal(calls[2][1].platform, 'linux');
  });

  it('stages under the WSL storage platform (linux) even though the service target is windows (finding 4)', async () => {
    const platforms = [];
    await provisionManagedCompressionComponent({
      home: '/home/alice',
      os: 'windows',
      isWslImpl: () => true,
      stageComponentImpl: async ({ platform }) => platforms.push(platform),
      activateComponentImpl: async ({ platform }) => platforms.push(platform),
      resolveManagedCompressionBinaryImpl: ({ platform }) => {
        platforms.push(platform);
        return { binPath: '/home/alice/.myelin/components/headroomLite/current/bin/headroom-lite' };
      },
      componentsImpl: { headroomLite: { kind: 'npm-git', version: '0.31.0', bin: 'headroom-lite' } },
    });

    assert.deepEqual(platforms, ['linux', 'linux', 'linux']);
  });

  it('wraps a staging failure with a clear provisioning error', async () => {
    await assert.rejects(
      provisionManagedCompressionComponent({
        home: '/home/alice',
        os: 'linux',
        isWslImpl: () => false,
        stageComponentImpl: async () => { throw new Error('network unreachable'); },
        componentsImpl: { headroomLite: { kind: 'npm-git', version: '0.31.0', bin: 'headroom-lite' } },
      }),
      /Failed to provision headroom-lite: network unreachable/,
    );
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

  it('migrates selected Windows legacy roles before installing descriptor identities', async () => {
    const events = [];

    await applyServiceEngineInstallPlan({
      cfg: {
        proxy: {
          engine: 'headroom',
          headroom: { port: 8787 },
          headroom_lite: { port: 8790 },
          copilot_headroom: { enabled: true, port: 9787 },
          windows_service: { manager: 'registry' },
        },
      },
      os: 'windows',
      home: 'C:\\Users\\alice',
      headroomBin: 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\headroom.exe',
      installEngineInstanceImpl: async (instance) => events.push(`install:${instance.id}`),
      removeEngineInstanceImpl: async (instance, options) => {
        events.push(`remove:${instance.legacy ? 'legacy:' : ''}${instance.id}:${options.manager}`);
      },
    });

    assert.deepEqual(events, [
      'remove:legacy:headroom-primary:registry',
      'remove:legacy:headroom-primary:winsw',
      'remove:legacy:headroom-copilot:registry',
      'remove:legacy:headroom-copilot:winsw',
      'remove:headroom-primary:winsw',
      'remove:headroom-copilot:winsw',
      'remove:headroom_lite-primary:registry',
      'remove:headroom_lite-copilot:registry',
      'install:headroom-primary',
      'install:headroom-copilot',
    ]);
  });

  it('uses one resolved Windows executable for both selected WSL engine roles', async () => {
    const installed = [];
    const resolverCalls = [];

    await applyServiceEngineInstallPlan({
      cfg: {
        proxy: {
          engine: 'headroom',
          headroom: { port: 8787 },
          copilot_headroom: { enabled: true, port: 9787 },
        },
      },
      os: 'windows',
      home: '/home/alice',
      headroomBin: '/home/alice/.myelin/venv/bin/headroom',
      isWslImpl: () => true,
      defaultWindowsHomeImpl: () => 'C:\\Users\\alice',
      resolveWindowsServiceExecutableImpl: (options) => {
        resolverCalls.push(options);
        return 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\headroom.exe';
      },
      installEngineInstanceImpl: async (instance, options) => installed.push({ instance, options }),
      removeEngineInstanceImpl: async () => {},
    });

    assert.deepEqual(resolverCalls, [{
      engine: 'headroom',
      candidate: '/home/alice/.myelin/venv/bin/headroom',
      serviceHome: 'C:\\Users\\alice',
      servicePlatform: 'windows',
      wsl: true,
    }]);
    assert.deepEqual(
      installed.map(({ instance, options }) => [instance.id, options.headroomBin]),
      [
        ['headroom-primary', 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\headroom.exe'],
        ['headroom-copilot', 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\headroom.exe'],
      ],
    );
  });

  it('builds fallback WSL Windows descriptors from the resolved Windows home', async () => {
    const installed = [];

    await applyServiceEngineInstallPlan({
      cfg: {
        proxy: {
          engine: 'headroom',
          headroom: { port: 8787 },
          copilot_headroom: { enabled: true, port: 9787 },
        },
      },
      os: 'windows',
      home: '/home/alice',
      headroomBin: '/home/alice/.myelin/venv/bin/headroom',
      isWslImpl: () => true,
      defaultWindowsHomeImpl: () => 'C:\\Users\\alice',
      resolveWindowsServiceExecutableImpl: () => 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\headroom.exe',
      installEngineInstanceImpl: async (instance) => installed.push(instance),
      removeEngineInstanceImpl: async () => {},
    });

    assert.deepEqual(
      installed.map(({ stateDir, logPath }) => ({ stateDir, logPath })),
      [
        {
          stateDir: 'C:\\Users\\alice\\.myelin\\state\\headroom-primary',
          logPath: 'C:\\Users\\alice\\.myelin\\headroom-primary.log',
        },
        {
          stateDir: 'C:\\Users\\alice\\.myelin\\state\\headroom-copilot',
          logPath: 'C:\\Users\\alice\\.myelin\\headroom-copilot.log',
        },
      ],
    );
  });

  it('uses one resolved Windows Lite shim for both selected WSL engine roles', async () => {
    const installed = [];
    const resolverCalls = [];

    await applyServiceEngineInstallPlan({
      cfg: {
        proxy: {
          engine: 'headroom_lite',
          headroom_lite: { port: 8790 },
          copilot_headroom: { enabled: true, port: 9790 },
        },
      },
      os: 'windows',
      home: '/home/alice',
      isWslImpl: () => true,
      defaultWindowsHomeImpl: () => 'C:\\Users\\alice',
      detectToolImpl: async () => ({ installed: true, path: '/home/alice/.local/bin/headroom-lite' }),
      resolveWindowsServiceExecutableImpl: (options) => {
        resolverCalls.push(options);
        return 'C:\\Users\\alice\\AppData\\Roaming\\npm\\headroom-lite.cmd';
      },
      installEngineInstanceImpl: async (instance, options) => installed.push({ instance, options }),
      removeEngineInstanceImpl: async () => {},
    });

    assert.deepEqual(resolverCalls, [{
      engine: 'headroom_lite',
      candidate: '/home/alice/.local/bin/headroom-lite',
      serviceHome: 'C:\\Users\\alice',
      servicePlatform: 'windows',
      wsl: true,
    }]);
    assert.deepEqual(
      installed.map(({ instance, options }) => [instance.id, options.headroomLiteBin]),
      [
        ['headroom_lite-primary', 'C:\\Users\\alice\\AppData\\Roaming\\npm\\headroom-lite.cmd'],
        ['headroom_lite-copilot', 'C:\\Users\\alice\\AppData\\Roaming\\npm\\headroom-lite.cmd'],
      ],
    );
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

  it('provisions the pinned Lite component instead of failing when neither a managed pointer nor a global install exists (finding 2)', async () => {
    const removed = [];
    const installed = [];
    const provisionCalls = [];

    await applyServiceEngineInstallPlan({
      cfg: liteCopilotConfig,
      os: 'linux',
      installEngineInstanceImpl: async (instance, options) => installed.push({ instance, options }),
      removeManagedHeadroomRegistrationImpl: async () => {},
      removeEngineInstanceImpl: async (instance) => removed.push(instance),
      ensureManagedHeadroomServiceImpl: () => assert.fail('Python must not run'),
      detectToolImpl: async () => ({ installed: false, path: null }),
      restartHeadroomLiteImpl: () => assert.fail('Lite must not be revived during installation'),
      provisionManagedCompressionImpl: async (args) => {
        provisionCalls.push(args);
        return '/home/alice/.myelin/components/headroomLite/current/bin/headroom-lite';
      },
    });

    assert.equal(provisionCalls.length, 1);
    assert.equal(provisionCalls[0].os, 'linux');
    assert.deepEqual(
      installed.filter(({ instance }) => instance.role === 'primary').map(({ options }) => options.headroomLiteBin),
      ['/home/alice/.myelin/components/headroomLite/current/bin/headroom-lite'],
    );
  });

  it('fails explicitly when the fresh-install Lite provisioning fallback itself fails', async () => {
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
        provisionManagedCompressionImpl: async () => {
          throw new Error('Failed to provision headroom-lite: network unreachable');
        },
      }),
      /Failed to provision headroom-lite/,
    );

    assert.deepEqual(removed, []);
    assert.deepEqual(installed, []);
  });

  it('provisions the pinned Lite component for a fresh Windows install too', async () => {
    const removed = [];
    const provisionCalls = [];

    await applyServiceEngineInstallPlan({
      cfg: {
        proxy: {
          engine: 'headroom_lite',
          headroom: { port: 8787 },
          headroom_lite: { port: 8790 },
          windows_service: { manager: 'registry' },
        },
      },
      os: 'windows',
      home: 'C:\\Users\\alice',
      installEngineInstanceImpl: async () => {},
      removeEngineInstanceImpl: async (instance) => removed.push(instance),
      detectToolImpl: async () => ({ installed: false, path: null }),
      provisionManagedCompressionImpl: async (args) => {
        provisionCalls.push(args);
        return 'C:\\Users\\alice\\.myelin\\components\\headroomLite\\current\\bin\\headroom-lite.cmd';
      },
    });

    assert.equal(provisionCalls.length, 1);
    assert.equal(provisionCalls[0].os, 'windows');
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
        assert.deepEqual(removed
          .filter(({ legacy, engine }) => !legacy && engine === obsoleteEngine)
          .map(({ id, port, healthUrl }) => ({ id, port, healthUrl })), [
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

  for (const {
    selectedEngine,
    manager,
    alternateManager,
  } of [
    { selectedEngine: 'headroom', manager: 'registry', alternateManager: 'winsw' },
    { selectedEngine: 'headroom_lite', manager: 'winsw', alternateManager: 'registry' },
  ]) {
    it(`removes only selected ${selectedEngine} descriptors from ${alternateManager} before installing through ${manager}`, async () => {
      const removed = [];
      const installed = [];

      await applyServiceEngineInstallPlan({
        cfg: {
          proxy: {
            engine: selectedEngine,
            headroom: { port: 8787 },
            headroom_lite: { port: 8790 },
            copilot_headroom: { enabled: true, port: 9788 },
            windows_service: { manager },
          },
        },
        os: 'windows',
        home: 'C:\\Users\\alice',
        headroomBin: 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\headroom.exe',
        detectToolImpl: async () => ({ installed: true, path: 'C:\\Users\\alice\\.myelin\\bin\\headroom-lite.exe' }),
        removeEngineInstanceImpl: async (instance, options) => removed.push({ instance, options }),
        installEngineInstanceImpl: async (instance) => installed.push(instance),
      });

      assert.deepEqual(
        removed
          .filter(({ instance }) => !instance.legacy && instance.engine === selectedEngine)
          .map(({ instance, options }) => ({
            id: instance.id,
            role: instance.role,
            manager: options.manager,
            includeLegacy: options.includeLegacy,
          })),
        [
          {
            id: `${selectedEngine}-primary`,
            role: 'primary',
            manager: alternateManager,
            includeLegacy: false,
          },
          {
            id: `${selectedEngine}-copilot`,
            role: 'copilot',
            manager: alternateManager,
            includeLegacy: false,
          },
        ],
      );
      assert.deepEqual(installed.map(({ id }) => id), [
        `${selectedEngine}-primary`,
        `${selectedEngine}-copilot`,
      ]);
    });
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

  it('removes an inactive Copilot descriptor and installs only the primary when compression is disabled', async () => {
    const installed = [];
    const removed = [];

    await applyServiceEngineInstallPlan({
      cfg: {
        proxy: {
          engine: 'headroom_lite',
          compression: { enabled: false },
          headroom_lite: { port: 8790 },
          copilot_headroom: { enabled: true, port: 9788 },
          mitm: { port: 8888, egress_port: 8889 },
        },
      },
      os: 'linux',
      home: '/home/alice',
      detectToolImpl: async () => ({ installed: true, path: '/opt/myelin/headroom-lite' }),
      installEngineInstanceImpl: async (instance) => installed.push(instance),
      removeEngineInstanceImpl: async (instance) => removed.push(instance),
    });

    assert.deepEqual(installed.map(({ id }) => id), ['headroom_lite-primary']);
    assert.ok(removed.some(({ id }) => id === 'headroom_lite-copilot'));
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
    assert.equal(
      opts.addonPath,
      'C:\\Users\\alice\\.myelin\\runtime-bridge\\src\\mitm\\copilot_addon.py',
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

  it('rejects a native WSL addon path instead of embedding a broken \\home service asset path', () => {
    assert.throws(
      () => buildMitmServiceInstallOptions({
        os: 'windows',
        home: 'C:\\Users\\alice',
        mitmdumpBin: 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\mitmdump.exe',
        mitmAddonPathImpl: () => '/home/alice/repo/src/mitm/copilot_addon.py',
        cfg: {
          proxy: {
            mitm: { port: 8888 },
          },
        },
      }),
      /POSIX.*Windows-service|Windows-service.*POSIX/i,
    );
  });

  it('resolves a native WSL home to a Windows-service addon path without emitting \\home', () => {
    const opts = buildMitmServiceInstallOptions({
      os: 'windows',
      home: '/home/alice',
      defaultWindowsHomeImpl: () => 'C:\\Users\\alice',
      mitmdumpBin: '/mnt/c/Users/alice/.myelin/venv/Scripts/mitmdump.exe',
      mitmAddonPathImpl: (home) => `${home}\\repo\\src\\mitm\\copilot_addon.py`,
      cfg: {
        proxy: {
          mitm: { port: 8888 },
        },
      },
    });

    assert.equal(opts.home, 'C:\\Users\\alice');
    assert.equal(opts.addonPath, 'C:\\Users\\alice\\repo\\src\\mitm\\copilot_addon.py');
    assert.ok(!opts.addonPath.startsWith('\\home'));
  });

  it('rejects an unresolved WSL home instead of constructing a \\home service asset path', () => {
    assert.throws(
      () => buildMitmServiceInstallOptions({
        os: 'windows',
        home: '/home/alice',
        defaultWindowsHomeImpl: () => '\\home\\alice',
        mitmdumpBin: '/mnt/c/Users/alice/.myelin/venv/Scripts/mitmdump.exe',
        mitmAddonPathImpl: (home) => `${home}\\repo\\src\\mitm\\copilot_addon.py`,
        cfg: {
          proxy: {
            mitm: { port: 8888 },
          },
        },
      }),
      /Windows-service.*home|home.*Windows-service/i,
    );
  });

});

describe('buildDownstreamProxyServiceInstallOptions', () => {
  it('removes the existing Myelin MITM registration instead of installing when disabled', async () => {
    const removals = [];

    const result = await applyMitmServiceInstallPlan({
      cfg: { proxy: { mitm: { enabled: false } } },
      os: 'windows',
      home: 'C:\\Users\\alice',
      winManager: 'registry',
      mitmOpts: { port: 8888 },
      installMitmServiceImpl: () => assert.fail('disabled MITM must not be installed'),
      removeMitmServiceImpl: async (options) => removals.push(options),
    });

    assert.deepEqual(result, { installed: false, removed: true });
    assert.deepEqual(removals, [{
      os: 'windows',
      manager: 'registry',
      home: 'C:\\Users\\alice',
    }]);
  });

  it('omits disabled MITM provisioning and its watchdog probes', () => {
    const options = buildDownstreamProxyServiceInstallOptions({
      cfg: {
        proxy: {
          engine: 'headroom',
          headroom: { port: 8787 },
          copilot_headroom: { enabled: false, port: 8788 },
          mitm: { enabled: false, port: 8888, egress_port: 8889 },
          windows_service: { manager: 'winsw', watchdog_enabled: true },
        },
      },
      os: 'windows',
      home: 'C:\\Users\\alice',
      mitmdumpBin: 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\mitmdump.exe',
      winManager: 'winsw',
      installPlan: {
        enginePlan: {
          selectedPort: 8787,
          instances: [{
            id: 'headroom-primary',
            role: 'primary',
            port: 8787,
            healthUrl: 'http://127.0.0.1:8787/health',
          }],
        },
      },
    });

    assert.equal(options.mitmOpts, null);
    assert.equal(options.watchdogOpts.mitmPort, undefined);
    assert.equal(options.watchdogOpts.egressPort, undefined);
    assert.equal(options.watchdogOpts.copilotHeadroomPort, undefined);
  });

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
    assert.ok(installed.every(({ id }) => id !== 'myelin-compression'));
  });

  it('sets watchdogOpts.headroomPort for headroom_lite so macOS launchd watchdog covers the primary', () => {
    const options = buildDownstreamProxyServiceInstallOptions({
      cfg: {
        proxy: {
          engine: 'headroom_lite',
          headroom_lite: { port: 8790 },
          mitm: { port: 8888 },
          windows_service: { manager: 'registry' },
        },
      },
      os: 'darwin',
      home: '/Users/alice',
      installPlan: {
        enginePlan: {
          engine: 'headroom_lite',
          selectedPort: 8790,
          shouldRunManagedHeadroom: false,
          instances: [
            {
              id: 'headroom_lite-primary',
              role: 'primary',
              port: 8790,
              healthUrl: 'http://127.0.0.1:8790/health',
            },
          ],
        },
      },
    });

    assert.equal(options.watchdogOpts.headroomPort, 8790,
      'macOS launchd watchdog must receive the selected primary port for headroom_lite');
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

describe('stopLegacyManagedProxies (C1: no name-based process kill)', () => {
  function makeTempDir(name) {
    const dir = join(process.cwd(), '.test-artifacts', `${name}-${process.pid}-${randomBytes(4).toString('hex')}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writePidFile(oldDir, serviceId, pidName, pid) {
    const dir = join(oldDir, 'services', serviceId);
    mkdirSync(dir, { recursive: true });
    const pidPath = join(dir, pidName);
    writeFileSync(pidPath, `${pid}\n`, 'utf8');
    return pidPath;
  }

  it('is a no-op on non-windows platforms', () => {
    const oldDir = makeTempDir('legacy-noop');
    try {
      writePidFile(oldDir, 'myelin-headroom', 'headroom.pid', 4242);
      const kills = [];
      const result = stopLegacyManagedProxies({
        os: 'darwin',
        oldDir,
        processInfoFn: () => { throw new Error('should not query on non-windows'); },
        stopPidFn: (pid) => kills.push(pid),
      });
      assert.deepEqual(result, { stopped: [], skipped: [] });
      assert.deepEqual(kills, []);
    } finally {
      rmSync(oldDir, { recursive: true, force: true });
    }
  });

  it('does NOT kill an unrelated same-named process (path not under the managed dir)', () => {
    const oldDir = makeTempDir('legacy-unrelated');
    try {
      writePidFile(oldDir, 'myelin-headroom', 'headroom.pid', 4242);
      const kills = [];
      const result = stopLegacyManagedProxies({
        os: 'windows',
        oldDir,
        // A DIFFERENT headroom.exe installed elsewhere on the machine that
        // happens to have reused (or coincidentally matches) the recorded pid.
        processInfoFn: () => ({
          command: 'C:\\Program Files\\headroom\\headroom.exe proxy --port 8787',
          executablePath: 'C:\\Program Files\\headroom\\headroom.exe',
          startTime: '2024-01-01T00:00:00.0000000+00:00',
        }),
        stopPidFn: (pid) => kills.push(pid),
      });

      assert.deepEqual(kills, [], 'unrelated same-named process must never be killed');
      assert.deepEqual(result.stopped, []);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].pid, 4242);
    } finally {
      rmSync(oldDir, { recursive: true, force: true });
    }
  });

  it('does NOT kill when the recorded pid is dead / stale (no live process)', () => {
    const oldDir = makeTempDir('legacy-stale');
    try {
      writePidFile(oldDir, 'myelin-mitmproxy', 'mitm.pid', 9999);
      const kills = [];
      const result = stopLegacyManagedProxies({
        os: 'windows',
        oldDir,
        processInfoFn: () => null, // process no longer exists
        stopPidFn: (pid) => kills.push(pid),
      });
      assert.deepEqual(kills, []);
      assert.deepEqual(result.stopped, []);
      assert.equal(result.skipped.length, 1);
    } finally {
      rmSync(oldDir, { recursive: true, force: true });
    }
  });

  it('DOES stop a verified Myelin-managed process running from the managed dir', () => {
    const oldDir = makeTempDir('legacy-managed');
    try {
      writePidFile(oldDir, 'myelin-headroom', 'headroom.pid', 5555);
      writePidFile(oldDir, 'myelin-mitmproxy', 'mitm.pid', 6666);
      const kills = [];
      const result = stopLegacyManagedProxies({
        os: 'windows',
        oldDir,
        processInfoFn: (pid) => ({
          command: `${oldDir}\\venv\\Scripts\\${pid === 5555 ? 'headroom.exe proxy --port 8787' : 'mitmdump.exe'}`,
          executablePath: `${oldDir}\\venv\\Scripts\\${pid === 5555 ? 'headroom.exe' : 'mitmdump.exe'}`,
          startTime: '2024-06-01T12:00:00.0000000+00:00',
        }),
        stopPidFn: (pid) => kills.push(pid),
      });

      assert.deepEqual(kills.sort(), [5555, 6666]);
      assert.deepEqual(result.stopped.sort(), [5555, 6666]);
      assert.deepEqual(result.skipped, []);
    } finally {
      rmSync(oldDir, { recursive: true, force: true });
    }
  });

  it('default stop path targets the pid (Stop-Process -Id) and NEVER a process name', () => {
    const oldDir = makeTempDir('legacy-byid');
    try {
      writePidFile(oldDir, 'myelin-headroom', 'headroom.pid', 5555);
      const commands = [];
      stopLegacyManagedProxies({
        os: 'windows',
        oldDir,
        powershellExe: 'powershell.exe',
        // capture what the DEFAULT stopPidFn would execute
        execSyncImpl: (cmd) => { commands.push(String(cmd)); return Buffer.from(''); },
        processInfoFn: () => ({
          command: `${oldDir}\\venv\\Scripts\\headroom.exe proxy`,
          executablePath: `${oldDir}\\venv\\Scripts\\headroom.exe`,
          startTime: '2024-06-01T12:00:00.0000000+00:00',
        }),
      });

      assert.equal(commands.length, 1);
      assert.ok(commands[0].includes('Stop-Process -Id 5555'), `expected Stop-Process -Id: ${commands[0]}`);
      assert.ok(!/-Name\b/.test(commands[0]), `must never use -Name: ${commands[0]}`);
      assert.ok(!/headroom,mitmdump/.test(commands[0]), `must never name-kill: ${commands[0]}`);
    } finally {
      rmSync(oldDir, { recursive: true, force: true });
    }
  });
});

describe('stopManagedUvToolProcess (C4: no name-based serena/semble kill)', () => {
  const TOOL_DIR = 'C:\\Users\\dev\\AppData\\Roaming\\uv\\tools';

  it('is a no-op on non-windows platforms', () => {
    const kills = [];
    const result = stopManagedUvToolProcess('serena-agent', {
      os: 'darwin',
      toolDirFn: () => { throw new Error('should not resolve tool dir on non-windows'); },
      processListFn: () => { throw new Error('should not enumerate on non-windows'); },
      stopPidFn: (pid) => kills.push(pid),
    });
    assert.deepEqual(result, { stopped: [], skipped: [] });
    assert.deepEqual(kills, []);
  });

  it('does NOTHING (never name-kills) when the uv tool dir cannot be verified', () => {
    const kills = [];
    const result = stopManagedUvToolProcess('serena-agent', {
      os: 'windows',
      toolDirFn: () => null, // `uv tool dir` failed / uv not installed
      processListFn: () => { throw new Error('must not enumerate when tool dir unknown'); },
      stopPidFn: (pid) => kills.push(pid),
    });
    assert.deepEqual(kills, [], 'must never fall back to a name-kill');
    assert.deepEqual(result.stopped, []);
    assert.equal(result.unverified, true);
  });

  it('does NOT kill an unrelated same-named process (path not under the uv tool dir)', () => {
    const kills = [];
    const result = stopManagedUvToolProcess('semble', {
      os: 'windows',
      toolDirFn: () => TOOL_DIR,
      // A DIFFERENT semble.exe the user built elsewhere on the machine.
      processListFn: () => ([{
        pid: 4242,
        command: 'C:\\Users\\dev\\code\\semble\\target\\release\\semble.exe --serve',
        executablePath: 'C:\\Users\\dev\\code\\semble\\target\\release\\semble.exe',
        startTime: '2024-01-01T00:00:00.0000000+00:00',
      }]),
      stopPidFn: (pid) => kills.push(pid),
    });
    assert.deepEqual(kills, [], 'unrelated same-named process must never be killed');
    assert.deepEqual(result.stopped, []);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].pid, 4242);
  });

  it('does NOT kill a same-named process with no StartTime (stale/unverifiable)', () => {
    const kills = [];
    const result = stopManagedUvToolProcess('serena-agent', {
      os: 'windows',
      toolDirFn: () => TOOL_DIR,
      processListFn: () => ([{
        pid: 9999,
        command: `${TOOL_DIR}\\serena-agent\\Scripts\\serena-agent.exe`,
        executablePath: `${TOOL_DIR}\\serena-agent\\Scripts\\serena-agent.exe`,
        startTime: '', // not live / cannot verify
      }]),
      stopPidFn: (pid) => kills.push(pid),
    });
    assert.deepEqual(kills, []);
    assert.deepEqual(result.stopped, []);
    assert.equal(result.skipped.length, 1);
  });

  it('DOES stop a verified uv-tool-managed process running from the tool dir', () => {
    const kills = [];
    const result = stopManagedUvToolProcess('serena-agent', {
      os: 'windows',
      toolDirFn: () => TOOL_DIR,
      processListFn: () => ([
        {
          pid: 5555,
          command: `${TOOL_DIR}\\serena-agent\\Scripts\\serena-agent.exe start-mcp-server`,
          executablePath: `${TOOL_DIR}\\serena-agent\\Scripts\\serena-agent.exe`,
          startTime: '2024-06-01T12:00:00.0000000+00:00',
        },
        // A second, unrelated same-named process elsewhere — must be left alone.
        {
          pid: 6666,
          command: 'D:\\other\\serena-agent.exe',
          executablePath: 'D:\\other\\serena-agent.exe',
          startTime: '2024-06-01T12:00:00.0000000+00:00',
        },
      ]),
      stopPidFn: (pid) => kills.push(pid),
    });
    assert.deepEqual(kills, [5555], 'only the managed pid is stopped');
    assert.deepEqual(result.stopped, [5555]);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].pid, 6666);
  });

  it('does NOT stop a SIBLING tool dir that shares a name prefix (tools-backup vs tools)', () => {
    // Regression (I3): the ownership check used a bare substring match, so
    // `...\uv\tools-backup\semble.exe` matched the tool dir `...\uv\tools`
    // (the prefix `tools` is a substring of `tools-backup`). A PATH-COMPONENT
    // boundary match must reject the sibling.
    const kills = [];
    const result = stopManagedUvToolProcess('semble', {
      os: 'windows',
      toolDirFn: () => TOOL_DIR, // ...\uv\tools
      processListFn: () => ([{
        pid: 7777,
        command: 'C:\\Users\\dev\\AppData\\Roaming\\uv\\tools-backup\\semble\\Scripts\\semble.exe --serve',
        executablePath: 'C:\\Users\\dev\\AppData\\Roaming\\uv\\tools-backup\\semble\\Scripts\\semble.exe',
        startTime: '2024-06-01T12:00:00.0000000+00:00',
      }]),
      stopPidFn: (pid) => kills.push(pid),
    });
    assert.deepEqual(kills, [], 'a sibling tools-backup path must never be stopped');
    assert.deepEqual(result.stopped, []);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].pid, 7777);
  });

  it('DOES stop a genuine child under the tool dir at a component boundary (tools\\<x>)', () => {
    // Cross-separator + case variation must still match: the tool dir uses `\`,
    // the recorded command uses `/` and mixed case.
    const kills = [];
    const result = stopManagedUvToolProcess('semble', {
      os: 'windows',
      toolDirFn: () => TOOL_DIR, // ...\uv\tools
      processListFn: () => ([{
        pid: 8888,
        command: 'C:/Users/dev/AppData/Roaming/UV/Tools/semble/Scripts/semble.exe --serve',
        executablePath: 'C:/Users/dev/AppData/Roaming/UV/Tools/semble/Scripts/semble.exe',
        startTime: '2024-06-01T12:00:00.0000000+00:00',
      }]),
      stopPidFn: (pid) => kills.push(pid),
    });
    assert.deepEqual(kills, [8888], 'a genuine child of the tool dir must be stopped');
    assert.deepEqual(result.stopped, [8888]);
    assert.deepEqual(result.skipped, []);
  });

  it('default stop path targets the pid (Stop-Process -Id) and NEVER a process name', () => {
    const commands = [];
    stopManagedUvToolProcess('serena-agent', {
      os: 'windows',
      powershellExe: 'powershell.exe',
      toolDirFn: () => TOOL_DIR,
      processListFn: () => ([{
        pid: 5555,
        command: `${TOOL_DIR}\\serena-agent\\Scripts\\serena-agent.exe`,
        executablePath: `${TOOL_DIR}\\serena-agent\\Scripts\\serena-agent.exe`,
        startTime: '2024-06-01T12:00:00.0000000+00:00',
      }]),
      // capture what the DEFAULT stopPidFn would execute
      execSyncImpl: (cmd) => { commands.push(String(cmd)); return Buffer.from(''); },
    });

    assert.equal(commands.length, 1);
    assert.ok(commands[0].includes('Stop-Process -Id 5555'), `expected Stop-Process -Id: ${commands[0]}`);
    assert.ok(!/-Name\b/.test(commands[0]), `must never use -Name: ${commands[0]}`);
    assert.ok(!/Get-Process/.test(commands[0]), `must never enumerate by Get-Process name: ${commands[0]}`);
  });
});

describe('buildHeadroomStopExec — MYELIN_DIR-derived headroomBin injection safety', () => {
  const EVIL_BIN = "/evil/$(touch pwned)/`whoami`/'q'/root/venv/bin/headroom";

  it('passes the managed headroom binary path as a literal argv element (never interpolated into the script)', () => {
    const { file, args } = buildHeadroomStopExec({ port: 8787, headroomBin: EVIL_BIN });
    assert.equal(file, '/bin/bash');
    assert.equal(args[0], '-c');
    // The bin path is a positional parameter ($1), passed as its own opaque argv slot.
    assert.equal(args[3], EVIL_BIN, 'headroomBin is a literal, unmodified argv element');
    assert.equal(args[4], '8787');
    // The script itself references $1/$2 — it NEVER embeds the payload, so bash cannot expand it.
    const script = args[1];
    assert.ok(!script.includes('evil'), `script must not interpolate the bin path:\n${script}`);
    assert.ok(!script.includes('$(touch'), script);
    assert.ok(script.includes('bin="$1"') && script.includes('port="$2"'), script);
  });

  it('is inert against command substitution when actually executed (no side effect)', async () => {
    const { execFileSync } = await import('node:child_process');
    const marker = join(process.cwd(), `_headroom_stop_pwn_${randomBytes(4).toString('hex')}`);
    const bin = `/nope/$(touch ${marker})/headroom`;
    const { file, args } = buildHeadroomStopExec({ port: 65531, headroomBin: bin });
    try { execFileSync(file, args, { stdio: 'pipe' }); } catch { /* lsof/no match is fine */ }
    const { existsSync } = await import('node:fs');
    assert.ok(!existsSync(marker), 'command substitution in the bin path must NOT execute');
  });
});

describe('installCopilotSkills', () => {
  it('creates myelin-compact SKILL.md + symlink on POSIX', () => {
    const created = []; const links = [];
    installCopilotSkills({
      home: '/home/t', copilot: true, repoRoot: '/home/t/.myelin/repo', os: 'linux',
      managedRuntimeCommandPath: '/home/t/.myelin/bin/myelin',
      mkdirSyncImpl: () => {},
      writeFileSyncImpl: (p, c) => created.push([p, c]),
      symlinkSyncImpl: (s, d) => links.push([s, d]),
      copyFileSyncImpl: () => {},
      unlinkSyncImpl: () => {},
    });
    const skill = created.find(([p]) => p.includes('myelin-compact') && p.endsWith('SKILL.md'));
    assert.ok(skill, 'myelin-compact SKILL.md must be created');
    assert.ok(skill[1].includes('name: myelin-compact'), 'SKILL.md name field correct');
    const link = links.find(([, d]) => d.includes('compact-prepare.mjs'));
    assert.ok(link, 'compact-prepare.mjs symlink must be created');
    assert.ok(link[0].includes('compact-prepare.mjs'), `src must point to script: ${link[0]}`);
    assert.ok(!link[0].includes('~/tokenstack'), 'must NOT hardcode ~/tokenstack');
  });

  it('creates myelin-constitution SKILL.md with managed runtime path', () => {
    const created = [];
    installCopilotSkills({
      home: '/home/t', copilot: true, repoRoot: '/home/t/.myelin/repo', os: 'linux',
      managedRuntimeCommandPath: '/home/t/.myelin/bin/myelin',
      mkdirSyncImpl: () => {},
      writeFileSyncImpl: (p, c) => created.push([p, c]),
      symlinkSyncImpl: () => {}, copyFileSyncImpl: () => {}, unlinkSyncImpl: () => {},
    });
    const skill = created.find(([p]) => p.includes('myelin-constitution') && p.endsWith('SKILL.md'));
    assert.ok(skill, 'myelin-constitution SKILL.md must be created');
    assert.ok(skill[1].includes('/home/t/.myelin/bin/myelin'), 'must embed managed runtime path');
    assert.ok(!skill[1].includes('~/tokenstack'), 'must NOT hardcode ~/tokenstack');
  });

  it('copies compact-prepare.mjs on Windows instead of symlinking', () => {
    const copies = []; const links = [];
    installCopilotSkills({
      home: 'C:\\Users\\t', copilot: true, repoRoot: 'C:\\Users\\t\\.myelin\\repo', os: 'windows',
      managedRuntimeCommandPath: 'C:\\Users\\t\\.myelin\\bin\\myelin.cmd',
      mkdirSyncImpl: () => {},
      writeFileSyncImpl: () => {},
      symlinkSyncImpl: (s, d) => links.push([s, d]),
      copyFileSyncImpl: (s, d) => copies.push([s, d]),
      unlinkSyncImpl: () => {},
    });
    assert.ok(copies.some(([s]) => s.includes('compact-prepare.mjs')), 'must copy on Windows');
    assert.ok(!links.some(([, d]) => d.includes('compact-prepare.mjs')), 'must NOT symlink on Windows');
  });

  it('skips all skills when copilot=false', () => {
    const created = [];
    installCopilotSkills({
      home: '/home/t', copilot: false, repoRoot: '/home/t/.myelin/repo', os: 'linux',
      managedRuntimeCommandPath: '/home/t/.myelin/bin/myelin',
      mkdirSyncImpl: () => {}, writeFileSyncImpl: (p, c) => created.push([p, c]),
      symlinkSyncImpl: () => {}, copyFileSyncImpl: () => {}, unlinkSyncImpl: () => {},
    });
    assert.equal(created.length, 0, 'no writes when copilot=false');
  });
});
