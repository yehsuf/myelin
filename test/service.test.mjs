import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, chmodSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as windowsService from '../src/service/windows.mjs';
import {
  generatePlist,
  generateGenericPlist,
  generateLaunchdWatchdogScript,
  generateEngineInstancePlist,
  removeMitmService as removeLaunchdMitmService,
} from '../src/service/launchd.mjs';
import {
  generateSystemdUnit,
  generateCopilotHeadroomUnit,
  generateMitmUnit,
  generateEngineInstanceUnit,
  removeMitmService as removeSystemdMitmService,
} from '../src/service/systemd.mjs';
import {
  buildManagedHeadroomStopScript,
  HEADROOM_SERVICE_ID,
  collapseRedundantBackslashes,
  copilotHeadroomServiceStatus,
  defaultWindowsHome,
  engineInstanceStatus as windowsEngineInstanceStatus,
  generateEngineInstanceRemovalScript,
  generateEngineInstanceRunScript,
  generateEngineInstanceWinswConfig,
  generateCopilotHeadroomRunScript,
  generateHeadroomRunScript,
  generateMitmRunScript,
  generateManagedMitmRemovalScript,
  generateSetUserEnvVarsScript,
  generateWindowsWatchdogHealthcheckScript,
  generateWindowsWatchdogTaskDeleteScript,
  generateWindowsWatchdogTaskCreateScript,
  generateWinswConfigXml,
  buildManagedMitmStatusScript,
  installWatchdog as installWindowsWatchdog,
  mitmServiceStatus,
  parseManagedMitmStatus,
  parseWinswServiceStatus,
  normalizeWindowsFilesystemPath,
  resolveWslWindowsHome,
  removeEngineInstance as removeWindowsEngineInstance,
  removeMitmService,
  runPs,
  serviceStatus,
  spawnDetachedService,
  stopManagedHeadroomProcess,
  uninstallWindowsWatchdogTask,
  winswConfigPath,
  winswExecutablePath,
} from '../src/service/windows.mjs';
import { resolveGlobalBinDir, linkGlobalBin } from '../src/service/npmlink.mjs';

const OPTS = {
  headroomBin: '/home/user/.local/bin/headroom',
  port: 8787,
  envVars: { ANTHROPIC_API_KEY: 'sk-test', HEADROOM_PORT: '8787' },
  logPath: '/tmp/headroom.log',
  user: 'testuser',
};

const HEADROOM_LITE_FIXTURE = createHeadroomLiteFixture();
const EXTENSIONLESS_HEADROOM_LITE_FIXTURE = createHeadroomLiteFixture({ extensionlessEntrypoint: true });
const AMBIGUOUS_HEADROOM_LITE_FIXTURE = createAmbiguousHeadroomLiteFixture();

const ENGINE_BINS = {
  headroomBin: '/opt/myelin/bin/headroom',
  headroomLiteBin: HEADROOM_LITE_FIXTURE.bin,
};
const SERVICE_NODE_EXECUTABLE = '/opt/myelin/runtime/node';

function expectedSystemdArgument(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '$$$$')
    .replace(/%/g, '%%')}"`;
}

function createHeadroomLiteFixture({ extensionlessEntrypoint = false } = {}) {
  const root = mkdtempSync(join(process.cwd(), '.service test $headroom-lite-'));
  const packageDir = join(root, 'linked-packages', '@fixture', 'headroom-lite');
  const globalPackageLink = join(root, 'lib', 'node_modules', '@fixture', 'headroom-lite');
  const unrelatedPackageDir = join(root, 'lib', 'node_modules', '@aaa', 'cli');
  const entrypoint = join(packageDir, 'src', extensionlessEntrypoint ? 'index' : 'index.mjs');
  const rawShim = join(root, 'shims', 'headroom-lite');
  const bin = join(root, 'bin', 'headroom-lite');

  mkdirSync(join(unrelatedPackageDir, 'src'), { recursive: true });
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  mkdirSync(dirname(globalPackageLink), { recursive: true });
  mkdirSync(join(root, 'shims'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(unrelatedPackageDir, 'package.json'), JSON.stringify({
    name: '@aaa/cli',
    bin: { 'headroom-lite': './src/index.mjs' },
  }));
  writeFileSync(join(unrelatedPackageDir, 'src', 'index.mjs'), 'export {};\n');
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@fixture/headroom-lite',
    bin: { 'headroom-lite': extensionlessEntrypoint ? './src/index' : './src/index.mjs' },
  }));
  writeFileSync(entrypoint, `${extensionlessEntrypoint ? '#!/usr/bin/env node\n' : ''}export {};\n`);
  writeFileSync(rawShim, '#!/usr/bin/env node\nthrow new Error("shim must not run");\n');
  symlinkSync(packageDir, globalPackageLink, 'dir');
  symlinkSync(rawShim, bin);

  after(() => rmSync(root, { recursive: true, force: true }));
  return { bin, entrypoint, rawShim };
}

function createAmbiguousHeadroomLiteFixture() {
  const root = mkdtempSync(join(process.cwd(), '.service test ambiguous-headroom-lite-'));
  const bin = join(root, 'bin', 'headroom-lite');

  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(bin, '#!/usr/bin/env node\nthrow new Error("shim must not run");\n');
  for (const scope of ['@first', '@second']) {
    const packageDir = join(root, 'lib', 'node_modules', scope, 'headroom-lite');
    mkdirSync(join(packageDir, 'src'), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: `${scope}/headroom-lite`,
      bin: { 'headroom-lite': './src/index.mjs' },
    }));
    writeFileSync(join(packageDir, 'src', 'index.mjs'), 'export {};\n');
  }

  after(() => rmSync(root, { recursive: true, force: true }));
  return bin;
}

describe('runPs WSL script path', () => {
  it('writes the transient script through the Windows mount and invokes PowerShell with its native path', () => {
    const operations = [];

    runPs('Write-Host ready', {
      home: '/home/alice',
      isWslImpl: () => true,
      defaultWindowsHomeImpl: () => 'C:\\Users\\alice',
      powershellExe: 'powershell.exe',
      processId: 123,
      nowImpl: () => 456,
      mkdirSyncImpl: (path) => operations.push({ type: 'mkdir', path }),
      writeFileSyncImpl: (path, content) => operations.push({ type: 'write', path, content }),
      execSyncImpl: (command) => operations.push({ type: 'exec', command }),
      unlinkSyncImpl: (path) => operations.push({ type: 'unlink', path }),
    });

    const mountedScript = '/mnt/c/Users/alice/.myelin/state/myelin-123-456.ps1';
    const nativeScript = 'C:\\Users\\alice\\.myelin\\state\\myelin-123-456.ps1';
    assert.deepEqual(operations, [
      { type: 'mkdir', path: '/mnt/c/Users/alice/.myelin/state' },
      { type: 'write', path: mountedScript, content: 'Write-Host ready' },
      { type: 'exec', command: `powershell.exe -ExecutionPolicy Bypass -File "${nativeScript}"` },
      { type: 'unlink', path: mountedScript },
    ]);
  });

  it('canonicalizes a mounted MYELIN_DIR for Windows service scripts and environments', () => {
    const operations = [];
    const env = { MYELIN_DIR: '/mnt/c/Myelin' };

    runPs('Write-Host ready', {
      home: '/home/alice',
      env,
      isWslImpl: () => true,
      defaultWindowsHomeImpl: () => 'C:\\Users\\alice',
      powershellExe: 'powershell.exe',
      processId: 123,
      nowImpl: () => 456,
      mkdirSyncImpl: (path) => operations.push({ type: 'mkdir', path }),
      writeFileSyncImpl: (path, content) => operations.push({ type: 'write', path, content }),
      execSyncImpl: (command) => operations.push({ type: 'exec', command }),
      unlinkSyncImpl: (path) => operations.push({ type: 'unlink', path }),
    });

    assert.deepEqual(windowsService.withForwardedMyelinDir({}, env), {
      MYELIN_DIR: 'C:\\Myelin',
    });
    assert.deepEqual(operations, [
      { type: 'mkdir', path: '/mnt/c/Myelin/state' },
      { type: 'write', path: '/mnt/c/Myelin/state/myelin-123-456.ps1', content: 'Write-Host ready' },
      { type: 'exec', command: 'powershell.exe -ExecutionPolicy Bypass -File "C:\\Myelin\\state\\myelin-123-456.ps1"' },
      { type: 'unlink', path: '/mnt/c/Myelin/state/myelin-123-456.ps1' },
    ]);
  });
});

describe('WSL PowerShell registration paths', () => {
  const home = 'C:\\Users\\alice';

  it('passes the resolved Windows home to registry, WinSW, and watchdog PowerShell calls', async () => {
    const registryCalls = [];
    const winswCalls = [];
    const watchdogCalls = [];
    const instance = {
      engine: 'headroom',
      role: 'primary',
      id: 'headroom-primary',
      port: 8787,
      stateDir: 'C:\\Users\\alice\\.myelin\\state\\headroom-primary',
      logPath: 'C:\\Users\\alice\\.myelin\\headroom-primary.log',
      healthUrl: 'http://127.0.0.1:8787/health',
      env: {},
    };

    await windowsService.installEngineInstance(instance, {
      manager: 'registry',
      home,
      headroomBin: 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\headroom.exe',
      runPsFn: (script, options) => registryCalls.push({ script, options }),
    });
    await windowsService.installWinswService({
      id: instance.id,
      name: 'Myelin Headroom Primary',
      description: 'Myelin headroom primary',
      executable: 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\headroom.exe',
      arguments: 'proxy --port 8787',
      logPath: instance.logPath,
      workingDirectory: instance.stateDir,
      home,
      installWinswImpl: async () => ({
        path: 'C:\\Users\\alice\\.myelin\\bin\\winsw.exe',
        filesystemPath: '/mnt/c/Users/alice/.myelin/bin/winsw.exe',
      }),
      mkdirSyncImpl: () => {},
      existsSyncImpl: () => false,
      copyFileSyncImpl: () => {},
      writeFileSyncImpl: () => {},
      renameSyncImpl: () => {},
      unlinkSyncImpl: () => {},
      runPsFn: (script, options) => winswCalls.push({ script, options }),
    });
    windowsService.installWindowsWatchdogTask({
      id: instance.id,
      healthUrl: instance.healthUrl,
      home,
      existsSyncImpl: () => true,
      mkdirSyncImpl: () => {},
      writeFileSyncImpl: () => {},
      runPsFn: (script, options) => watchdogCalls.push({ script, options }),
    });

    assert.equal(registryCalls.length, 1);
    assert.match(registryCalls[0].script, /MyelinHeadroomPrimary/);
    assert.equal(registryCalls[0].options.home, home);
    assert.equal(winswCalls.length, 1);
    assert.match(winswCalls[0].script, /headroom-primary\.exe/);
    assert.equal(winswCalls[0].options.home, home);
    assert.equal(watchdogCalls.length, 1);
    assert.match(watchdogCalls[0].script, /Myelin Headroom Primary Watchdog/);
    assert.equal(watchdogCalls[0].options.home, home);
  });
});

