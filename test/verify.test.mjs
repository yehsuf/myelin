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
      serviceStatusImpl: async () => ({ running: true, label: 'headroom' }),
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
      'Headroom health (:8787)',
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
      serviceStatusImpl: async () => ({ running: true, label: 'headroom' }),
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
      'headroom-lite (:8790)',
    ]);
  });

  it('skips the managed headroom watchdog check on WinSW headroom-lite installs', async () => {
    const results = await buildVerifyResults({
      config: {
        proxy: {
          engine: 'headroom_lite',
          headroom: { enabled: false, port: 8787 },
          headroom_lite: { enabled: true, port: 8790 },
          mitm: { enabled: false, port: 8888 },
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
      includeToolChecks: false,
      includeMitmCheck: false,
      copilotHeadroomServiceStatusImpl: async () => ({ running: true, label: 'copilot' }),
      includeCopilotHeadroomCheck: true,
      includeWatchdogChecks: true,
    });

    assert.equal(results.some(({ name }) => name === 'Myelin Headroom Watchdog'), false);
    assert.equal(results.some(({ name }) => name === 'Myelin Copilot Headroom Watchdog'), true);
  });

  it('passes the configured Copilot-Headroom port into the registry status probe', async () => {
    const calls = [];
    const results = await buildVerifyResults({
      config: {
        proxy: {
          headroom: { enabled: false, port: 8787 },
          headroom_lite: { enabled: false, port: 8790 },
          mitm: { enabled: false, port: 8888 },
          copilot_headroom: { enabled: true, port: 9797 },
          windows_service: { manager: 'registry' },
        },
      },
      platform: 'win32',
      waitForHeadroomImpl: async () => true,
      copilotHeadroomServiceStatusImpl: async (opts) => {
        calls.push(opts);
        return { running: true, label: 'copilot' };
      },
      detectToolImpl: async () => ({ installed: true, version: '1.0.0' }),
      detectRtkImpl: async () => ({ installed: false, version: null }),
      detectSembleImpl: async () => ({ installed: false, version: null }),
      whichImpl: async () => '/usr/bin/mitmdump',
      includeToolChecks: false,
      includeMitmCheck: false,
      includeCopilotHeadroomCheck: true,
      includeWatchdogChecks: false,
    });

    assert.deepEqual(calls, [{ manager: 'registry', port: 9797 }]);
    assert.equal(results.some(({ name }) => name === 'Copilot-Headroom health (:9797)'), true);
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
      serviceStatusImpl: async () => ({ running: true, label: 'headroom' }),
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
});
