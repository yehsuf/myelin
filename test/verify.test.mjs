import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildVerifyResults, checkManagedRuntime } from '../src/cli/verify.mjs';
import { parseManagedMitmStatus, windowsWatchdogTaskName } from '../src/service/windows.mjs';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

describe('buildVerifyResults engine selection', () => {
  const baseConfig = {
    proxy: {
      headroom: { enabled: true, port: 8787 },
      headroom_lite: { enabled: false, port: 8790 },
      mitm: { enabled: false, port: 8888 },
      copilot_headroom: { enabled: false, port: 8788 },
      windows_service: { manager: 'registry' },
    },
  };

  it('does not probe headroom-lite when Python headroom is selected', async () => {
    const probes = [];
    const results = await buildVerifyResults({
      config: { ...baseConfig, proxy: { ...baseConfig.proxy, engine: 'headroom' } },
      probeHeadroomLiteImpl: async (port) => {
        probes.push(`lite:${port}`);
        return { status: 'ok', mode: 'cache' };
      },
      engineInstanceStatusImpl: async () => ({ running: true, label: 'headroom' }),
      waitForHeadroomImpl: async () => true,
      detectToolImpl: async () => ({ installed: true, version: '1.0.0' }),
      detectRtkImpl: async () => ({ installed: false, version: null }),
      detectSembleImpl: async () => ({ installed: false, version: null }),
      whichImpl: async () => '/usr/bin/mitmdump',
      includeToolChecks: false,
      includeMitmCheck: false,
      includeCopilotHeadroomCheck: false,
      includeWatchdogChecks: false,
      includeManagedRuntimeCheck: false,
    });

    assert.deepEqual(probes, []);
    assert.deepEqual(results.map(({ name }) => name), [
      'Headroom service',
      'Headroom health',
      'Copilot proxy',
    ]);
  });

  it('does not probe Python headroom when headroom-lite is selected', async () => {
    const waits = [];
    const results = await buildVerifyResults({
      config: {
        ...baseConfig,
        proxy: {
          ...baseConfig.proxy,
          engine: 'headroom_lite',
          headroom: { enabled: false, port: 8787 },
          headroom_lite: { enabled: true, port: 8790 },
        },
      },
      probeHeadroomLiteImpl: async () => ({ status: 'ok', mode: 'cache' }),
      engineInstanceStatusImpl: async () => ({ running: true, label: 'headroom' }),
      waitForHeadroomImpl: async (port) => {
        waits.push(port);
        return true;
      },
      detectToolImpl: async () => ({ installed: true, version: '1.0.0' }),
      detectRtkImpl: async () => ({ installed: false, version: null }),
      detectSembleImpl: async () => ({ installed: false, version: null }),
      whichImpl: async () => '/usr/bin/mitmdump',
      includeToolChecks: false,
      includeMitmCheck: false,
      includeCopilotHeadroomCheck: false,
      includeWatchdogChecks: false,
      includeManagedRuntimeCheck: false,
    });

    assert.deepEqual(waits, []);
    assert.deepEqual(results.map(({ name }) => name), [
      'Headroom Lite service',
      'Headroom Lite health',
      'Copilot proxy',
    ]);
  });

  it('reports watchdogs for the selected Lite descriptor IDs on WinSW', async () => {
    const results = await buildVerifyResults({
      config: {
        proxy: {
          engine: 'headroom_lite',
          headroom: { enabled: false, port: 8787 },
          headroom_lite: { enabled: true, port: 8790 },
          mitm: { enabled: true, port: 8888 },
          copilot_headroom: { enabled: true, port: 8788 },
          windows_service: { manager: 'winsw', watchdog_enabled: true, watchdog_interval_minutes: 2 },
        },
      },
      platform: 'win32',
      probeHeadroomLiteImpl: async () => ({ status: 'ok', mode: 'cache' }),
      waitForHeadroomImpl: async () => true,
      detectToolImpl: async () => ({ installed: true, version: '1.0.0' }),
      detectRtkImpl: async () => ({ installed: false, version: null }),
      detectSembleImpl: async () => ({ installed: false, version: null }),
      whichImpl: async () => '/usr/bin/mitmdump',
      engineInstanceStatusImpl: async () => ({ running: true, label: 'copilot' }),
      includeToolChecks: false,
      includeMitmCheck: false,
      includeCopilotHeadroomCheck: true,
      includeWatchdogChecks: true,
    });

    assert.equal(results.some(({ name }) => name === 'Myelin Headroom Lite Primary Watchdog'), true);
    assert.equal(results.some(({ name }) => name === 'Myelin Headroom Lite Copilot Watchdog'), true);
  });

  for (const engine of ['headroom', 'headroom_lite']) {
    for (const copilotEnabled of [false, true]) {
      it(`queries WinSW watchdogs by resolved ${engine} descriptor IDs${copilotEnabled ? ' with Copilot' : ''}`, async () => {
        const commands = [];
        const config = {
          proxy: {
            engine,
            headroom: { enabled: engine === 'headroom', port: 8787 },
            headroom_lite: { enabled: engine === 'headroom_lite', port: 8790 },
            mitm: { enabled: true, port: 8888 },
            copilot_headroom: { enabled: copilotEnabled, port: 8788 },
            windows_service: { manager: 'winsw', watchdog_enabled: true, watchdog_interval_minutes: 2 },
          },
        };
        const descriptorIds = [
          `${engine}-primary`,
          ...(copilotEnabled ? [`${engine}-copilot`] : []),
        ];
        const taskNames = descriptorIds.map((id) => windowsWatchdogTaskName({ id }));

        const results = await buildVerifyResults({
          config,
          platform: 'win32',
          engineInstanceStatusImpl: async () => ({ running: true }),
          waitForHeadroomImpl: async () => true,
          probeHeadroomLiteImpl: async () => ({ status: 'ok', mode: 'cache' }),
          execSyncImpl: (command) => commands.push(command),
          includeToolChecks: false,
          includeMitmCheck: false,
          includeWatchdogChecks: true,
        });

        assert.deepEqual(commands, taskNames.map((taskName) => `schtasks /query /tn "${taskName}"`));
        assert.deepEqual(
          results.filter(({ name }) => name.endsWith('Watchdog')).map(({ name }) => name),
          taskNames,
        );
      });
    }
  }

  it('queries an enabled Copilot watchdog even when its service probe is omitted', async () => {
    const commands = [];
    await buildVerifyResults({
      config: {
        proxy: {
          engine: 'headroom_lite',
          headroom: { enabled: false, port: 8787 },
          headroom_lite: { enabled: true, port: 8790 },
          mitm: { enabled: true, port: 8888 },
          copilot_headroom: { enabled: true, port: 8788 },
          windows_service: { manager: 'winsw', watchdog_enabled: true, watchdog_interval_minutes: 2 },
        },
      },
      platform: 'win32',
      engineInstanceStatusImpl: async () => ({ running: true }),
      probeHeadroomLiteImpl: async () => ({ status: 'ok', mode: 'cache' }),
      execSyncImpl: (command) => commands.push(command),
      includeToolChecks: false,
      includeMitmCheck: false,
      includeCopilotHeadroomCheck: false,
    });

    assert.deepEqual(commands, [
      'schtasks /query /tn "Myelin Headroom Lite Primary Watchdog"',
      'schtasks /query /tn "Myelin Headroom Lite Copilot Watchdog"',
    ]);
  });

  it('passes the configured Copilot descriptor into the generic status probe', async () => {
    const calls = [];
    const results = await buildVerifyResults({
      config: {
        proxy: {
          headroom: { enabled: false, port: 8787 },
          headroom_lite: { enabled: false, port: 8790 },
          mitm: { enabled: true, port: 8888 },
          copilot_headroom: { enabled: true, port: 9797 },
          windows_service: { manager: 'registry' },
        },
      },
      platform: 'win32',
      waitForHeadroomImpl: async () => true,
      engineInstanceStatusImpl: async (instance, options) => {
        calls.push({ role: instance.role, port: instance.port, options });
        return { running: true, label: instance.role };
      },
      includeToolChecks: false,
      includeMitmCheck: false,
      includeCopilotHeadroomCheck: true,
      includeWatchdogChecks: false,
      includeManagedRuntimeCheck: false,
    });

    assert.deepEqual(calls, [
      { role: 'primary', port: 8787, options: { manager: 'registry' } },
      { role: 'copilot', port: 9797, options: { manager: 'registry' } },
    ]);
    assert.equal(results.some(({ name }) => name === 'Copilot Headroom health'), true);
  });

  it('does not let an unrelated mitmdump probe make verify green', async () => {
    const probe = parseManagedMitmStatus('mitmdump.exe');
    const results = await buildVerifyResults({
      config: {
        proxy: {
          headroom: { enabled: true, port: 8787 },
          headroom_lite: { enabled: false, port: 8790 },
          mitm: { enabled: true, port: 8888 },
          copilot_headroom: { enabled: false, port: 8788 },
          windows_service: { manager: 'registry' },
        },
      },
      platform: 'win32',
      engineInstanceStatusImpl: async () => ({ running: true, label: 'headroom' }),
      waitForHeadroomImpl: async () => true,
      mitmServiceStatusImpl: async () => probe,
      detectToolImpl: async () => ({ installed: true, version: '1.0.0' }),
      detectRtkImpl: async () => ({ installed: false, version: null }),
      detectSembleImpl: async () => ({ installed: false, version: null }),
      whichImpl: async () => 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\mitmdump.exe',
      includeToolChecks: false,
      includeCopilotHeadroomCheck: false,
      includeWatchdogChecks: false,
      includeManagedRuntimeCheck: false,
    });

    const mitm = results.find(({ name }) => name === 'Mitmproxy service (:8888)');
    assert.equal(mitm?.ok, false);
    assert.equal(results.every(({ ok }) => ok), false);
  });

  it('does not let Copilot-Headroom health make main Headroom verify green', async () => {
    const results = await buildVerifyResults({
      config: {
        proxy: {
          engine: 'headroom',
          headroom: { enabled: true, port: 8787 },
          headroom_lite: { enabled: false, port: 8790 },
          mitm: { enabled: true, port: 8888 },
          copilot_headroom: { enabled: true, port: 8788 },
          windows_service: { manager: 'registry' },
        },
      },
      platform: 'win32',
      engineInstanceStatusImpl: async (instance) => instance.role === 'primary'
        ? { running: false, state: 'Stopped' }
        : { running: true, label: 'copilot' },
      waitForHeadroomImpl: async (port) => port === 8788,
      detectToolImpl: async () => ({ installed: true, version: '1.0.0' }),
      detectRtkImpl: async () => ({ installed: false, version: null }),
      detectSembleImpl: async () => ({ installed: false, version: null }),
      whichImpl: async () => '/usr/bin/mitmdump',
      includeToolChecks: false,
      includeMitmCheck: false,
      includeCopilotHeadroomCheck: true,
      includeWatchdogChecks: false,
      includeManagedRuntimeCheck: false,
    });

    const headroomService = results.find(({ name }) => name === 'Headroom service');
    const headroomHealth = results.find(({ name }) => name === 'Headroom health');
    const copilotHealth = results.find(({ name }) => name === 'Copilot Headroom health');
    assert.equal(headroomService?.ok, false);
    assert.equal(headroomHealth?.ok, false);
    assert.equal(copilotHealth?.ok, true);
    assert.equal(results.every(({ ok }) => ok), false);
  });

  it('shows Lite primary and Lite Copilot rows, never Python Headroom', async () => {
    const probes = [];
    const statuses = [];
    const results = await buildVerifyResults({
      config: {
        proxy: {
          engine: 'headroom_lite',
          headroom: { enabled: false, port: 8787 },
          headroom_lite: { enabled: true, port: 8790 },
          mitm: { enabled: true, port: 8888 },
          copilot_headroom: { enabled: true, port: 8788 },
          windows_service: { manager: 'registry' },
        },
      },
      engineInstanceStatusImpl: async (instance) => {
        statuses.push(`${instance.engine}:${instance.role}`);
        return { running: true, label: instance.id };
      },
      probeHeadroomLiteImpl: async (port) => {
        probes.push(port);
        return { status: 'ok', mode: 'cache' };
      },
      waitForHeadroomImpl: () => assert.fail('Python Headroom must not be probed'),
      includeToolChecks: false,
      includeMitmCheck: false,
      includeWatchdogChecks: false,
      includeManagedRuntimeCheck: false,
    });

    assert.deepEqual(results.filter(({ name }) => /headroom/i.test(name)).map(({ name }) => name), [
      'Headroom Lite service', 'Headroom Lite health',
      'Copilot Headroom Lite service', 'Copilot Headroom Lite health',
    ]);
    assert.deepEqual(statuses, ['headroom_lite:primary', 'headroom_lite:copilot']);
    assert.deepEqual(probes, [8790, 8788]);
  });

  it('does not status or probe a disabled Copilot descriptor', async () => {
    const statuses = [];
    const probes = [];
    await buildVerifyResults({
      config: {
        proxy: {
          engine: 'headroom_lite',
          headroom: { enabled: false, port: 8787 },
          headroom_lite: { enabled: true, port: 8790 },
          mitm: { enabled: false, port: 8888 },
          copilot_headroom: { enabled: false, port: 8788 },
          windows_service: { manager: 'registry' },
        },
      },
      engineInstanceStatusImpl: async (instance) => {
        statuses.push(instance.role);
        return { running: true };
      },
      probeHeadroomLiteImpl: async (port) => {
        probes.push(port);
        return { status: 'ok', mode: 'cache' };
      },
      includeToolChecks: false,
      includeMitmCheck: false,
      includeWatchdogChecks: false,
      includeManagedRuntimeCheck: false,
    });

    assert.deepEqual(statuses, ['primary']);
    assert.deepEqual(probes, [8790]);
  });

  it('does not probe a Copilot descriptor when compression is disabled despite its persisted opt-in', async () => {
    const statuses = [];
    const probes = [];
    const results = await buildVerifyResults({
      config: {
        proxy: {
          engine: 'headroom_lite',
          compression: { enabled: false },
          headroom_lite: { enabled: true, port: 8790 },
          mitm: { enabled: true, port: 8888, egress_port: 8889 },
          copilot_headroom: { enabled: true, port: 8788 },
          windows_service: { manager: 'winsw', watchdog_enabled: true },
        },
      },
      platform: 'win32',
      engineInstanceStatusImpl: async (instance) => {
        statuses.push(instance.id);
        return { running: true };
      },
      probeHeadroomLiteImpl: async (port) => {
        probes.push(port);
        return { status: 'ok', mode: 'cache' };
      },
      execSyncImpl: () => {},
      includeToolChecks: false,
      includeMitmCheck: false,
      includeWatchdogChecks: true,
    });

    assert.deepEqual(statuses, ['headroom_lite-primary']);
    assert.deepEqual(probes, [8790]);
    assert.equal(results.some(({ name }) => /Copilot/i.test(name)), false);
  });

  it('shows explicit disabled row when copilot_proxy is off', async () => {
    const results = await buildVerifyResults({
      config: {
        proxy: {
          engine: 'headroom_lite',
          headroom_lite: { enabled: true, port: 8787 },
          mitm: { enabled: true, port: 8888 },
          copilot_headroom: { enabled: false, port: 8788 },
          windows_service: { manager: 'registry' },
        },
      },
      engineInstanceStatusImpl: async () => ({ running: true }),
      probeHeadroomLiteImpl: async () => ({ status: 'ok', mode: 'deterministic' }),
      mitmServiceStatusImpl: async () => ({ running: true }),
      detectToolImpl: async () => null,
      detectRtkImpl: async () => null,
      includeToolChecks: false,
      includeWatchdogChecks: false,
      includeManagedRuntimeCheck: false,
    });
    const copilotRow = results.find(r => r.name === 'Copilot proxy');
    assert.ok(copilotRow, 'should have a Copilot proxy row even when disabled');
    assert.equal(copilotRow.ok, false);
    assert.match(copilotRow.detail, /disabled/);
  });

  it('returns engine plan error row instead of throwing on port collision', async () => {
    const results = await buildVerifyResults({
      config: {
        proxy: {
          engine: 'headroom_lite',
          headroom_lite: { enabled: true, port: 8788 }, // same as copilot default → collision
          mitm: { enabled: true, port: 8888 },
          copilot_headroom: { enabled: true, port: 8788 },
          windows_service: { manager: 'registry' },
        },
      },
      engineInstanceStatusImpl: async () => ({ running: true }),
      probeHeadroomLiteImpl: async () => ({ status: 'ok', mode: 'deterministic' }),
      mitmServiceStatusImpl: async () => ({ running: true }),
      detectToolImpl: async () => null,
      detectRtkImpl: async () => null,
      includeToolChecks: false,
      includeWatchdogChecks: false,
      includeManagedRuntimeCheck: false,
    });
    const planRow = results.find(r => r.name === 'Engine plan');
    assert.ok(planRow, 'should have engine plan error row');
    assert.equal(planRow.ok, false);
    assert.match(planRow.detail, /collision/i);
  });

  it('includes headroom-lite version in health detail when health response provides it (VERIFY-VER-001)', async () => {
    const results = await buildVerifyResults({
      config: {
        proxy: {
          engine: 'headroom_lite',
          headroom_lite: { enabled: true, port: 8787 },
          mitm: { enabled: false, port: 8888 },
          copilot_headroom: { enabled: false, port: 8788 },
          windows_service: { manager: 'registry' },
        },
      },
      engineInstanceStatusImpl: async () => ({ running: true }),
      probeHeadroomLiteImpl: async () => ({ status: 'ok', mode: 'deterministic', version: '0.32.0-0' }),
      detectToolImpl: async () => null,
      detectRtkImpl: async () => null,
      includeToolChecks: false,
      includeMitmCheck: false,
      includeWatchdogChecks: false,
      includeManagedRuntimeCheck: false,
    });
    const healthRow = results.find(r => r.name === 'Headroom Lite health');
    assert.ok(healthRow?.ok);
    assert.ok(healthRow.detail.includes('v0.32.0-0'), `should include version, got: ${healthRow.detail}`);
    assert.ok(healthRow.detail.includes('deterministic'), `should include mode, got: ${healthRow.detail}`);
  });

  it('health detail omits version prefix when health response has no version', async () => {
    const results = await buildVerifyResults({
      config: {
        proxy: {
          engine: 'headroom_lite',
          headroom_lite: { enabled: true, port: 8787 },
          mitm: { enabled: false, port: 8888 },
          copilot_headroom: { enabled: false, port: 8788 },
          windows_service: { manager: 'registry' },
        },
      },
      engineInstanceStatusImpl: async () => ({ running: true }),
      probeHeadroomLiteImpl: async () => ({ status: 'ok', mode: 'cache' }),
      detectToolImpl: async () => null,
      detectRtkImpl: async () => null,
      includeToolChecks: false,
      includeMitmCheck: false,
      includeWatchdogChecks: false,
      includeManagedRuntimeCheck: false,
    });
    const healthRow = results.find(r => r.name === 'Headroom Lite health');
    assert.ok(healthRow?.ok);
    assert.ok(!healthRow.detail.includes('v'), `should not have version prefix, got: ${healthRow.detail}`);
    assert.ok(healthRow.detail.includes('cache'), `should include mode, got: ${healthRow.detail}`);
  });

  it('adds E2E Copilot API tunnel row when e2e=true and mitmproxy is enabled', async () => {
    const results = await buildVerifyResults({
      config: {
        proxy: {
          engine: 'headroom_lite',
          headroom_lite: { enabled: true, port: 8787 },
          mitm: { enabled: true, port: 8888 },
          copilot_headroom: { enabled: false, port: 8788 },
          windows_service: { manager: 'registry' },
        },
      },
      e2e: true,
      engineInstanceStatusImpl: async () => ({ running: true }),
      probeHeadroomLiteImpl: async () => ({ status: 'ok', mode: 'deterministic' }),
      mitmServiceStatusImpl: async () => ({ running: true }),
      probeProxyTunnelImpl: async ({ targetHost }) => ({ ok: true, detail: `tunnel to ${targetHost}:443 established` }),
      resolveManagedMitmBinaryImpl: () => { throw new Error('no managed binary'); },
      whichImpl: async () => '/usr/bin/mitmdump',
      detectToolImpl: async () => null,
      detectRtkImpl: async () => null,
      includeToolChecks: false,
      includeWatchdogChecks: false,
      includeManagedRuntimeCheck: false,
    });
    const e2eRow = results.find(r => r.name === 'E2E: Copilot API tunnel');
    assert.ok(e2eRow, 'should have E2E row when e2e=true');
    assert.ok(e2eRow.ok);
    assert.ok(e2eRow.detail.includes('api.individual.githubcopilot.com'));
  });

  it('omits E2E rows when e2e=false (default)', async () => {
    const results = await buildVerifyResults({
      config: {
        proxy: {
          engine: 'headroom_lite',
          headroom_lite: { enabled: true, port: 8787 },
          mitm: { enabled: true, port: 8888 },
          copilot_headroom: { enabled: false, port: 8788 },
          windows_service: { manager: 'registry' },
        },
      },
      engineInstanceStatusImpl: async () => ({ running: true }),
      probeHeadroomLiteImpl: async () => ({ status: 'ok', mode: 'deterministic' }),
      mitmServiceStatusImpl: async () => ({ running: true }),
      resolveManagedMitmBinaryImpl: () => { throw new Error('no managed binary'); },
      whichImpl: async () => '/usr/bin/mitmdump',
      detectToolImpl: async () => null,
      detectRtkImpl: async () => null,
      includeToolChecks: false,
      includeWatchdogChecks: false,
      includeManagedRuntimeCheck: false,
    });
    assert.ok(!results.some(r => r.name.startsWith('E2E:')), 'no E2E rows by default');
  });
});