function engineInstance(engine, role) {
  const port = role === 'primary' ? 8790 : 8788;
  return {
    engine,
    role,
    port,
    id: `${engine}-${role}`,
    stateDir: `/home/me/.myelin/state/${engine}-${role}`,
    logPath: `/home/me/.myelin/${engine}-${role}.log`,
    healthUrl: `http://127.0.0.1:${port}/health`,
    env: role === 'copilot'
      ? (engine === 'headroom_lite'
          ? { HEADROOM_LITE_UPSTREAM: 'http://127.0.0.1:8889' }
          : { ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889' })
      : {},
  };
}

describe('engine instance service generators', () => {
  it('defaults Lite launchd and systemd services to the current Node runtime', () => {
    const instance = engineInstance('headroom_lite', 'primary');
    const plist = generateEngineInstancePlist({ instance, ...ENGINE_BINS });
    const unit = generateEngineInstanceUnit({ instance, ...ENGINE_BINS });

    assert.ok(plist.includes(`exec '${process.execPath}' '${HEADROOM_LITE_FIXTURE.entrypoint}'`));
    assert.ok(unit.includes(`ExecStart=${expectedSystemdArgument(process.execPath)} ${expectedSystemdArgument(HEADROOM_LITE_FIXTURE.entrypoint)}`));
  });

  it('runs Lite launchd and systemd services with Node and a resolved JavaScript entrypoint', () => {
    const instance = engineInstance('headroom_lite', 'primary');
    const plist = generateEngineInstancePlist({
      instance,
      ...ENGINE_BINS,
      nodePath: SERVICE_NODE_EXECUTABLE,
    });
    const unit = generateEngineInstanceUnit({
      instance,
      ...ENGINE_BINS,
      nodePath: SERVICE_NODE_EXECUTABLE,
    });
    const expectedLaunchdCommand = `exec '${SERVICE_NODE_EXECUTABLE}' '${HEADROOM_LITE_FIXTURE.entrypoint}'`;
    const expectedSystemdCommand = `ExecStart=${expectedSystemdArgument(SERVICE_NODE_EXECUTABLE)} ${expectedSystemdArgument(HEADROOM_LITE_FIXTURE.entrypoint)}`;

    assert.ok(plist.includes(expectedLaunchdCommand));
    assert.ok(unit.includes(expectedSystemdCommand));
    assert.ok(!plist.includes(`exec '${HEADROOM_LITE_FIXTURE.rawShim}'`));
    assert.ok(!plist.includes('/usr/bin/env node'));
    assert.ok(!plist.includes('PATH='));
    assert.ok(!unit.includes(HEADROOM_LITE_FIXTURE.rawShim));
  });

  it('runs a metadata-declared extensionless Node CLI through absolute Node', () => {
    const instance = engineInstance('headroom_lite', 'primary');
    const unit = generateEngineInstanceUnit({
      instance,
      headroomBin: ENGINE_BINS.headroomBin,
      headroomLiteBin: EXTENSIONLESS_HEADROOM_LITE_FIXTURE.bin,
      nodePath: SERVICE_NODE_EXECUTABLE,
    });

    assert.ok(unit.includes(`ExecStart=${expectedSystemdArgument(SERVICE_NODE_EXECUTABLE)} ${expectedSystemdArgument(EXTENSIONLESS_HEADROOM_LITE_FIXTURE.entrypoint)}`));
    assert.ok(!unit.includes(EXTENSIONLESS_HEADROOM_LITE_FIXTURE.rawShim));
  });

  it('rejects ambiguous global Lite package metadata instead of choosing an arbitrary CLI', () => {
    const instance = engineInstance('headroom_lite', 'primary');

    assert.throws(
      () => generateEngineInstanceUnit({
        instance,
        headroomBin: ENGINE_BINS.headroomBin,
        headroomLiteBin: AMBIGUOUS_HEADROOM_LITE_FIXTURE,
      }),
      /multiple global headroom-lite package candidates/i,
    );
  });

  for (const engine of ['headroom', 'headroom_lite']) {
    for (const role of ['primary', 'copilot']) {
      const instance = engineInstance(engine, role);
      const expectedBinary = engine === 'headroom' ? ENGINE_BINS.headroomBin : HEADROOM_LITE_FIXTURE.entrypoint;
      const expectedWindowsBinary = engine === 'headroom' ? ENGINE_BINS.headroomBin : ENGINE_BINS.headroomLiteBin;
      const expectedLabel = role === 'primary' ? 'com.myelin.headroom' : 'com.myelin.copilot-headroom';
      const expectedServiceId = role === 'primary' ? 'myelin-headroom' : 'myelin-copilot-headroom';
      const expectedWindowsServiceId = instance.id;
      const expectedWindowsRunKey = `Myelin${instance.id.split(/[-_]/u)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join('')}`;

      it(`generates a ${engine} ${role} launchd service from its descriptor`, () => {
        const plist = generateEngineInstancePlist({
          instance,
          ...ENGINE_BINS,
          ...(engine === 'headroom_lite' ? { nodePath: SERVICE_NODE_EXECUTABLE } : {}),
        });
        if (engine === 'headroom_lite') {
          assert.ok(plist.includes(expectedBinary));
        } else {
          assert.match(plist, new RegExp(expectedBinary));
        }
        assert.match(plist, new RegExp(expectedLabel));
        assert.match(plist, new RegExp(instance.stateDir));
        assert.match(plist, new RegExp(instance.logPath));
        if (engine === 'headroom_lite') {
          assert.match(plist, /HEADROOM_LITE_PORT/);
          assert.doesNotMatch(plist, /\bheadroom proxy\b/);
        } else {
          assert.match(plist, new RegExp(`proxy.*--port.*${instance.port}`));
        }
      });

      it(`generates a ${engine} ${role} systemd service from its descriptor`, () => {
        const unit = generateEngineInstanceUnit({
          instance,
          ...ENGINE_BINS,
          ...(engine === 'headroom_lite' ? { nodePath: SERVICE_NODE_EXECUTABLE } : {}),
        });
        if (engine === 'headroom_lite') {
          assert.ok(unit.includes(expectedSystemdArgument(expectedBinary)));
        } else {
          assert.match(unit, new RegExp(expectedBinary));
        }
        assert.match(unit, new RegExp(expectedServiceId));
        assert.match(unit, new RegExp(`WorkingDirectory=${instance.stateDir}`));
        assert.match(unit, new RegExp(instance.logPath));
        if (engine === 'headroom_lite') {
          assert.match(unit, /Environment=HEADROOM_LITE_PORT=/);
          assert.doesNotMatch(unit, /\bheadroom proxy\b/);
        } else {
          assert.match(unit, new RegExp(`proxy --port ${instance.port}`));
        }
      });

      it(`generates a ${engine} ${role} registry service from its descriptor`, () => {
        const script = generateEngineInstanceRunScript({ instance, ...ENGINE_BINS });
        assert.match(script, new RegExp(expectedWindowsRunKey));
        assert.ok(script.includes(instance.stateDir.replace(/\//g, '\\')));
        if (engine === 'headroom_lite') {
          assert.match(script, /HEADROOM_LITE_PORT/);
          assert.doesNotMatch(script, /\bheadroom proxy\b/);
        } else {
          assert.match(script, new RegExp(`proxy --port ${instance.port}`));
        }
      });

      it(`generates a ${engine} ${role} WinSW service from its descriptor`, () => {
        const xml = generateEngineInstanceWinswConfig({ instance, ...ENGINE_BINS });
        assert.match(xml, new RegExp(`<id>${expectedWindowsServiceId}</id>`));
        assert.ok(xml.includes(expectedWindowsBinary.replace(/\//g, '\\')));
        assert.ok(xml.includes(instance.stateDir.replace(/\//g, '\\')));
        assert.ok(xml.includes(instance.logPath.replace(/\//g, '\\')));
        if (engine === 'headroom_lite') {
          assert.match(xml, /HEADROOM_LITE_PORT/);
          assert.doesNotMatch(xml, /\bheadroom proxy\b/);
        } else {
          assert.match(xml, new RegExp(`proxy --port ${instance.port}`));
        }
      });
    }
  }

  it('keeps Python Copilot descriptor routing authoritative over shared primary env vars', () => {
    const instance = {
      ...engineInstance('headroom', 'copilot'),
      env: {
        ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8999',
        OPENAI_TARGET_API_URL: 'http://127.0.0.1:8999',
        HEADROOM_MODE: 'aggressive',
        NO_PROXY: '127.0.0.1,localhost,::1',
      },
    };
    const primaryEnvVars = {
      ANTHROPIC_TARGET_API_URL: 'https://api.anthropic.com',
      OPENAI_TARGET_API_URL: 'https://api.githubcopilot.com',
      HEADROOM_MODE: 'cache',
      REQUESTS_CA_BUNDLE: '/etc/ssl/corp.pem',
    };
    const generated = [
      generateEngineInstancePlist({ instance, ...ENGINE_BINS, envVars: primaryEnvVars }),
      generateEngineInstanceUnit({ instance, ...ENGINE_BINS, envVars: primaryEnvVars }),
      generateEngineInstanceRunScript({ instance, ...ENGINE_BINS, envVars: primaryEnvVars }),
      generateEngineInstanceWinswConfig({ instance, ...ENGINE_BINS, envVars: primaryEnvVars }),
    ];

    for (const serviceDefinition of generated) {
      assert.match(serviceDefinition, /ANTHROPIC_TARGET_API_URL[\s\S]{0,80}http:\/\/127\.0\.0\.1:8999/);
      assert.match(serviceDefinition, /OPENAI_TARGET_API_URL[\s\S]{0,80}http:\/\/127\.0\.0\.1:8999/);
      assert.match(serviceDefinition, /HEADROOM_MODE[\s\S]{0,80}aggressive/);
      assert.match(serviceDefinition, /REQUESTS_CA_BUNDLE[\s\S]{0,80}\/etc\/ssl\/corp\.pem/);
      assert.doesNotMatch(serviceDefinition, /https:\/\/api\.(anthropic\.com|githubcopilot\.com)/);
    }
  });

  it('forwards a relocated MYELIN_DIR into launchd and systemd service env', () => {
    const instance = engineInstance('headroom', 'primary');
    const env = { MYELIN_DIR: '/srv/managed-myelin' };

    const plist = generateEngineInstancePlist({ instance, ...ENGINE_BINS, env });
    const unit = generateEngineInstanceUnit({ instance, ...ENGINE_BINS, env });

    assert.match(plist, /<key>MYELIN_DIR<\/key>\s*<string>\/srv\/managed-myelin<\/string>/);
    assert.match(unit, /Environment=MYELIN_DIR=\/srv\/managed-myelin/);
  });

  it('does not emit MYELIN_DIR when the managed root is not relocated', () => {
    const instance = engineInstance('headroom', 'primary');
    const env = {};

    const plist = generateEngineInstancePlist({ instance, ...ENGINE_BINS, env });
    const unit = generateEngineInstanceUnit({ instance, ...ENGINE_BINS, env });

    assert.ok(!plist.includes('MYELIN_DIR'));
    assert.ok(!unit.includes('MYELIN_DIR'));
  });

  it('keeps an explicit MYELIN_DIR env var authoritative over the forwarded root', () => {
    const instance = {
      ...engineInstance('headroom', 'primary'),
      env: { MYELIN_DIR: '/instance/override' },
    };
    const env = { MYELIN_DIR: '/srv/ambient' };

    const plist = generateEngineInstancePlist({ instance, ...ENGINE_BINS, env });
    const unit = generateEngineInstanceUnit({ instance, ...ENGINE_BINS, env });

    assert.match(plist, /<key>MYELIN_DIR<\/key>\s*<string>\/instance\/override<\/string>/);
    assert.ok(!plist.includes('/srv/ambient'));
    assert.match(unit, /Environment=MYELIN_DIR=\/instance\/override/);
    assert.ok(!unit.includes('/srv/ambient'));
  });
});

describe('Windows registry engine-instance ownership', () => {
  const LITE_INSTANCE = {
    engine: 'headroom_lite',
    role: 'primary',
    port: 8790,
    id: 'headroom_lite-primary',
    stateDir: 'C:\\Users\\alice\\.myelin\\state\\headroom_lite-primary',
    logPath: 'C:\\Users\\alice\\.myelin\\headroom_lite-primary.log',
    healthUrl: 'http://127.0.0.1:8790/health',
    env: {},
  };

  it('parses a Lite registry launcher with empty arguments', () => {
    const commands = [];
    const status = windowsEngineInstanceStatus(LITE_INSTANCE, {
      manager: 'registry',
      execSyncImpl: (command) => {
        commands.push(command);
        if (command.includes('Get-Content -Path') && command.includes('start-headroom_lite-primary.ps1')) {
          return Buffer.from("Start-Process -FilePath 'C:\\Users\\alice\\.myelin\\bin\\headroom-lite.exe' -ArgumentList '' -WorkingDirectory 'C:\\Users\\alice\\.myelin\\state\\headroom_lite-primary' -WindowStyle Hidden -PassThru");
        }
        if (command.includes('headroom_lite-primary.pid')) return Buffer.from('4321\n');
        return Buffer.from('Running\n');
      },
      runKeyStatusImpl: () => ({
        registered: true,
        raw: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.myelin\\state\\headroom_lite-primary\\start-headroom_lite-primary.ps1"',
      }),
      existsSyncImpl: () => false,
      readFileSyncImpl: () => {
        throw new Error('Windows launcher should be read through PowerShell');
      },
    });

    assert.equal(status.running, true);
    assert.ok(commands.some((command) => command.includes("Name -ieq 'headroom-lite.exe'")));
  });

  it('only stops a registry process whose parent is the managed launcher', () => {
    const script = generateEngineInstanceRunScript({
      instance: LITE_INSTANCE,
      headroomLiteBin: 'C:\\Users\\alice\\.myelin\\bin\\headroom-lite.exe',
    });

    assert.ok(script.includes('$previousLauncherMatches = $false'));
    assert.ok(script.includes('$previousCommandMatches = $false'));
    assert.ok(script.includes('$previousOwnsPort'));
    assert.ok(script.includes('ParentProcessId'));
    assert.ok(script.includes('$previousProcess.ExecutablePath -eq $previousLauncherExecutable'));
  });

  it('keeps a replacement launcher PID file when an earlier launcher exits', () => {
    const script = generateEngineInstanceRunScript({
      instance: LITE_INSTANCE,
      headroomLiteBin: 'C:\\Users\\alice\\.myelin\\bin\\headroom-lite.exe',
    });

    assert.ok(script.includes('$recordedPid -eq $proc.Id'));
  });

  it('tracks the listening child rather than cmd.exe for a Lite .cmd launcher', () => {
    const script = generateEngineInstanceRunScript({
      instance: LITE_INSTANCE,
      headroomLiteBin: 'C:\\Users\\alice\\.myelin\\bin\\headroom-lite.cmd',
    });

    assert.match(script, /Start-Process -FilePath 'cmd\.exe' -ArgumentList '\/d \/s \/c ""C:\\Users\\alice\\\.myelin\\bin\\headroom-lite\.cmd""'/);
    assert.match(script, /Get-NetTCPConnection -State Listen -LocalPort 8790/);
    assert.match(script, /\$ancestor\.ProcessId -eq \$proc\.Id/);
    assert.match(script, /Set-Content -Path .* -Value \$managedProcess\.ProcessId/);
    assert.match(script, /Wait-Process -Id \$managedProcess\.ProcessId/);
    assert.doesNotMatch(script, /Set-Content -Path .* -Value \$proc\.Id/);
    assert.match(script, /\$proc\.Refresh\(\)/);
    assert.match(script, /while \(-not \$managedProcess -and -not \$proc\.HasExited\)/);
    assert.doesNotMatch(script, /\$deadline/);
  });

  it('keeps cmd-shim ownership checks on the target shim during status and removal', () => {
    const script = generateEngineInstanceRemovalScript({
      instance: LITE_INSTANCE,
      home: 'C:\\Users\\alice',
    });

    assert.match(script, /\$myelinBatchTarget/);
    assert.match(script, /Name -ieq 'cmd\.exe'/);
    assert.match(script, /CommandLine -match \[regex\]::Escape\(\$launcherExecutable\)/);
  });

  it('proves a previous descriptor using its recorded executable type before replacing it', () => {
    const script = generateEngineInstanceRunScript({
      instance: LITE_INSTANCE,
      headroomLiteBin: 'C:\\Users\\alice\\.myelin\\bin\\headroom-lite.cmd',
    });

    assert.ok(script.includes("$previousIsBatch = $previousLauncherExecutable -match '\\.(?:cmd|bat)$'"));
    assert.match(script, /\$previousLauncherArguments = \[regex\]::Match/);
    assert.match(script, /if \(\$previousIsBatch\)/);
    assert.match(script, /\$previousTrackedProcess =/);
    assert.match(script, /\$previousTrackedMatches = \$false/);
    assert.match(script, /Stop-Process -Id \$previousProcess\.ProcessId/);
    assert.match(script, /\$previousProcess\.ExecutablePath -eq \$previousLauncherExecutable/);
  });

  it('uses the launcher port and proven cmd ancestry for .cmd listener status after a port transition', () => {
    const statusCommands = [];
    const transitionedInstance = { ...LITE_INSTANCE, port: 9790, healthUrl: 'http://127.0.0.1:9790/health' };
    const launcherPath = 'C:\\Users\\alice\\.myelin\\state\\headroom_lite-primary\\start-headroom_lite-primary.ps1';
    const launcherScript = [
      "$env:HEADROOM_LITE_PORT = '8790'",
      "Start-Process -FilePath 'C:\\Users\\alice\\.myelin\\bin\\headroom-lite.cmd' -ArgumentList '' -WorkingDirectory 'C:\\Users\\alice\\.myelin\\state\\headroom_lite-primary' -WindowStyle Hidden -PassThru",
    ].join('\n');

    const status = windowsEngineInstanceStatus(transitionedInstance, {
      manager: 'registry',
      runKeyStatusImpl: () => ({
        registered: true,
        raw: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${launcherPath}"`,
      }),
      existsSyncImpl: () => true,
      readFileSyncImpl: (path) => String(path).endsWith('.pid') ? '4321\n' : launcherScript,
      execSyncImpl: (command) => {
        statusCommands.push(command);
        return Buffer.from('Running\n');
      },
    });

    assert.equal(status.running, true);
    const statusCommand = statusCommands.at(-1);
    assert.match(statusCommand, /\$launcherPort = 8790/);
    assert.match(statusCommand, /Get-NetTCPConnection -State Listen -LocalPort \$launcherPort/);
    assert.doesNotMatch(statusCommand, /\$launcherPort = 9790/);
    assert.match(statusCommand, /\$trackedProcess =/);
    assert.match(statusCommand, /\$trackedMatches = \$false/);
    assert.match(statusCommand, /Name -ieq 'cmd\.exe'/);
    assert.match(statusCommand, /\$commandMatches/);
    assert.match(statusCommand, /ParentProcessId/);
  });
});

describe('Windows engine descriptor migration ownership', () => {
  const COPILOT_INSTANCE = {
    engine: 'headroom',
    role: 'copilot',
    port: 9797,
    id: 'headroom-copilot',
    stateDir: 'C:\\Users\\alice\\.myelin\\state\\headroom-copilot',
    logPath: 'C:\\Users\\alice\\.myelin\\headroom-copilot.log',
    healthUrl: 'http://127.0.0.1:9797/health',
    env: {},
  };
  const HOME = 'C:\\Users\\alice';

  it('removes the verified legacy Copilot registration from its legacy launcher location', () => {
    const scripts = [];

    removeWindowsEngineInstance(COPILOT_INSTANCE, {
      manager: 'registry',
      home: HOME,
      runPsFn: (script) => scripts.push(script),
      uninstallWindowsWatchdogTaskImpl: () => {},
    });

    assert.equal(scripts.length, 2);
    assert.ok(scripts[0].includes('state\\headroom-copilot\\start-headroom-copilot.ps1'));
    assert.ok(scripts[1].includes('.myelin\\copilot-headroom\\start-copilot-headroom.ps1'));
    assert.ok(scripts[1].includes("MyelinCopilotHeadroom"));
    assert.ok(scripts[1].includes('ParentProcessId'));
    assert.ok(scripts[1].includes('ExecutablePath -eq $launcherExecutable'));
  });

  it('discovers a registered launcher port instead of trusting a replacement descriptor port', () => {
    const script = generateEngineInstanceRemovalScript({ instance: COPILOT_INSTANCE, home: HOME });

    assert.match(script, /\$launcherPort = \[int\]\$portMatch\.Groups\[1\]\.Value/);
    assert.match(script, /Get-NetTCPConnection -State Listen -LocalPort \$launcherPort/);
    assert.doesNotMatch(script, /Get-NetTCPConnection -State Listen -LocalPort 9797/);
  });

  it('removes a .cmd listener child only after proving cmd and launcher ancestry', () => {
    const script = generateEngineInstanceRemovalScript({
      instance: { ...COPILOT_INSTANCE, engine: 'headroom_lite', id: 'headroom_lite-copilot' },
      home: HOME,
    });

    assert.match(script, /\$cmdLauncher = \$launcherExecutable -match '\\\.\(\?:cmd\|bat\)\$'/);
    assert.match(script, /\$commandMatches/);
    assert.match(script, /\$ancestor\.Name -ieq 'cmd\.exe'/);
    assert.match(script, /\$ancestor\.CommandLine -match \[regex\]::Escape\(\$launcherExecutable\)/);
    assert.match(script, /\$launcherMatches/);
    assert.match(script, /Get-NetTCPConnection -State Listen -LocalPort \$launcherPort/);
    assert.match(script, /\$ownedProcess = \$null/);
    assert.match(script, /\$trackedMatches = \$false/);
    assert.match(script, /Stop-Process -Id \$ownedProcess\.ProcessId/);
  });

  it('falls back to a verified Lite listener when a stale pid file cannot establish ownership', () => {
    const script = generateEngineInstanceRemovalScript({
      instance: { ...COPILOT_INSTANCE, engine: 'headroom_lite', id: 'headroom_lite-copilot' },
      home: HOME,
    });

    assert.match(script, /\$liteFallbackPort/);
    assert.match(script, /HEADROOM_LITE_PORT/);
    assert.match(script, /\$liteFallbackLauncherMatches/);
    assert.match(script, /\$liteFallbackCommandMatches/);
    assert.match(script, /Get-NetTCPConnection -State Listen -LocalPort \$liteFallbackPort/);
  });

  it('uninstalls an owned WinSW descriptor whose verified configuration uses the old port', () => {
    const uninstalled = [];
    const oldPortConfig = [
      '<service>',
      '  <id>headroom-copilot</id>',
      '  <executable>C:\\Users\\alice\\.myelin\\bin\\headroom.exe</executable>',
      '  <arguments>proxy --port 8788</arguments>',
      '  <workingdirectory>C:\\Users\\alice\\.myelin\\state\\headroom-copilot</workingdirectory>',
      '</service>',
    ].join('\n');

    removeWindowsEngineInstance(COPILOT_INSTANCE, {
      manager: 'winsw',
      home: HOME,
      existsSyncImpl: (path) => path.includes('headroom-copilot'),
      readFileSyncImpl: () => oldPortConfig,
      uninstallWindowsWatchdogTaskImpl: () => {},
      uninstallWinswServiceImpl: ({ id }) => {
        uninstalled.push(id);
        return true;
      },
      runPsFn: () => {},
    });

    assert.deepEqual(uninstalled, ['headroom-copilot']);
  });

  it('removes an owned WinSW descriptor before registry setup during a WinSW-to-registry transition', () => {
    const events = [];
    const ownedConfig = [
      '<service>',
      '  <id>headroom-copilot</id>',
      '  <executable>C:\\Users\\alice\\.myelin\\bin\\headroom.exe</executable>',
      '  <arguments>proxy --port 8788</arguments>',
      '  <workingdirectory>C:\\Users\\alice\\.myelin\\state\\headroom-copilot</workingdirectory>',
      '</service>',
    ].join('\n');

    removeWindowsEngineInstance(COPILOT_INSTANCE, {
      manager: 'registry',
      home: HOME,
      existsSyncImpl: (path) => path.includes('headroom-copilot'),
      readFileSyncImpl: () => ownedConfig,
      uninstallWindowsWatchdogTaskImpl: () => {},
      uninstallWinswServiceImpl: ({ id }) => {
        events.push(`winsw:${id}`);
        return true;
      },
      runPsFn: () => events.push('registry'),
    });

    assert.deepEqual(events, ['winsw:headroom-copilot', 'registry', 'registry']);
  });

  it('removes registry launchers during a registry-to-WinSW transition', () => {
    const scripts = [];

    removeWindowsEngineInstance(COPILOT_INSTANCE, {
      manager: 'winsw',
      home: HOME,
      existsSyncImpl: () => false,
      uninstallWindowsWatchdogTaskImpl: () => {},
      uninstallWinswServiceImpl: () => {
        throw new Error('no WinSW descriptor should be removed');
      },
      runPsFn: (script) => scripts.push(script),
    });

    assert.equal(scripts.length, 2);
    assert.ok(scripts[0].includes('state\\headroom-copilot\\start-headroom-copilot.ps1'));
    assert.ok(scripts[1].includes('.myelin\\copilot-headroom\\start-copilot-headroom.ps1'));
  });

  it('does not uninstall an unowned WinSW descriptor during a WinSW-to-registry transition', () => {
    const uninstalled = [];
    const scripts = [];

    removeWindowsEngineInstance(COPILOT_INSTANCE, {
      manager: 'registry',
      home: HOME,
      existsSyncImpl: () => true,
      readFileSyncImpl: () => '<service><id>other-service</id></service>',
      uninstallWindowsWatchdogTaskImpl: () => {},
      uninstallWinswServiceImpl: ({ id }) => uninstalled.push(id),
      runPsFn: (script) => scripts.push(script),
    });

    assert.deepEqual(uninstalled, []);
    assert.equal(scripts.length, 2);
  });

  it('uninstalls an owned WinSW Lite descriptor configured with a .cmd executable', () => {
    const uninstalled = [];
    const cmdLiteInstance = {
      ...COPILOT_INSTANCE,
      engine: 'headroom_lite',
      id: 'headroom_lite-copilot',
      stateDir: 'C:\\Users\\alice\\.myelin\\state\\headroom_lite-copilot',
    };
    const cmdConfig = [
      '<service>',
      '  <id>headroom_lite-copilot</id>',
      '  <executable>cmd.exe</executable>',
      '  <arguments>/d /s /c &quot;&quot;C:\\Users\\alice\\.myelin\\bin\\headroom-lite.cmd&quot;&quot;</arguments>',
      '  <env name="HEADROOM_LITE_PORT" value="8788"/>',
      '  <workingdirectory>C:\\Users\\alice\\.myelin\\state\\headroom_lite-copilot</workingdirectory>',
      '</service>',
    ].join('\n');

    removeWindowsEngineInstance(cmdLiteInstance, {
      manager: 'winsw',
      home: HOME,
      existsSyncImpl: (path) => path.includes('headroom_lite-copilot'),
      readFileSyncImpl: () => cmdConfig,
      uninstallWindowsWatchdogTaskImpl: () => {},
      uninstallWinswServiceImpl: ({ id }) => {
        uninstalled.push(id);
        return true;
      },
      runPsFn: () => {},
    });

    assert.deepEqual(uninstalled, ['headroom_lite-copilot']);
  });

  it('removes a stale direct legacy Run-key registration without stopping an ambiguous listener', () => {
    const scripts = [];

    removeWindowsEngineInstance({
      engine: 'headroom',
      role: 'primary',
      port: 8787,
      id: 'headroom-primary',
      legacy: true,
      stateDir: 'C:\\Users\\alice\\.myelin\\services\\myelin-headroom',
      logPath: 'C:\\Users\\alice\\.myelin\\headroom.log',
      healthUrl: 'http://127.0.0.1:8787/health',
    }, {
      manager: 'registry',
      home: HOME,
      runPsFn: (script) => scripts.push(script),
      uninstallWindowsWatchdogTaskImpl: () => {},
    });

    assert.equal(scripts.length, 1);
    assert.match(scripts[0], /\$legacyRunKeyValue =/);
    // Direct Run-key commands predate launcher/PID ownership markers. Migration
    // deliberately leaves an indistinguishable user-started listener running.
    assert.doesNotMatch(scripts[0], /if \(\$legacyExecutable -and \$legacyArguments -and \$legacyPort\)/);
    assert.match(scripts[0], /if \(\$legacyLauncherMatches -and \$legacyExecutable -and \$legacyArguments -and \$legacyPort\)/);
    assert.match(scripts[0], /Remove-ItemProperty -Path .* -Name \$runKey/);
  });

  it('requires launcher ancestry before stopping a managed legacy launcher listener', () => {
    const script = generateEngineInstanceRemovalScript({
      instance: {
        engine: 'headroom',
        role: 'primary',
        port: 8787,
        id: 'headroom-primary',
        legacy: true,
        stateDir: 'C:\\Users\\alice\\.myelin\\services\\myelin-headroom',
        logPath: 'C:\\Users\\alice\\.myelin\\headroom-primary.log',
        healthUrl: 'http://127.0.0.1:8787/health',
      },
      home: HOME,
    });

    assert.ok(script.includes('$legacyLauncherAncestorMatches = $false'));
    assert.ok(script.includes('$ancestor.CommandLine -match [regex]::Escape($launcherPath)'));
    assert.ok(script.includes('$candidate -and $legacyLauncherAncestorMatches'));
  });

  it('recognizes only its exact old Copilot launcher path while stopping the owned listener', () => {
    const script = generateEngineInstanceRemovalScript({
      instance: {
        ...COPILOT_INSTANCE,
        legacy: true,
        stateDir: 'C:\\Users\\alice\\.myelin\\copilot-headroom',
      },
      home: HOME,
    });

    assert.match(script, /\$legacyLauncherMatch = \[regex\]::Match\(\[string\]\$legacyRunKeyValue/);
    assert.match(script, /start-copilot-headroom\.ps1/);
    assert.match(script, /\$legacyLauncherMatch\.Groups\['launcher'\]\.Value -ieq \$launcherPath/);
    assert.match(script, /Get-Content -Path \$launcherPath -Raw/);
    assert.match(script, /Remove-ItemProperty -Path .* -Name \$runKey/);
  });
});


describe('generateLaunchdWatchdogScript', () => {
  it('omits MITM probes when no MITM port is active', () => {
    const script = generateLaunchdWatchdogScript({
      home: '/Users/alice',
      headroomPort: 8787,
    });

    assert.ok(!script.includes("check_and_revive 8888 mitmproxy '*.mitmproxy.plist'"));
    assert.ok(!script.includes("check_and_revive 8889 mitmproxy-egress '*.mitmproxy.plist'"));
    assert.ok(script.includes("check_and_revive 8787 headroom '*.headroom.plist'"));
  });

  it('omits the main Headroom stanza when headroomPort is undefined', () => {
    const script = generateLaunchdWatchdogScript({
      home: '/Users/alice',
      headroomPort: undefined,
      mitmPort: 8888,
      copilotHeadroomPort: 8788,
      egressPort: 8889,
    });

    assert.ok(script.includes("check_and_revive 8888 mitmproxy '*.mitmproxy.plist'"));
    assert.ok(!script.includes("check_and_revive 8787 headroom '*.headroom.plist'"));
    assert.ok(script.includes("check_and_revive 8788 copilot-headroom '*.copilot-headroom.plist'"));
  });

  it('preserves the main Headroom stanza when an explicit headroom port is provided', () => {
    const script = generateLaunchdWatchdogScript({
      home: '/Users/alice',
      headroomPort: 8787,
      mitmPort: 8888,
    });

    assert.ok(script.includes("check_and_revive 8787 headroom '*.headroom.plist'"));
  });

  it('monitors primary at the headroom_lite port (*.headroom.plist glob matches both engines)', () => {
    const script = generateLaunchdWatchdogScript({
      home: '/Users/alice',
      headroomPort: 8790,
      mitmPort: 8888,
    });

    assert.ok(script.includes("check_and_revive 8790 headroom '*.headroom.plist'"),
      'watchdog must check the headroom_lite primary port');
    assert.ok(!script.includes('check_and_revive 8787'), 'must not include stale Python headroom port');
  });
});

describe('launchd plist generator', () => {
  it('contains the label', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('com.myelin.headroom'));
  });
  it('contains the binary path', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes(OPTS.headroomBin));
  });
  it('contains the port argument', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('8787'));
  });
  it('contains KeepAlive key', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('<key>KeepAlive</key>'));
  });
  it('contains env var', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('HEADROOM_PORT'));
  });
  it('omits --intercept-tool-results flag by default (uses env var instead)', () => {
    const xml = generatePlist(OPTS);
    assert.ok(!xml.includes('--intercept-tool-results'), 'flag not in plist args');
  });
  it('sets HEADROOM_INTERCEPT_ENABLED=1 env var when interceptToolResults=true', () => {
    const xml = generatePlist({ ...OPTS, interceptToolResults: true });
    assert.ok(xml.includes('HEADROOM_INTERCEPT_ENABLED'), 'env var present');
    assert.ok(xml.includes('1'), 'value is 1');
    assert.ok(!xml.includes('--intercept-tool-results'), 'flag not in args');
  });
});

describe('generateGenericPlist (mitmproxy / copilot-headroom launchd)', () => {
  const GENERIC_OPTS = {
    label: 'com.myelin.copilot-headroom',
    command: '/home/user/.venv/bin/headroom',
    args: ['proxy', '--port', '8788'],
    envVars: { ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889' },
    logPath: '/tmp/copilot-headroom.log',
  };
  it('omits WorkingDirectory key when not provided (backward compatible)', () => {
    const xml = generateGenericPlist(GENERIC_OPTS);
    assert.ok(!xml.includes('<key>WorkingDirectory</key>'));
  });
  it('adds WorkingDirectory key when provided (state isolation between instances)', () => {
    const xml = generateGenericPlist({ ...GENERIC_OPTS, workingDirectory: '/home/user/.myelin/copilot-headroom' });
    assert.ok(xml.includes('<key>WorkingDirectory</key>'));
    assert.ok(xml.includes('/home/user/.myelin/copilot-headroom'));
  });
  it('contains the label and args', () => {
    const xml = generateGenericPlist(GENERIC_OPTS);
    assert.ok(xml.includes('com.myelin.copilot-headroom'));
    assert.ok(xml.includes('--port'));
    assert.ok(xml.includes('8788'));
  });
});

describe('systemd unit generator', () => {
  it('contains ExecStart with binary', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('ExecStart=' + OPTS.headroomBin));
  });
  it('contains Restart=always', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('Restart=always'));
  });
  it('contains WantedBy=default.target', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('WantedBy=default.target'));
  });
  it('contains env var', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('HEADROOM_PORT'));
  });
  it('omits --intercept-tool-results flag (uses HEADROOM_INTERCEPT_ENABLED env var)', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(!unit.includes('--intercept-tool-results'), 'flag not in ExecStart');
  });
  it('sets HEADROOM_INTERCEPT_ENABLED=1 env var when interceptToolResults=true', () => {
    const unit = generateSystemdUnit({ ...OPTS, interceptToolResults: true });
    assert.ok(unit.includes('HEADROOM_INTERCEPT_ENABLED=1'), 'env var set');
    assert.ok(!unit.includes('--intercept-tool-results'), 'flag not in ExecStart');
  });
});

