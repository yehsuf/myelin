import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildVerifyResults } from '../src/cli/verify.mjs';
import { parseManagedMitmStatus } from '../src/service/windows.mjs';

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
    });

    assert.deepEqual(probes, []);
    assert.deepEqual(results.map(({ name }) => name), [
      'Headroom service',
      'Headroom health',
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
    });

    assert.deepEqual(waits, []);
    assert.deepEqual(results.map(({ name }) => name), [
      'Headroom Lite service',
      'Headroom Lite health',
    ]);
  });

  it('skips the managed headroom watchdog check on WinSW headroom-lite installs', async () => {
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

    assert.equal(results.some(({ name }) => name === 'Myelin Headroom Watchdog'), false);
    assert.equal(results.some(({ name }) => name === 'Myelin Copilot Headroom Watchdog'), true);
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
    });

    assert.deepEqual(statuses, ['primary']);
    assert.deepEqual(probes, [8790]);
  });
});