describe('checkManagedRuntime', () => {
  function makeRelease(root, releaseId, { withEntrypoint = true } = {}) {
    const releaseDir = join(root, 'releases', releaseId);
    if (withEntrypoint) {
      mkdirSync(join(releaseDir, 'src', 'cli'), { recursive: true });
      writeFileSync(join(releaseDir, 'src', 'cli', 'index.mjs'), '// entrypoint');
    } else {
      mkdirSync(releaseDir, { recursive: true });
    }
    return releaseDir;
  }

  it('returns ok=true when no current.json (unmanaged install)', () => {
    const home = mkdtempSync(join(tmpdir(), 'verify-rt-'));
    mkdirSync(join(home, '.myelin'), { recursive: true });
    const result = checkManagedRuntime({
      home,
      existsSyncImpl: (p) => p.endsWith('current.json') ? false : true,
      readFileSyncImpl: () => { throw new Error('should not be called'); },
    });
    assert.equal(result.ok, true);
    assert.match(result.detail, /unmanaged/);
  });

  it('returns ok=false when release dir is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'verify-rt-'));
    const root = join(home, '.myelin');
    mkdirSync(root, { recursive: true });
    const releaseId = 'main-abc1234';
    const runtimeRoot = join(root, 'releases', releaseId);
    const currentJson = JSON.stringify({ version: 1, releaseId, runtimeRoot });
    writeFileSync(join(root, 'current.json'), currentJson);

    const result = checkManagedRuntime({ home, env: {} });
    assert.equal(result.ok, false);
    assert.match(result.detail, /missing/);
  });

  it('returns ok=false when entrypoint is missing inside release dir', () => {
    const home = mkdtempSync(join(tmpdir(), 'verify-rt-'));
    const root = join(home, '.myelin');
    const releaseId = 'main-abc1234';
    const releaseDir = makeRelease(root, releaseId, { withEntrypoint: false });
    const currentJson = JSON.stringify({ version: 1, releaseId, runtimeRoot: releaseDir });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'current.json'), currentJson);

    const result = checkManagedRuntime({ home, env: {} });
    assert.equal(result.ok, false);
    assert.match(result.detail, /entrypoint missing/);
  });

  it('returns ok=true when release dir and entrypoint both exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'verify-rt-'));
    const root = join(home, '.myelin');
    const releaseId = 'main-abc1234def5678901234567890abc1234def56789';
    const releaseDir = makeRelease(root, releaseId);
    const currentJson = JSON.stringify({ version: 1, releaseId, runtimeRoot: releaseDir });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'current.json'), currentJson);

    const result = checkManagedRuntime({ home, env: {} });
    assert.equal(result.ok, true);
    assert.match(result.detail, /healthy/);
  });

  it('returns ok=false when current symlink points to different release than current.json', () => {
    if (process.platform === 'win32') return;
    const home = mkdtempSync(join(tmpdir(), 'verify-rt-'));
    try {
      const root = join(home, '.myelin');
      const releaseId = 'main-abc1234def5678901234567890abc1234def56789';
      const releaseDir = makeRelease(root, releaseId);
      const currentJson = JSON.stringify({ version: 1, releaseId, runtimeRoot: releaseDir });
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'current.json'), currentJson);

      // Create a DIFFERENT release dir and point the symlink at it
      const otherReleaseId = 'main-def5678abc1234def5678abc1234def5678abc12';
      const otherReleaseDir = makeRelease(root, otherReleaseId);
      symlinkSync(otherReleaseDir, join(root, 'current'));

      const result = checkManagedRuntime({ home, env: {} });
      assert.equal(result.ok, false);
      assert.match(result.detail, /≠/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns ok=true when current symlink matches current.json', () => {
    if (process.platform === 'win32') return;
    const home = mkdtempSync(join(tmpdir(), 'verify-rt-'));
    try {
      const root = join(home, '.myelin');
      const releaseId = 'main-abc1234def5678901234567890abc1234def56789';
      const releaseDir = makeRelease(root, releaseId);
      const realReleaseDir = realpathSync(releaseDir);
      const currentJson = JSON.stringify({ version: 1, releaseId, runtimeRoot: realReleaseDir });
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'current.json'), currentJson);
      symlinkSync(join('releases', releaseId), join(root, 'current'));

      const result = checkManagedRuntime({ home, env: {} });
      assert.equal(result.ok, true);
      assert.match(result.detail, /healthy/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