describe('systemd copilot-headroom unit generator', () => {
  const CH_OPTS = {
    headroomBin: OPTS.headroomBin,
    port: 8788,
    mode: 'cache',
    workingDirectory: '/home/user/.myelin/copilot-headroom',
    envVars: { ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889' },
  };
  it('contains WorkingDirectory pointing at the isolated state dir', () => {
    const unit = generateCopilotHeadroomUnit(CH_OPTS);
    assert.ok(unit.includes('WorkingDirectory=/home/user/.myelin/copilot-headroom'));
  });
  it('uses engine-owned proxy arguments without a role-specific mode', () => {
    const unit = generateCopilotHeadroomUnit(CH_OPTS);
    assert.ok(unit.includes('--port 8788'));
    assert.ok(!unit.includes('--mode cache'));
  });
  it('has a distinct description from the Claude-Headroom unit', () => {
    const unit = generateCopilotHeadroomUnit(CH_OPTS);
    assert.ok(unit.includes('Copilot-Headroom'));
  });
});

describe('systemd mitm unit generator — egress dual-listener', () => {
  it('supports ingress plus loopback-bound egress listener args', () => {
    const args = ['--mode', 'regular@8888', '--mode', 'regular@127.0.0.1:8889', '-s', '/path/addon.py'];
    const unit = generateMitmUnit({ mitmdumpBin: '/usr/bin/mitmdump', args });
    assert.ok(unit.includes('regular@8888'));
    assert.ok(unit.includes('regular@127.0.0.1:8889'));
  });
});

describe('windows run-script generator', () => {
  it('buildManagedHeadroomStopScript only targets Myelin-managed headroom proxy processes', () => {
    const script = buildManagedHeadroomStopScript({ port: 8787 });
    assert.ok(script.includes(`$pidPath =`));
    assert.ok(script.includes(`Get-Content -Path $pidPath`));
    assert.ok(script.includes(`ProcessId = $managedPid`));
    assert.ok(script.includes('ParentProcessId'));
    assert.ok(script.includes('start-headroom\\.ps1'));
    assert.ok(script.includes('proxy'));
    assert.ok(script.includes(`if ($matchesManagedLauncher) {`));
    assert.ok(script.includes(`Remove-Item -Path $pidPath -ErrorAction SilentlyContinue`));
    assert.ok(!script.includes('$matchesCurrentPort'));
    assert.ok(!script.includes('Get-NetTCPConnection'));
    assert.ok(!script.includes('OwningProcess'));
  });

  it('contains registry run key name', () => {
    const script = generateHeadroomRunScript(OPTS);
    assert.ok(script.includes('MyelinHeadroom'));
  });
  it('contains command path', () => {
    const script = generateHeadroomRunScript(OPTS);
    assert.ok(script.includes(OPTS.headroomBin.replace(/\//g, '\\')));
  });
  it('contains port argument', () => {
    const script = generateHeadroomRunScript(OPTS);
    assert.ok(script.includes('8787'));
  });
  it('omits --intercept-tool-results flag (uses HEADROOM_INTERCEPT_ENABLED env var)', () => {
    const script = generateHeadroomRunScript(OPTS);
    assert.ok(!script.includes('--intercept-tool-results'), 'flag not in script');
  });
  it('sets HEADROOM_INTERCEPT_ENABLED=1 env var when interceptToolResults passed via envVars', () => {
    const script = generateHeadroomRunScript({ ...OPTS, envVars: { HEADROOM_INTERCEPT_ENABLED: '1' } });
    assert.ok(script.includes('HEADROOM_INTERCEPT_ENABLED'), 'env var in script');
    assert.ok(!script.includes('--intercept-tool-results'), 'flag not in script');
  });
  it('stops only the process matching this exact port (not all headroom.exe instances)', () => {
    const script = generateHeadroomRunScript(OPTS);
    assert.ok(script.includes(`--port ${OPTS.port}`));
    assert.ok(script.includes('Win32_Process'));
    assert.ok(!script.includes('Stop-Process -Name headroom '));
  });
  it('injects envVars as $env: assignments before Start-Process', () => {
    const script = generateHeadroomRunScript({
      ...OPTS,
      envVars: { OPENAI_TARGET_API_URL: 'https://api.githubcopilot.com', HEADROOM_MODE: 'cache' },
    });
    assert.ok(script.includes("$env:OPENAI_TARGET_API_URL = 'https://api.githubcopilot.com'"), 'OPENAI_TARGET_API_URL set');
    assert.ok(script.includes("$env:HEADROOM_MODE = 'cache'"), 'HEADROOM_MODE set');
    // env block must appear BEFORE Start-Process
    const envIdx  = script.indexOf('$env:OPENAI_TARGET_API_URL');
    const startIdx = script.indexOf('Start-Process');
    assert.ok(envIdx < startIdx, 'env block before Start-Process');
  });
  it('skips empty envVars values', () => {
    const script = generateHeadroomRunScript({ ...OPTS, envVars: { EMPTY_VAR: '', REAL_VAR: 'value' } });
    assert.ok(!script.includes('$env:EMPTY_VAR'), 'empty value not emitted');
    assert.ok(script.includes("$env:REAL_VAR = 'value'"), 'non-empty value emitted');
  });
  it('escapes single quotes in envVar values', () => {
    const script = generateHeadroomRunScript({ ...OPTS, envVars: { MY_VAR: "it's here" } });
    assert.ok(script.includes("$env:MY_VAR = 'it''s here'"), 'single quote escaped');
  });

  it('clears a stale direct Myelin Run-key without using it to identify a listener', () => {
    let command = '';
    stopManagedHeadroomProcess({
      port: 8787,
      execSyncImpl: (value) => {
        command = value;
        return Buffer.from('');
      },
      headroomRunKeyStatusImpl: () => ({
        registered: true,
        raw: '"C:\\Users\\alice\\.myelin\\bin\\headroom.exe" proxy --port 8787',
      }),
    });
    assert.ok(command.includes('ProcessId = $managedPid'));
    // Direct Run-key commands have no durable process ownership proof, so a
    // migration removes only their stale registration.
    assert.doesNotMatch(command, /C:\\Users\\alice\\\.myelin\\bin\\headroom\.exe/);
    assert.ok(command.includes(`Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'MyelinHeadroom' -ErrorAction SilentlyContinue`));
  });

  it('removes a direct legacy registration after a port migration without stopping a matching listener', () => {
    let command = '';
    stopManagedHeadroomProcess({
      port: 9797,
      execSyncImpl: (value) => {
        command = value;
        return Buffer.from('');
      },
      headroomRunKeyStatusImpl: () => ({
        registered: true,
        raw: '"C:\\Users\\alice\\.myelin\\bin\\headroom.exe" proxy --port 8787',
      }),
    });
    assert.ok(command.includes('ProcessId = $managedPid'));
    assert.ok(command.includes(`Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'MyelinHeadroom' -ErrorAction SilentlyContinue`));
    assert.doesNotMatch(command, /C:\\Users\\alice\\\.myelin\\bin\\headroom\.exe/);
  });
});

describe('copilotHeadroomServiceStatus', () => {
  it('uses the configured custom port when checking registry-managed status', () => {
    const commands = [];
    const status = copilotHeadroomServiceStatus({
      manager: 'registry',
      port: 9797,
      execSyncImpl: (command) => {
        commands.push(command);
        if (command.includes('Get-Content -Path')) {
          return Buffer.from([
            "# Managed by myelin. Keeps Copilot-Headroom env scoped to this process tree.",
            "Start-Process -FilePath 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe' -ArgumentList 'proxy --port 9797 --mode observe --connect-timeout-seconds 10' -WorkingDirectory 'C:\\Users\\alice\\.myelin\\headroom-copilot-9797' -WindowStyle Hidden",
          ].join('\n'));
        }
        return Buffer.from('Running\n');
      },
      runKeyStatusImpl: () => ({
        registered: true,
        raw: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.myelin\\headroom-copilot-9797\\start-copilot-headroom.ps1"',
      }),
      existsSyncImpl: () => false,
      readFileSyncImpl: () => {
        throw new Error('launcher should be read via PowerShell for Windows paths');
      },
    });
    assert.deepEqual(status, { running: true, state: 'Running', raw: 'Running' });
    assert.ok(commands.some((command) => command.includes('Get-Content -Path \'C:\\Users\\alice\\.myelin\\headroom-copilot-9797\\start-copilot-headroom.ps1\' -Raw')));
    assert.ok(commands.some((command) => command.includes('--port 9797')));
    assert.ok(!commands.some((command) => command.includes('--port 8788')));
  });

  it('uses powershell.exe for registry status probes when simulating WSL fallback reads', () => {
    const commands = [];
    copilotHeadroomServiceStatus({
      manager: 'registry',
      port: 9797,
      powershellExe: 'powershell.exe',
      execSyncImpl: (command) => {
        commands.push(command);
        if (command.includes('Get-ItemProperty')) {
          return Buffer.from('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.myelin\\headroom-copilot-9797\\start-copilot-headroom.ps1"\n');
        }
        if (command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\headroom-copilot-9797\\start-copilot-headroom.ps1'")) {
          return Buffer.from([
            '# Managed by myelin. Keeps Copilot-Headroom env scoped to this process tree.',
            "Start-Process -FilePath 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe' -ArgumentList 'proxy --port 9797 --mode observe --connect-timeout-seconds 10' -WorkingDirectory 'C:\\Users\\alice\\.myelin\\headroom-copilot-9797' -WindowStyle Hidden",
          ].join('\n'));
        }
        return Buffer.from('Running\n');
      },
      existsSyncImpl: () => false,
      readFileSyncImpl: () => {
        throw new Error('launcher should be read via PowerShell for Windows paths');
      },
    });

    assert.ok(commands.every((command) => command.startsWith('powershell.exe ')));
  });
});

describe('serviceStatus', () => {
  it('validates the managed launcher, pid, executable path, and exact command for registry mode', () => {
    const commands = [];
    const status = serviceStatus({
      manager: 'registry',
      home: 'C:\\Users\\alice',
      execSyncImpl: (command) => {
        commands.push(command);
        if (command.includes('Get-ItemProperty')) {
          return Buffer.from('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.myelin\\services\\myelin-headroom\\start-headroom.ps1"\n');
        }
        if (command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\services\\myelin-headroom\\start-headroom.ps1'")) {
          return Buffer.from([
            '# Managed by myelin. Keeps Headroom env scoped to this process tree.',
            "Start-Process -FilePath 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe' -ArgumentList 'proxy --port 8787' -WindowStyle Hidden -PassThru",
          ].join('\n'));
        }
        if (command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\services\\myelin-headroom\\headroom.pid'")) {
          return Buffer.from('4321\n');
        }
        return Buffer.from('Running\n');
      },
      existsSyncImpl: () => false,
      readFileSyncImpl: () => {
        throw new Error('managed headroom status should fall back to PowerShell for Windows paths');
      },
    });

    assert.deepEqual(status, { running: true, state: 'Running', raw: 'Running' });
    assert.ok(commands.some((command) => command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\services\\myelin-headroom\\start-headroom.ps1' -Raw")));
    assert.ok(commands.some((command) => command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\services\\myelin-headroom\\headroom.pid' -Raw")));
    assert.ok(commands.some((command) => command.includes('ProcessId = $managedPid')));
    assert.ok(commands.some((command) => command.includes(`ExecutablePath -eq 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe'`)));
    assert.ok(commands.some((command) => command.includes('--port 8787')));
    assert.ok(!commands.some((command) => command.includes('--port 8788 --mode')));
  });

  it('keeps legacy Run-key installs detectable via exact executable path and command line', () => {
    const commands = [];
    const status = serviceStatus({
      manager: 'registry',
      execSyncImpl: (command) => {
        commands.push(command);
        return Buffer.from(command.includes('Get-ItemProperty')
          ? '"C:\\Users\\alice\\.myelin\\bin\\headroom.exe" proxy --port 8787\n'
          : 'Running\n');
      },
      existsSyncImpl: () => false,
      readFileSyncImpl: () => {
        throw new Error('legacy status should not require local launcher reads');
      },
    });

    assert.deepEqual(status, { running: true, state: 'Running', raw: 'Running' });
    assert.ok(commands.some((command) => command.includes(`ExecutablePath -eq 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe'`)));
    assert.ok(commands.some((command) => command.includes('--port 8787')));
    assert.ok(!commands.some((command) => command.includes('ProcessId = $managedPid')));
  });

  it('reports stopped when the managed launcher identity does not match a running process', () => {
    const commands = [];
    const status = serviceStatus({
      manager: 'registry',
      home: 'C:\\Users\\alice',
      execSyncImpl: (command) => {
        commands.push(command);
        if (command.includes('Get-ItemProperty')) {
          return Buffer.from('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.myelin\\services\\myelin-headroom\\start-headroom.ps1"\n');
        }
        if (command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\services\\myelin-headroom\\start-headroom.ps1'")) {
          return Buffer.from([
            '# Managed by myelin. Keeps Headroom env scoped to this process tree.',
            "Start-Process -FilePath 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe' -ArgumentList 'proxy --port 8788 --mode cache --connect-timeout-seconds 10' -WindowStyle Hidden -PassThru",
          ].join('\n'));
        }
        if (command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\services\\myelin-headroom\\headroom.pid'")) {
          return Buffer.from('4321\n');
        }
        return Buffer.from('Stopped\n');
      },
      existsSyncImpl: () => false,
      readFileSyncImpl: () => {
        throw new Error('managed headroom status should fall back to PowerShell for Windows paths');
      },
    });

    assert.deepEqual(status, { running: false, state: 'Stopped', raw: 'Stopped' });
    assert.ok(commands.some((command) => command.includes('--port 8788 --mode cache --connect-timeout-seconds 10')));
    assert.ok(!commands.some((command) => command.includes('--port 8787(\\s|$)')));
  });
});

describe('Windows watchdog generators', () => {
  it('creates a task delete script for the main Headroom watchdog only', () => {
    const script = generateWindowsWatchdogTaskDeleteScript({ taskName: 'Myelin Headroom Watchdog' });
    assert.ok(script.includes('Unregister-ScheduledTask'));
    assert.ok(script.includes('Myelin Headroom Watchdog'));
    assert.ok(!script.includes('Copilot'));
  });

  it('removes only the managed Headroom watchdog script and log artifacts', () => {
    const unlinked = [];
    let deleteScript = '';

    const result = uninstallWindowsWatchdogTask({
      id: HEADROOM_SERVICE_ID,
      home: 'C:\\Users\\alice',
      unlinkSyncImpl: (path) => {
        unlinked.push(path);
      },
      runPsFn: (script) => {
        deleteScript = script;
      },
    });

    assert.equal(result.taskName, 'Myelin Headroom Watchdog');
    assert.deepEqual(unlinked, [
      'C:\\Users\\alice\\.myelin\\services\\myelin-headroom\\watchdog.ps1',
      'C:\\Users\\alice\\.myelin\\services\\myelin-headroom\\watchdog.log',
    ]);
    assert.ok(deleteScript.includes('Unregister-ScheduledTask'));
    assert.ok(deleteScript.includes('Myelin Headroom Watchdog'));
    assert.ok(!deleteScript.includes('Myelin Copilot Headroom Watchdog'));
  });

  it('keeps Copilot watchdog behavior intact when Lite replaces the main Headroom service', () => {
    const calls = [];

    installWindowsWatchdog({
      home: 'C:\\Users\\alice',
      enabled: true,
      headroomPort: undefined,
      copilotHeadroomPort: 8788,
      intervalMinutes: 5,
      installWindowsWatchdogTaskImpl: (opts) => {
        calls.push({ type: 'install', opts });
        return opts;
      },
      uninstallWindowsWatchdogTaskImpl: (opts) => {
        calls.push({ type: 'uninstall', opts });
        return opts;
      },
    });

    assert.deepEqual(calls.map(({ type }) => type), ['uninstall', 'install']);
    assert.equal(calls[0].opts.id, HEADROOM_SERVICE_ID);
    assert.equal(calls[1].opts.id, 'myelin-copilot-headroom');
    assert.equal(calls[1].opts.serviceName, 'Myelin Copilot Headroom');
  });

  it('removes only the main Headroom watchdog when the watchdog is disabled', () => {
    const calls = [];

    installWindowsWatchdog({
      home: 'C:\\Users\\alice',
      enabled: false,
      headroomPort: 8787,
      copilotHeadroomPort: 8788,
      installWindowsWatchdogTaskImpl: (opts) => {
        calls.push({ type: 'install', opts });
        return opts;
      },
      uninstallWindowsWatchdogTaskImpl: (opts) => {
        calls.push({ type: 'uninstall', opts });
        return opts;
      },
    });

    assert.deepEqual(calls.map(({ type }) => type), ['uninstall']);
    assert.equal(calls[0].opts.id, HEADROOM_SERVICE_ID);
    assert.equal(calls[0].opts.home, 'C:\\Users\\alice');
  });
});

describe('WinSW XML generator', () => {
  const WINSW_OPTS = {
    id: 'myelin-headroom',
    name: 'Myelin Headroom',
    description: 'Myelin token-efficiency proxy (Headroom)',
    executable: 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\headroom.exe',
    arguments: 'proxy --port 8787',
    logPath: 'C:\\Users\\alice\\.myelin\\logs',
    envVars: { HEADROOM_PORT: '8787', OPENAI_TARGET_API_URL: 'https://api.githubcopilot.com' },
    onFailureDelays: ['5 sec', '30 sec'],
  };

  it('contains the service id, executable, and arguments', () => {
    const xml = generateWinswConfigXml(WINSW_OPTS);
    assert.ok(xml.includes('<id>myelin-headroom</id>'));
    assert.ok(xml.includes(WINSW_OPTS.executable));
    assert.ok(xml.includes(WINSW_OPTS.arguments));
  });

  it('emits env vars plus restart-on-failure policy', () => {
    const xml = generateWinswConfigXml(WINSW_OPTS);
    assert.ok(xml.includes('<env name="HEADROOM_PORT" value="8787"/>'));
    assert.ok(xml.includes('<env name="OPENAI_TARGET_API_URL" value="https://api.githubcopilot.com"/>'));
    assert.ok(xml.includes('<onfailure action="restart" delay="5 sec"/>'));
    assert.ok(xml.includes('<onfailure action="restart" delay="30 sec"/>'));
    assert.ok(xml.includes('<resetfailure>1 hour</resetfailure>'));
    assert.ok(xml.includes('<hidewindow>true</hidewindow>'));
  });

  it('XML-escapes reserved characters', () => {
    const xml = generateWinswConfigXml({
      ...WINSW_OPTS,
      description: 'Proxy <watchdog> & "health"',
      envVars: { SPECIAL: `A&B<"'` },
    });
    assert.ok(xml.includes('Proxy &lt;watchdog&gt; &amp; &quot;health&quot;'));
    assert.ok(xml.includes('value="A&amp;B&lt;&quot;&apos;"'));
  });

  it('runs a .cmd engine shim through cmd.exe with safe /d /s /c quoting', () => {
    const xml = generateEngineInstanceWinswConfig({
      instance: {
        ...engineInstance('headroom_lite', 'primary'),
        stateDir: 'C:\\Users\\alice\\.myelin\\state\\headroom_lite-primary',
        logPath: 'C:\\Users\\alice\\.myelin\\headroom_lite-primary.log',
      },
      headroomLiteBin: 'C:\\Program Files\\Myelin\\headroom-lite.cmd',
    });

    assert.match(xml, /<executable>cmd\.exe<\/executable>/);
    assert.match(xml, /<arguments>\/d \/s \/c &quot;&quot;C:\\Program Files\\Myelin\\headroom-lite\.cmd&quot;&quot;<\/arguments>/);
  });

  it('normalizes a mounted Windows Lite shim before embedding it in cmd.exe arguments', () => {
    const xml = generateEngineInstanceWinswConfig({
      instance: {
        ...engineInstance('headroom_lite', 'primary'),
        stateDir: 'C:\\Users\\alice\\.myelin\\state\\headroom_lite-primary',
        logPath: 'C:\\Users\\alice\\.myelin\\headroom_lite-primary.log',
      },
      headroomLiteBin: '/mnt/c/Users/alice/AppData/Roaming/npm/headroom-lite.cmd',
    });

    assert.match(xml, /<arguments>\/d \/s \/c &quot;&quot;C:\\Users\\alice\\AppData\\Roaming\\npm\\headroom-lite\.cmd&quot;&quot;<\/arguments>/);
    assert.doesNotMatch(xml, /\/mnt\/c\//);
  });
});

describe('WSL Windows-service executable resolution', () => {
  it('rejects Linux-only shims and resolves a usable Windows selected-engine executable', () => {
    assert.equal(typeof windowsService.resolveWindowsServiceExecutable, 'function');

    const resolved = windowsService.resolveWindowsServiceExecutable({
      engine: 'headroom_lite',
      candidate: '/home/alice/.local/bin/headroom-lite.cmd',
      servicePlatform: 'windows',
      wsl: true,
    }, {
      execFileSyncImpl: (file, args) => {
        if (file === 'wslpath') return Buffer.from('\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\bin\\headroom-lite\n');
        if (file === 'powershell.exe' && args.at(-1).includes('Get-Command')) {
          return Buffer.from('C:\\Users\\alice\\AppData\\Roaming\\npm\\headroom-lite.cmd\n');
        }
        throw new Error('Linux shim is not a Windows executable');
      },
    });

    assert.equal(resolved, 'C:\\Users\\alice\\AppData\\Roaming\\npm\\headroom-lite.cmd');
  });

  it('does not accept an existing WSL UNC path for a Linux-selected Lite shim', () => {
    const resolved = windowsService.resolveWindowsServiceExecutable({
      engine: 'headroom_lite',
      candidate: '/home/alice/.local/bin/headroom-lite',
      servicePlatform: 'windows',
      wsl: true,
    }, {
      execFileSyncImpl: (file, args) => {
        if (file === 'wslpath') return Buffer.from('\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\bin\\headroom-lite.cmd\n');
        if (file === 'powershell.exe' && args.at(-1).includes('Get-Command')) {
          return Buffer.from('C:\\Users\\alice\\AppData\\Roaming\\npm\\headroom-lite.cmd\n');
        }
        if (file === 'powershell.exe' && args.at(-1).includes('Test-Path')) {
          return Buffer.from('\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\bin\\headroom-lite.cmd\n');
        }
        throw new Error('unexpected executable probe');
      },
    });

    assert.equal(resolved, 'C:\\Users\\alice\\AppData\\Roaming\\npm\\headroom-lite.cmd');
  });

  it('does not accept a legacy WSL $ UNC path for a Linux-selected Lite shim', () => {
    const resolved = windowsService.resolveWindowsServiceExecutable({
      engine: 'headroom_lite',
      candidate: String.raw`\\wsl$\Ubuntu\home\alice\.local\bin\headroom-lite.cmd`,
      servicePlatform: 'windows',
      wsl: true,
    }, {
      execFileSyncImpl: (file, args) => {
        if (file === 'powershell.exe' && args.at(-1).includes('Get-Command')) {
          return Buffer.from('C:\\Users\\alice\\AppData\\Roaming\\npm\\headroom-lite.cmd\n');
        }
        throw new Error('unexpected executable probe');
      },
    });

    assert.equal(resolved, 'C:\\Users\\alice\\AppData\\Roaming\\npm\\headroom-lite.cmd');
  });

  it('fails instead of emitting a Windows service with an unresolvable Linux-only executable', () => {
    assert.equal(typeof windowsService.resolveWindowsServiceExecutable, 'function');
    assert.throws(
      () => windowsService.resolveWindowsServiceExecutable({
        engine: 'headroom',
        candidate: '/home/alice/.myelin/venv/bin/headroom',
        serviceHome: 'C:\\Users\\alice',
        servicePlatform: 'windows',
        wsl: true,
      }, {
        execFileSyncImpl: () => {
          throw new Error('not found');
        },
      }),
      /Unable to resolve a Windows-service executable for headroom from WSL/,
    );
  });

  it('resolves the headroom venv under a WSL-relocated MYELIN_DIR mount path', () => {
    const scripts = [];
    const resolved = windowsService.resolveWindowsServiceExecutable({
      engine: 'headroom',
      candidate: '/home/alice/.myelin/venv/bin/headroom',
      serviceHome: '/home/alice',
      servicePlatform: 'windows',
      wsl: true,
      env: { MYELIN_DIR: '/mnt/d/managed-myelin' },
    }, {
      execFileSyncImpl: (file, args) => {
        if (file === 'powershell.exe') {
          scripts.push(String(args.at(-1)));
          return Buffer.from('D:\\managed-myelin\\venv\\Scripts\\headroom.exe\n');
        }
        throw new Error(`unexpected probe: ${file}`);
      },
    });

    assert.equal(resolved, 'D:\\managed-myelin\\venv\\Scripts\\headroom.exe');
    // The probe targets the native Windows venv derived from the mounted
    // MYELIN_DIR, not the Windows User-scope MYELIN_DIR fallback.
    assert.ok(scripts.some((s) => s.includes('D:\\managed-myelin\\venv\\Scripts\\headroom.exe')));
    assert.ok(!scripts.some((s) => s.includes("GetEnvironmentVariable('MYELIN_DIR'")));
  });

  it('rejects a native WSL path instead of converting it into a \\home command path', () => {
    assert.throws(
      () => normalizeWindowsFilesystemPath('/home/alice/.myelin/bin/headroom.exe', { rejectPosix: true }),
      /POSIX.*Windows-service|Windows-service.*POSIX/i,
    );
  });
});

describe('WinSW WSL filesystem split', () => {
  const home = 'C:\\Users\\alice';
  const id = 'headroom-primary';
  const serviceDirectory = '/mnt/c/Users/alice/.myelin/services/headroom-primary';

  it('writes installed assets through mounted filesystem paths while keeping PowerShell command paths native', async () => {
    const filesystemOps = [];
    const powerShellScripts = [];

    await windowsService.installWinswService({
      id,
      name: 'Myelin Headroom Primary',
      description: 'Myelin headroom primary',
      executable: 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\headroom.exe',
      arguments: 'proxy --port 8787',
      logPath: 'C:\\Users\\alice\\.myelin\\headroom-primary.log',
      workingDirectory: 'C:\\Users\\alice\\.myelin\\state\\headroom-primary',
      home,
      isWslImpl: () => true,
      installWinswImpl: async () => ({
        path: 'C:\\Users\\alice\\.myelin\\bin\\winsw.exe',
        filesystemPath: '/mnt/c/Users/alice/.myelin/bin/winsw.exe',
      }),
      mkdirSyncImpl: (path) => filesystemOps.push({ op: 'mkdir', path }),
      existsSyncImpl: (path) => {
        filesystemOps.push({ op: 'exists', path });
        return false;
      },
      copyFileSyncImpl: (source, target) => filesystemOps.push({ op: 'copy', source, target }),
      writeFileSyncImpl: (path) => filesystemOps.push({ op: 'write', path }),
      renameSyncImpl: (source, target) => filesystemOps.push({ op: 'rename', source, target }),
      unlinkSyncImpl: (path) => filesystemOps.push({ op: 'unlink', path }),
      runPsFn: (script) => powerShellScripts.push(script),
    });

    assert.ok(filesystemOps.every(({ path, source, target }) =>
      [path, source, target].filter(Boolean).every((value) => value.startsWith('/mnt/c/'))));
    assert.ok(powerShellScripts[0].includes("'C:\\Users\\alice\\.myelin\\services\\headroom-primary\\headroom-primary.exe'"));
    assert.ok(powerShellScripts[0].includes("'C:\\Users\\alice\\.myelin\\services\\headroom-primary\\headroom-primary.xml'"));
  });

  it('uses a mounted filesystem path for status reads while preserving Windows command paths for PowerShell', () => {
    const filesystemReads = [];
    const powerShellCommands = [];
    const status = windowsService.winswServiceStatus({
      id: 'headroom-primary',
      home: 'C:\\Users\\alice',
      isWslImpl: () => true,
      existsSyncImpl: (path) => {
        filesystemReads.push(path);
        return true;
      },
      execSyncImpl: (command) => {
        powerShellCommands.push(command);
        return Buffer.from('Active (running)\n');
      },
      powershellExe: 'powershell.exe',
    });

    assert.equal(status.running, true);
    assert.deepEqual(filesystemReads, [
      '/mnt/c/Users/alice/.myelin/services/headroom-primary/headroom-primary.exe',
      '/mnt/c/Users/alice/.myelin/services/headroom-primary/headroom-primary.xml',
    ]);
    assert.ok(powerShellCommands[0].includes("'C:\\Users\\alice\\.myelin\\services\\headroom-primary\\headroom-primary.exe'"));
    assert.ok(powerShellCommands[0].includes("'C:\\Users\\alice\\.myelin\\services\\headroom-primary\\headroom-primary.xml'"));
  });

  it('forwards WSL path handling through descriptor status and teardown adapters', () => {
    const filesystemReads = [];
    const watchdogCalls = [];
    const uninstallCalls = [];
    const instance = {
      engine: 'headroom',
      role: 'primary',
      id,
      port: 8787,
      stateDir: 'C:\\Users\\alice\\.myelin\\state\\headroom-primary',
      logPath: 'C:\\Users\\alice\\.myelin\\headroom-primary.log',
      healthUrl: 'http://127.0.0.1:8787/health',
      env: {},
    };
    const winswConfig = [
      '<service>',
      `  <id>${id}</id>`,
      '  <executable>C:\\Users\\alice\\.myelin\\venv\\Scripts\\headroom.exe</executable>',
      '  <arguments>proxy --port 8787</arguments>',
      '  <workingdirectory>C:\\Users\\alice\\.myelin\\state\\headroom-primary</workingdirectory>',
      '</service>',
    ].join('\n');
    const isWslImpl = () => true;

    const status = windowsEngineInstanceStatus(instance, {
      manager: 'winsw',
      home,
      isWslImpl,
      existsSyncImpl: (path) => {
        filesystemReads.push(path);
        return true;
      },
      execSyncImpl: () => Buffer.from('Active (running)\n'),
      powershellExe: 'powershell.exe',
    });
    removeWindowsEngineInstance(instance, {
      manager: 'winsw',
      home,
      isWslImpl,
      existsSyncImpl: (path) => {
        filesystemReads.push(path);
        return path.startsWith('/mnt/c/');
      },
      readFileSyncImpl: (path) => {
        assert.ok(path.startsWith('/mnt/c/'));
        return winswConfig;
      },
      uninstallWindowsWatchdogTaskImpl: (options) => watchdogCalls.push(options),
      uninstallWinswServiceImpl: (options) => {
        uninstallCalls.push(options);
        return true;
      },
      runPsFn: () => {},
    });

    assert.equal(status.running, true);
    assert.ok(filesystemReads.every((path) => path.startsWith('/mnt/c/')));
    assert.ok(watchdogCalls.every(({ isWslImpl: forwarded }) => forwarded === isWslImpl));
    assert.equal(uninstallCalls[0].isWslImpl, isWslImpl);
  });

  it('writes and removes watchdog artifacts through mounted paths while registering Windows-valid task paths', () => {
    const filesystemWrites = [];
    const filesystemUnlinks = [];
    const powerShellScripts = [];
    const task = windowsService.installWindowsWatchdogTask({
      id,
      home,
      healthUrl: 'http://127.0.0.1:8787/health',
      isWslImpl: () => true,
      existsSyncImpl: (path) => {
        filesystemWrites.push(path);
        return true;
      },
      mkdirSyncImpl: (path) => filesystemWrites.push(path),
      writeFileSyncImpl: (path) => filesystemWrites.push(path),
      runPsFn: (script) => powerShellScripts.push(script),
    });

    windowsService.uninstallWindowsWatchdogTask({
      id,
      home,
      isWslImpl: () => true,
      unlinkSyncImpl: (path) => filesystemUnlinks.push(path),
      runPsFn: (script) => powerShellScripts.push(script),
    });

    assert.ok(filesystemWrites.every((path) => path.startsWith('/mnt/c/')));
    assert.deepEqual(filesystemUnlinks, [
      `${serviceDirectory}/watchdog.ps1`,
      `${serviceDirectory}/watchdog.log`,
    ]);
    assert.equal(task.scriptPath, 'C:\\Users\\alice\\.myelin\\services\\headroom-primary\\watchdog.ps1');
    assert.ok(powerShellScripts.some((script) =>
      script.includes('C:\\Users\\alice\\.myelin\\services\\headroom-primary\\watchdog.ps1')));
  });
});

describe('WinSW status parser', () => {
  it('treats Active (running) as running', () => {
    assert.deepEqual(parseWinswServiceStatus('Active (running)'), {
      running: true,
      state: 'Active (running)',
      raw: 'Active (running)',
    });
  });

  it('treats Inactive (stopped) as not running', () => {
    assert.deepEqual(parseWinswServiceStatus('Inactive (stopped)'), {
      running: false,
      state: 'Inactive (stopped)',
      raw: 'Inactive (stopped)',
    });
  });

  it('treats NonExistent as not running', () => {
    assert.deepEqual(parseWinswServiceStatus('NonExistent'), {
      running: false,
      state: 'NonExistent',
      raw: 'NonExistent',
    });
  });
});

describe('resolveWslWindowsHome', () => {
  const dir = (name) => ({ name, isDirectory: () => true });

  it('returns a cleaned USERPROFILE value from PowerShell output', () => {
    const home = resolveWslWindowsHome({
      execSync: () => Buffer.from('\uFEFFC:\\Users\\alice\r\nignored\r\n'),
      existsSync: () => false,
      readdirSync: () => [],
    });
    assert.equal(home, 'C:\\Users\\alice');
  });

  it('falls through from User scope to Machine scope', () => {
    const calls = [];
    const home = resolveWslWindowsHome({
      execSync: (command) => {
        calls.push(command);
        if (command.includes("'User')")) return Buffer.from('\r\n');
        return Buffer.from('C:\\Users\\machine\r\n');
      },
      existsSync: () => false,
      readdirSync: () => [],
    });
    assert.equal(home, 'C:\\Users\\machine');
    assert.equal(calls.length, 2);
  });

  it('falls back to a single non-system profile under /mnt/c/Users', () => {
    const home = resolveWslWindowsHome({
      execSync: () => { throw new Error('interop disabled'); },
      existsSync: (path) => path === '/mnt/c/Users',
      readdirSync: () => [
        dir('Public'),
        dir('Default'),
        dir('alice'),
      ],
    });
    assert.equal(home, '/mnt/c/Users/alice');
  });

  it('returns null when the filesystem scan is empty or ambiguous', () => {
    assert.equal(resolveWslWindowsHome({
      execSync: () => { throw new Error('interop disabled'); },
      existsSync: (path) => path === '/mnt/c/Users',
      readdirSync: () => [dir('Public'), dir('Default')],
    }), null);
    assert.equal(resolveWslWindowsHome({
      execSync: () => { throw new Error('interop disabled'); },
      existsSync: (path) => path === '/mnt/c/Users',
      readdirSync: () => [dir('alice'), dir('bob')],
    }), null);
  });
});

describe('defaultWindowsHome', () => {
  it('preserves the previous non-WSL fallback behavior when WSL is not detected', () => {
    const savedUserProfile = process.env.USERPROFILE;
    delete process.env.USERPROFILE;
    try {
      assert.equal(defaultWindowsHome(undefined, {
        isWslImpl: () => false,
        resolveWslWindowsHomeImpl: () => { throw new Error('should not be called'); },
        homedirImpl: () => '/home/alice',
      }), '\\home\\alice');
      assert.equal(defaultWindowsHome('C:/Users/alice', {
        isWslImpl: () => false,
      }), 'C:\\Users\\alice');
    } finally {
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
    }
  });

  it('converts a mounted WSL home path into a Windows home path', () => {
    const savedUserProfile = process.env.USERPROFILE;
    delete process.env.USERPROFILE;
    try {
      assert.equal(defaultWindowsHome(undefined, {
        isWslImpl: () => true,
        resolveWslWindowsHomeImpl: () => '/mnt/c/Users/alice',
        homedirImpl: () => '/home/alice',
      }), 'C:\\Users\\alice');
    } finally {
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
    }
  });

  it('prefers the resolved Windows home over an explicit POSIX WSL home path', () => {
    const savedUserProfile = process.env.USERPROFILE;
    delete process.env.USERPROFILE;
    try {
      assert.equal(defaultWindowsHome('/home/alice', {
        isWslImpl: () => true,
        resolveWslWindowsHomeImpl: () => 'C:/Users/alice',
        homedirImpl: () => '/home/alice',
      }), 'C:\\Users\\alice');
    } finally {
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
    }
  });
});

describe('Windows watchdog generators', () => {
  const home = 'C:\\Users\\alice';
  const configPath = winswConfigPath({ id: HEADROOM_SERVICE_ID, home });
  const exePath = winswExecutablePath({ id: HEADROOM_SERVICE_ID, home });
  const logPath = 'C:\\Users\\alice\\.myelin\\services\\myelin-headroom\\watchdog.log';

  it('builds a healthcheck script that probes /health and restarts via WinSW', () => {
    const script = generateWindowsWatchdogHealthcheckScript({
      serviceName: 'Myelin Headroom',
      healthUrl: 'http://127.0.0.1:8787/health',
      winswExePath: exePath,
      winswConfigPath: configPath,
      logPath,
    });
    assert.ok(script.includes('Invoke-WebRequest'));
    assert.ok(script.includes('http://127.0.0.1:8787/health'));
    assert.ok(script.includes('& $WinswExe restart $WinswConfig'));
    assert.ok(script.includes('& $WinswExe stop $WinswConfig --force --no-wait'));
    assert.ok(script.includes('& $WinswExe start $WinswConfig'));
    assert.ok(script.includes(exePath));
    assert.ok(script.includes(configPath));
  });

  it('builds a Scheduled Task creation script with minute cadence', () => {
    const script = generateWindowsWatchdogTaskCreateScript({
      taskName: 'Myelin Headroom Watchdog',
      scriptPath: 'C:\\Users\\alice\\.myelin\\services\\myelin-headroom\\watchdog.ps1',
      intervalMinutes: 2,
    });
    assert.ok(script.includes('schtasks.exe /create'));
    assert.ok(script.includes('/sc minute /mo 2'));
    assert.ok(script.includes('Myelin Headroom Watchdog'));
    assert.ok(script.includes('powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File'));
    assert.ok(script.includes('/ru System /rl HIGHEST /f'));
  });

  it('rejects invalid Scheduled Task intervals', () => {
    assert.throws(() => generateWindowsWatchdogTaskCreateScript({
      taskName: 'Myelin Headroom Watchdog',
      scriptPath: 'C:\\watchdog.ps1',
      intervalMinutes: 0,
    }), /intervalMinutes/);
  });
});

describe('windows copilot-headroom run-script generator', () => {
  const CH_OPTS = {
    headroomBin: OPTS.headroomBin,
    port: 8788,
    mode: 'cache',
    workingDirectory: 'C:\\Users\\yehsuf\\.myelin\\copilot-headroom',
    envVars: { ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889' },
  };
  it('contains a distinct registry run key name from the Claude-Headroom instance', () => {
    const script = generateCopilotHeadroomRunScript(CH_OPTS);
    assert.ok(script.includes('MyelinCopilotHeadroom'));
  });
  it('sets -WorkingDirectory for state isolation', () => {
    const script = generateCopilotHeadroomRunScript(CH_OPTS);
    assert.ok(script.includes('-WorkingDirectory'));
    assert.ok(script.includes('copilot-headroom'));
  });
  it('uses engine-owned proxy arguments without a role-specific mode', () => {
    const script = generateCopilotHeadroomRunScript(CH_OPTS);
    assert.ok(script.includes('--port 8788'));
    assert.ok(!script.includes('--mode cache'));
  });
  it('stops only the process on this exact port', () => {
    const script = generateCopilotHeadroomRunScript(CH_OPTS);
    assert.ok(script.includes('Win32_Process'));
  });
  it('persists a Run-key launcher that preserves scoped target env vars after login', () => {
    const script = generateCopilotHeadroomRunScript({
      ...CH_OPTS,
      envVars: {
        ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889',
        OPENAI_TARGET_API_URL: 'http://127.0.0.1:8889',
      },
    });
    assert.ok(script.includes('start-copilot-headroom.ps1'));
    assert.ok(script.includes('Set-ItemProperty'));
    assert.ok(script.includes('powershell.exe -NoProfile -ExecutionPolicy Bypass -File'));
    assert.ok(script.includes("[System.Environment]::SetEnvironmentVariable('ANTHROPIC_TARGET_API_URL', 'http://127.0.0.1:8889', 'Process')"));
    assert.ok(script.includes("[System.Environment]::SetEnvironmentVariable('OPENAI_TARGET_API_URL', 'http://127.0.0.1:8889', 'Process')"));
  });
});

describe('windows mitm run-script generator — egress dual-listener', () => {
  const MITM_OPTS = {
    mitmdumpBin: '/usr/bin/mitmdump',
    port: 8888,
    addonPath: '/path/addon.py',
    envVars: {},
    home: 'C:\\Users\\alice',
  };
  it('uses --listen-port when no egressPort is given (backward compatible)', () => {
    const script = generateMitmRunScript(MITM_OPTS);
    assert.ok(script.includes('--listen-port 8888'));
    assert.ok(!script.includes('regular@'));
  });

  describe('Windows MITM removal ownership', () => {
    const home = 'C:\\Users\\alice';

    it('stops and unregisters only the exact Myelin launcher-owned registry process', () => {
      const script = generateManagedMitmRemovalScript({ home });

      assert.match(script, /\$runKeyValue/);
      assert.match(script, /\$launcherMatches/);
      assert.match(script, /if \(\$launcherMatches\) \{/);
      assert.match(script, /\$parent\.CommandLine -match \$launcherRegex/);
      assert.match(script, /Stop-Process -Id \$managedPid/);
      assert.match(script, /Remove-ItemProperty -Path .*MyelinMitmproxy/);
      assert.doesNotMatch(script, /Stop-Process -Name mitmdump/);
    });

    it('removes a direct legacy MITM registration without treating its listener as owned', () => {
      const script = generateManagedMitmRemovalScript({ home });

      assert.match(script, /\$legacyDirectMatch/);
      assert.match(script, /mitmdump/);
      assert.match(script, /copilot_addon\\\.py/);
      assert.match(script, /\$legacyDirectOwned =/);
      assert.match(script, /if \(\$launcherMatches -or \$legacyDirectOwned\)/);
      assert.ok(script.lastIndexOf('Stop-Process') < script.indexOf('$legacyDirectMatch'));
    });

    it('does not uninstall a WinSW configuration that is not Myelin MITM', () => {
      const uninstalls = [];
      const registryScripts = [];

      const removed = removeMitmService({
        manager: 'winsw',
        home,
        existsSyncImpl: () => true,
        readFileSyncImpl: () => [
          '<service>',
          '  <id>unowned-service</id>',
          '  <name>Unowned Service</name>',
          '</service>',
        ].join('\n'),
        uninstallWinswServiceImpl: (options) => uninstalls.push(options),
        runPsFn: (script) => registryScripts.push(script),
      });

      assert.equal(removed, false);
      assert.deepEqual(uninstalls, []);
      assert.equal(registryScripts.length, 1);
      assert.match(registryScripts[0], /\$launcherMatches/);
    });
  });

  describe('Unix MITM registration removal', () => {
    it('removes only the Myelin launchd label and plist', () => {
      const commands = [];
      const removed = [];

      removeLaunchdMitmService({
        home: '/Users/alice',
        uid: '501',
        existsSyncImpl: () => true,
        unlinkSyncImpl: (path) => removed.push(path),
        execSyncImpl: (command) => commands.push(command),
      });

      assert.deepEqual(commands, ['launchctl bootout gui/501/com.myelin.mitmproxy']);
      assert.deepEqual(removed, ['/Users/alice/Library/LaunchAgents/com.myelin.mitmproxy.plist']);
    });

    it('removes only the Myelin systemd unit', () => {
      const commands = [];
      const removed = [];

      removeSystemdMitmService({
        home: '/home/alice',
        existsSyncImpl: () => true,
        unlinkSyncImpl: (path) => removed.push(path),
        execSyncImpl: (command) => commands.push(command),
      });

      assert.deepEqual(commands, [
        'systemctl --user disable --now myelin-mitmproxy.service',
        'systemctl --user daemon-reload',
      ]);
      assert.deepEqual(removed, ['/home/alice/.config/systemd/user/myelin-mitmproxy.service']);
    });
  });
  it('uses ingress plus loopback-bound egress --mode args when egressPort is given', () => {
    const script = generateMitmRunScript({ ...MITM_OPTS, egressPort: 8889 });
    assert.ok(script.includes('--mode regular@8888'));
    assert.ok(script.includes('--mode regular@127.0.0.1:8889'));
    assert.ok(!script.includes('--listen-port'));
  });
  it('sets MYELIN_EGRESS_PORT when egressPort is given', () => {
    const script = generateMitmRunScript({ ...MITM_OPTS, egressPort: 8889 });
    assert.ok(script.includes('MYELIN_EGRESS_PORT'));
  });

  it('sets rebuilt managed env vars in Process scope before launching mitmdump', () => {
    const script = generateMitmRunScript({
      ...MITM_OPTS,
      egressPort: 8889,
      envVars: {
        MYELIN_HEADROOM_PORT: '8790',
        MYELIN_COPILOT_ENGINE_URL: 'http://127.0.0.1:8788',
        MYELIN_BLOCK_BYPASS: '1',
      },
    });

    const headroomIdx = script.indexOf("SetEnvironmentVariable('MYELIN_HEADROOM_PORT', '8790', 'Process')");
    const copilotIdx = script.indexOf("SetEnvironmentVariable('MYELIN_COPILOT_ENGINE_URL', 'http://127.0.0.1:8788', 'Process')");
    const bypassIdx = script.indexOf("SetEnvironmentVariable('MYELIN_BLOCK_BYPASS', '1', 'Process')");
    const startIdx = script.lastIndexOf('-WindowStyle Hidden -PassThru');

    assert.ok(headroomIdx >= 0);
    assert.ok(copilotIdx >= 0);
    assert.ok(bypassIdx >= 0);
    assert.ok(startIdx > bypassIdx);
    assert.ok(script.includes('start-mitmproxy.ps1'));
    assert.ok(script.includes("New-Item -ItemType Directory -Force -Path 'C:\\Users\\alice\\.myelin\\services\\myelin-mitmproxy'"));
  });

  it('clears stale optional managed env vars and avoids killing unrelated mitmdump processes', () => {
    const script = generateMitmRunScript({
      ...MITM_OPTS,
      envVars: { MYELIN_HEADROOM_PORT: '8787' },
    });

    assert.ok(script.includes("SetEnvironmentVariable('MYELIN_COPILOT_ENGINE_URL', $null, 'Process')"));
    assert.ok(script.includes("SetEnvironmentVariable('MYELIN_COPILOT_HEADROOM_PORT', $null, 'Process')"));
    assert.ok(script.includes("SetEnvironmentVariable('MYELIN_EGRESS_PORT', $null, 'Process')"));
    assert.ok(script.includes("SetEnvironmentVariable('MYELIN_BLOCK_BYPASS', $null, 'Process')"));
    assert.ok(script.includes('mitm.pid'));
    assert.ok(script.includes('ProcessId = $managedPid'));
    assert.ok(script.includes('ParentProcessId'));
    assert.ok(script.includes('start-mitmproxy\\.ps1'));
    assert.ok(script.includes('$matchesManagedLauncher'));
    assert.ok(script.includes('if ($matchesManagedLauncher -and'));
    assert.ok(script.includes('Remove-Item -Path $pidPath -ErrorAction SilentlyContinue'));
    assert.ok(!script.includes('if ($proc -and $_.CommandLine'));
    assert.ok(!script.includes('Stop-Process -Name mitmdump'));
  });

  // Regression test for a live bug: a real Windows path (e.g. a NetFree
  // corporate CA file) got written into the managed launcher with every
  // backslash doubled, and the doubled value got read back as input on the
  // next `myelin restart`, silently compounding across runs - observed live as
  // C:\\\\\\\\ProgramData\\\\\\\\NetFree\\\\\\\\CA\\\\\\\\netfree-ca-list.crt
  // (8 backslashes per separator) after 3 restarts.
  it('does not double backslashes in a managed launcher env var value (regression)', () => {
    const script = generateMitmRunScript({
      ...MITM_OPTS,
      envVars: { NODE_EXTRA_CA_CERTS: 'C:\\Users\\yehsuf\\.myelin\\ca-bundle.pem' },
    });
    assert.ok(script.includes("SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'C:\\Users\\yehsuf\\.myelin\\ca-bundle.pem', 'Process')"));
    assert.ok(!script.includes("SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'C:\\\\Users"));
  });

  it('self-heals an already-doubled value instead of doubling it further', () => {
    const script = generateMitmRunScript({
      ...MITM_OPTS,
      envVars: { NODE_EXTRA_CA_CERTS: 'C:\\\\ProgramData\\\\NetFree\\\\CA\\\\netfree-ca-list.crt' },
    });
    assert.ok(script.includes("SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'C:\\ProgramData\\NetFree\\CA\\netfree-ca-list.crt', 'Process')"));
  });

  it('self-heals a severely compounded value (the exact 8-backslash case observed live)', () => {
    const corrupted = 'C:' + '\\\\\\\\ProgramData' + '\\\\\\\\NetFree' + '\\\\\\\\CA' + '\\\\\\\\netfree-ca-list.crt';
    const script = generateMitmRunScript({ ...MITM_OPTS, envVars: { NODE_EXTRA_CA_CERTS: corrupted } });
    assert.ok(script.includes("SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'C:\\ProgramData\\NetFree\\CA\\netfree-ca-list.crt', 'Process')"));
  });

  it('still escapes a literal single-quote in the value', () => {
    const script = generateMitmRunScript({ ...MITM_OPTS, envVars: { SOME_VAR: "it's a path" } });
    assert.ok(script.includes("SetEnvironmentVariable('SOME_VAR', 'it''s a path', 'Process')"));
  });

  it('normalizes WSL addon, CA, binary, and home paths to Windows paths without corrupting proxy URLs', () => {
    const script = generateMitmRunScript({
      mitmdumpBin: '/mnt/c/Users/alice/.myelin/venv/Scripts/mitmdump.exe',
      port: 8888,
      addonPath: '/mnt/c/Users/alice/.myelin/repo/src/mitm/copilot_addon.py',
      envVars: {
        REQUESTS_CA_BUNDLE: '/mnt/c/ProgramData/Corp/ca.pem',
        HTTPS_PROXY: 'http://corp-proxy:8080',
      },
      home: '/mnt/c/Users/alice',
    });

    assert.ok(script.includes(`Start-Process -FilePath 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\mitmdump.exe'`));
    assert.ok(script.includes(`-s "C:\\Users\\alice\\.myelin\\repo\\src\\mitm\\copilot_addon.py"`));
    assert.ok(script.includes(`ssl_verify_upstream_trusted_ca="C:\\ProgramData\\Corp\\ca.pem"`));
    assert.ok(script.includes(`New-Item -ItemType Directory -Force -Path 'C:\\Users\\alice\\.myelin\\services\\myelin-mitmproxy'`));
    assert.ok(script.includes('--mode upstream:http://corp-proxy:8080'));
    assert.ok(!script.includes('http:\\corp-proxy:8080'));
  });

  it('builds registry status checks that only accept the managed PID, launcher, and exact command line', () => {
    const script = buildManagedMitmStatusScript({
      pid: 4321,
      executablePath: 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\mitmdump.exe',
      argStr: '--listen-port 8888 -s "C:\\Users\\alice\\.myelin\\services\\myelin-mitmproxy\\addon.py"',
      launcherPath: 'C:\\Users\\alice\\.myelin\\services\\myelin-mitmproxy\\start-mitmproxy.ps1',
    });

    assert.ok(script.includes('$managedPid = 4321'));
    assert.ok(script.includes(`ProcessId = $managedPid`));
    assert.ok(script.includes(`ExecutablePath -eq 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\mitmdump.exe'`));
    assert.ok(script.includes(`CommandLine -match '--listen-port 8888 -s "C:\\\\Users\\\\alice\\\\\\.myelin\\\\services\\\\myelin-mitmproxy\\\\addon\\.py"$'`));
    assert.ok(script.includes(`start-mitmproxy\\.ps1`));
  });
});

describe('Managed mitm status parser', () => {
  it('only reports Running for the managed probe output', () => {
    assert.deepEqual(parseManagedMitmStatus('Running'), {
      running: true,
      state: 'Running',
      raw: 'Running',
    });
    assert.deepEqual(parseManagedMitmStatus('mitmdump.exe'), {
      running: false,
      state: 'mitmdump.exe',
      raw: 'mitmdump.exe',
    });
    assert.deepEqual(parseManagedMitmStatus(''), {
      running: false,
      state: 'Unknown',
      raw: '',
    });
  });
});

describe('mitmServiceStatus', () => {
  it('forwards WinSW status dependencies, home, and PowerShell selection', () => {
    const filesystemReads = [];
    const commands = [];
    const isWslImpl = () => true;

    const status = mitmServiceStatus({
      manager: 'winsw',
      home: 'C:\\Users\\alice',
      isWslImpl,
      existsSyncImpl: (path) => {
        filesystemReads.push(path);
        return path.startsWith('/mnt/c/');
      },
      execSyncImpl: (command) => {
        commands.push(command);
        return Buffer.from('Active (running)\n');
      },
      powershellExe: 'powershell.exe',
    });

    assert.equal(status.running, true);
    assert.deepEqual(filesystemReads, [
      '/mnt/c/Users/alice/.myelin/services/myelin-mitmproxy/myelin-mitmproxy.exe',
      '/mnt/c/Users/alice/.myelin/services/myelin-mitmproxy/myelin-mitmproxy.xml',
    ]);
    assert.ok(commands.every((command) => command.startsWith('powershell.exe ')));
    assert.ok(commands[0].includes("'C:\\Users\\alice\\.myelin\\services\\myelin-mitmproxy\\myelin-mitmproxy.exe'"));
  });

  it('reads the managed launcher and pid through PowerShell when only Windows paths are available', () => {
    const commands = [];
    const status = mitmServiceStatus({
      manager: 'registry',
      home: 'C:\\Users\\alice',
      execSyncImpl: (command) => {
        commands.push(command);
        if (command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\services\\myelin-mitmproxy\\start-mitmproxy.ps1'")) {
          return Buffer.from([
            '# Managed by myelin. Keeps mitm env scoped to this process tree.',
            `Start-Process -FilePath 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\mitmdump.exe' -ArgumentList '--listen-port 8888 -s "C:\\Users\\alice\\.myelin\\repo\\src\\mitm\\copilot_addon.py"' -WindowStyle Hidden -PassThru`,
          ].join('\n'));
        }
        if (command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\services\\myelin-mitmproxy\\mitm.pid'")) {
          return Buffer.from('4321\n');
        }
        return Buffer.from('Running\n');
      },
      existsSyncImpl: () => false,
      readFileSyncImpl: () => {
        throw new Error('managed mitm status should fall back to PowerShell for Windows paths');
      },
    });

    assert.deepEqual(status, { running: true, state: 'Running', raw: 'Running' });
    assert.ok(commands.some((command) => command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\services\\myelin-mitmproxy\\start-mitmproxy.ps1' -Raw")));
    assert.ok(commands.some((command) => command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\services\\myelin-mitmproxy\\mitm.pid' -Raw")));
    assert.ok(commands.some((command) => command.includes('ProcessId = $managedPid')));
  });

  it('uses powershell.exe for registry status probes when simulating WSL fallback reads', () => {
    const commands = [];
    mitmServiceStatus({
      manager: 'registry',
      home: 'C:\\Users\\alice',
      powershellExe: 'powershell.exe',
      execSyncImpl: (command) => {
        commands.push(command);
        if (command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\services\\myelin-mitmproxy\\start-mitmproxy.ps1'")) {
          return Buffer.from([
            '# Managed by myelin. Keeps mitm env scoped to this process tree.',
            `Start-Process -FilePath 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\mitmdump.exe' -ArgumentList '--listen-port 8888 -s "C:\\Users\\alice\\.myelin\\repo\\src\\mitm\\copilot_addon.py"' -WindowStyle Hidden -PassThru`,
          ].join('\n'));
        }
        if (command.includes("Get-Content -Path 'C:\\Users\\alice\\.myelin\\services\\myelin-mitmproxy\\mitm.pid'")) {
          return Buffer.from('4321\n');
        }
        return Buffer.from('Running\n');
      },
      existsSyncImpl: () => false,
      readFileSyncImpl: () => {
        throw new Error('managed mitm status should fall back to PowerShell for Windows paths');
      },
    });

    assert.ok(commands.every((command) => command.startsWith('powershell.exe ')));
  });

  it('recognizes an exact direct legacy Run-key MITM listener without a managed launcher', () => {
    const commands = [];
    const status = mitmServiceStatus({
      manager: 'registry',
      home: 'C:\\Users\\alice\\custom-home',
      powershellExe: 'powershell.exe',
      existsSyncImpl: () => false,
      readFileSyncImpl: () => {
        throw new Error('custom Windows paths must be read through PowerShell');
      },
      execSyncImpl: (command) => {
        commands.push(command);
        if (command.includes("Get-Content -Path 'C:\\Users\\alice\\custom-home\\.myelin\\services\\myelin-mitmproxy\\start-mitmproxy.ps1'")) {
          return Buffer.from('');
        }
        if (command.includes("Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'MyelinMitmproxy'")) {
          return Buffer.from('"C:\\Users\\alice\\custom-home\\.myelin\\venv\\Scripts\\mitmdump.exe" --listen-port 8888 -s "C:\\Users\\alice\\custom-home\\.myelin\\repo\\src\\mitm\\copilot_addon.py"\n');
        }
        return Buffer.from('Running\n');
      },
    });

    assert.deepEqual(status, { running: true, state: 'Running', raw: 'Running' });
    assert.ok(commands.every((command) => command.startsWith('powershell.exe ')));
    assert.ok(commands.some((command) => command.includes('$legacyPort = 8888')));
    assert.ok(commands.some((command) => command.includes('Get-NetTCPConnection -State Listen -LocalPort $legacyPort')));
    assert.ok(commands.some((command) => command.includes("ExecutablePath -eq 'C:\\Users\\alice\\custom-home\\.myelin\\venv\\Scripts\\mitmdump.exe'")));
    assert.ok(commands.some((command) => command.includes('copilot_addon\\.py')));
    assert.ok(commands.some((command) => command.includes("CommandLine -match '^\\s*")));
  });
});

describe('collapseRedundantBackslashes', () => {
  it('leaves a normal single-backslash Windows path untouched', () => {
    assert.equal(collapseRedundantBackslashes('C:\\Users\\yehsuf\\.myelin\\ca-bundle.pem'), 'C:\\Users\\yehsuf\\.myelin\\ca-bundle.pem');
  });

  it('collapses a doubled path down to single backslashes', () => {
    assert.equal(collapseRedundantBackslashes('C:\\\\ProgramData\\\\NetFree'), 'C:\\ProgramData\\NetFree');
  });

  it('collapses a quadrupled/octupled path down to single backslashes', () => {
    assert.equal(collapseRedundantBackslashes('C:\\\\\\\\ProgramData\\\\\\\\NetFree'), 'C:\\ProgramData\\NetFree');
  });

  it('preserves a genuine UNC path prefix (\\\\server\\share) instead of collapsing it to one backslash', () => {
    assert.equal(collapseRedundantBackslashes('\\\\server\\share\\file.pem'), '\\\\server\\share\\file.pem');
  });

  it('still collapses corruption elsewhere in a UNC path while preserving its prefix', () => {
    assert.equal(collapseRedundantBackslashes('\\\\server\\\\share\\\\file.pem'), '\\\\server\\share\\file.pem');
  });

  it('handles empty/null/undefined without throwing', () => {
    assert.equal(collapseRedundantBackslashes(''), '');
    assert.equal(collapseRedundantBackslashes(null), '');
    assert.equal(collapseRedundantBackslashes(undefined), '');
  });

  it('is idempotent - collapsing an already-clean value is a no-op', () => {
    const once = collapseRedundantBackslashes('C:\\\\\\\\Program');
    assert.equal(collapseRedundantBackslashes(once), once);
  });
});

describe('windows registry env var script generator', () => {
  it('sets each var via [Environment]::SetEnvironmentVariable with User scope', () => {
    const script = generateSetUserEnvVarsScript({ HEADROOM_PORT: '8787' });
    assert.ok(script.includes("[Environment]::SetEnvironmentVariable('HEADROOM_PORT', '8787', 'User')"));
  });
  it('does not double backslashes (single-quoted PS strings need none)', () => {
    const script = generateSetUserEnvVarsScript({ SSL_CERT_FILE: 'C:\\Users\\yehsuf\\ca-bundle.pem' });
    assert.ok(script.includes("'C:\\Users\\yehsuf\\ca-bundle.pem'"));
    assert.ok(!script.includes('\\\\'));
  });
  it('doubles a literal single-quote in a value', () => {
    const script = generateSetUserEnvVarsScript({ WEIRD: "it's a test" });
    assert.ok(script.includes("'it''s a test'"));
  });
  it('handles multiple vars, one line each', () => {
    const script = generateSetUserEnvVarsScript({ A: '1', B: '2' });
    assert.equal(script.trim().split('\n').length, 2);
  });
  it('self-heals an already-doubled value instead of leaving it corrupted', () => {
    const script = generateSetUserEnvVarsScript({ SSL_CERT_FILE: 'C:\\\\ProgramData\\\\NetFree\\\\netfree-ca-list.crt' });
    assert.ok(script.includes("'C:\\ProgramData\\NetFree\\netfree-ca-list.crt'"));
  });
});

describe('npm global bin dir resolver', () => {
  it('appends bin/ on posix', () => {
    assert.equal(resolveGlobalBinDir('/usr/local', 'darwin'), '/usr/local/bin');
    assert.equal(resolveGlobalBinDir('/usr/local', 'linux'), '/usr/local/bin');
  });
  it('uses the prefix directly on windows (no bin/ subfolder)', () => {
    assert.equal(resolveGlobalBinDir('C:\\nvm4w\\nodejs', 'windows'), 'C:\\nvm4w\\nodejs');
  });
});

describe('linkGlobalBin', () => {
  it('gracefully reports failure (not throwing) for a non-writable prefix', { skip: process.platform === 'win32' }, () => {
    const roDir = mkdtempSync(join(tmpdir(), 'myelin-ro-'));
    const binDir = join(roDir, 'bin');
    mkdirSync(binDir);
    chmodSync(binDir, 0o555);
    try {
      const result = linkGlobalBin({ repoRoot: process.cwd(), os: 'darwin', prefix: roDir });
      assert.equal(result.linked, false);
      assert.ok(result.reason.includes('no write access'));
    } finally {
      chmodSync(binDir, 0o755);
      rmSync(roDir, { recursive: true, force: true });
    }
  });
});

describe('spawnDetachedService', () => {
  it('passes exe and argStr to the PS script (Task Scheduler path)', () => {
    const scripts = [];
    spawnDetachedService('MyelinHeadroom', 'C:\\bin\\headroom.exe', 'proxy --port 8787', {
      runPsFn: (s) => scripts.push(s),
    });
    assert.equal(scripts.length, 1);
    const s = scripts[0];
    assert.ok(s.includes('MyelinHeadroom'), 'task name present');
    assert.ok(s.includes('headroom.exe'), 'exe present');
    assert.ok(s.includes('proxy --port 8787'), 'args present');
    assert.ok(s.includes('Register-ScheduledTask'), 'uses task scheduler');
    assert.ok(s.includes('Start-ScheduledTask'), 'starts the task');
  });

  it('sanitises task name — strips non-alphanumeric chars', () => {
    const scripts = [];
    spawnDetachedService('Myelin Headroom!', 'exe.exe', 'arg', { runPsFn: (s) => scripts.push(s) });
    assert.ok(scripts[0].includes('Myelin_Headroom_'), 'spaces/special chars replaced with _');
  });

  it('escapes single quotes in exe path', () => {
    const scripts = [];
    spawnDetachedService('T', "C:\\it's\\exe.exe", 'args', { runPsFn: (s) => scripts.push(s) });
    assert.ok(scripts[0].includes("it''s"), 'single quotes doubled');
  });

  it('includes fallback Start-Process block', () => {
    const scripts = [];
    spawnDetachedService('T', 'exe.exe', 'args', { runPsFn: (s) => scripts.push(s) });
    assert.ok(scripts[0].includes('Start-Process'), 'fallback present');
    assert.ok(scripts[0].includes('SSL_CERT_FILE'), 'loads SSL env vars in fallback');
  });

  it('does not path-normalize URL-valued task env vars', () => {
    const scripts = [];
    spawnDetachedService('T', 'exe.exe', 'args', {
      runPsFn: (s) => scripts.push(s),
      taskEnv: {
        HEADROOM_WORKSPACE_DIR: 'C:/Users/alice/.myelin/copilot',
        ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889',
      },
    });
    assert.ok(scripts[0].includes('set "HEADROOM_WORKSPACE_DIR=C:\\Users\\alice\\.myelin\\copilot"'));
    assert.ok(scripts[0].includes('set "ANTHROPIC_TARGET_API_URL=http://127.0.0.1:8889"'));
    assert.ok(!scripts[0].includes('http:\\\\127.0.0.1:8889'));
  });
});
