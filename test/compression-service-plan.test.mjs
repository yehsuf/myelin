import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../src/config/reader.mjs';
import {
  buildEngineInstancePlan,
  buildServiceEnginePlan,
} from '../src/config/engine-runtime.mjs';
import { resolveMitmCompression } from '../src/config/compression-env.mjs';
import { applyServiceEngineInstallPlan, resolveProxyEnvPort } from '../src/install.mjs';
import { runRestart } from '../src/cli/restart.mjs';
import { resolveCompressionConfig } from '../src/update/engine-selection.mjs';

const TEST_DIR = join(homedir(), '.tokenstack-service-plan-test');

async function load(yaml) {
  const p = join(TEST_DIR, 'config.yaml');
  writeFileSync(p, yaml);
  return loadConfig(p, () => {});
}

function primaryOf(plan) {
  return plan.instances.find(({ role }) => role === 'primary');
}
function copilotOf(plan) {
  return plan.instances.find(({ role }) => role === 'copilot');
}

describe('canonical compression.* drives the install/restart service plan', () => {
  before(() => { mkdirSync(TEST_DIR, { recursive: true }); });
  after(() => { rmSync(TEST_DIR, { recursive: true, force: true }); });

  it('routes the selected headroom-lite engine onto the canonical compression.port', async () => {
    const cfg = await load('compression:\n  backend: headroom-lite\n  port: 9191\n');
    const plan = buildEngineInstancePlan(cfg);
    assert.equal(plan.engine, 'headroom_lite');
    assert.equal(primaryOf(plan).port, 9191);
    assert.equal(buildServiceEnginePlan(cfg).selectedPort, 9191);
  });

  it('routes the selected headroom-original engine onto the canonical compression.port and original settings', async () => {
    const cfg = await load(
      'compression:\n  backend: headroom-original\n  port: 9292\n  original:\n    mode: token\n    openai_target_url: https://example.test\n',
    );
    const plan = buildEngineInstancePlan(cfg);
    assert.equal(plan.engine, 'headroom');
    assert.equal(primaryOf(plan).port, 9292);
    assert.equal(buildServiceEnginePlan(cfg).selectedPort, 9292);
    assert.equal(cfg.proxy.headroom.mode, 'token');
    assert.equal(cfg.proxy.headroom.openai_target_url, 'https://example.test');
  });

  it('routes the dedicated Copilot instance onto the canonical copilot_proxy.port', async () => {
    const cfg = await load(
      'compression:\n  backend: headroom-lite\n  copilot_proxy:\n    enabled: true\n    port: 9393\n',
    );
    const plan = buildEngineInstancePlan(cfg);
    assert.equal(copilotOf(plan).port, 9393);
    assert.equal(resolveMitmCompression(cfg).copilotHeadroomPort, 9393);
  });

  it('a canonical shared port overrides the legacy per-engine default at runtime', async () => {
    // headroom-lite's legacy alias default is 8790; the canonical shared
    // compression.port must win and drive the actual engine port.
    const cfg = await load('compression:\n  backend: headroom-lite\n  port: 8787\n');
    assert.equal(cfg.compression.port, 8787);
    assert.equal(primaryOf(buildEngineInstancePlan(cfg)).port, 8787);
    assert.equal(buildServiceEnginePlan(cfg).selectedPort, 8787);
  });

  it('backend: disabled produces no engine instances in the plan', async () => {
    const cfg = await load('compression:\n  backend: disabled\n');
    const plan = buildEngineInstancePlan(cfg);
    assert.equal(plan.engine, 'disabled');
    assert.deepEqual(plan.instances, []);
    const svc = buildServiceEnginePlan(cfg);
    assert.equal(svc.selectedEngine, 'disabled');
    assert.equal(svc.shouldRunManagedHeadroom, false);
    assert.equal(svc.shouldRemoveManagedHeadroom, true);
  });

  it('backend: disabled installs no engine service and removes any owned engine instances', async () => {
    const cfg = await load('compression:\n  backend: disabled\n');
    const events = [];
    const result = await applyServiceEngineInstallPlan({
      cfg,
      os: 'linux',
      home: '/home/alice',
      installEngineInstanceImpl: async (instance) => {
        events.push(`install:${instance.engine}:${instance.role}`);
      },
      removeEngineInstanceImpl: async (instance) => {
        events.push(`remove:${instance.engine}:${instance.role}`);
      },
      detectToolImpl: async () => assert.fail('no engine binary should be probed when disabled'),
    });
    assert.ok(!events.some((e) => e.startsWith('install:')), `expected no installs, got ${events}`);
    assert.ok(events.includes('remove:headroom:primary'));
    assert.ok(events.includes('remove:headroom_lite:primary'));
    assert.equal(result.selectedInstallEngine, 'disabled');
  });

  it('backend: disabled restart starts no engine and removes both engines', async () => {
    const cfg = await load('compression:\n  backend: disabled\n');
    const events = [];
    await runRestart({
      config: cfg,
      detectOSImpl: () => 'linux',
      homedirImpl: () => '/home/alice',
      restartEngineInstanceImpl: async (instance) => {
        events.push(`start:${instance.engine}:${instance.role}`);
        return true;
      },
      removeEngineInstanceImpl: async (instance) => {
        events.push(`remove:${instance.engine}:${instance.role}`);
      },
      restartMitmImpl: async () => {},
      restartWatchdogImpl: async () => {},
      log: () => {},
      warn: () => {},
    });
    assert.ok(!events.some((e) => e.startsWith('start:')), `expected no engine starts, got ${events}`);
    assert.ok(events.includes('remove:headroom:primary'));
    assert.ok(events.includes('remove:headroom_lite:primary'));
  });

  it('preserves an explicit proxy.copilot_headroom.enabled under canonical compression.backend', async () => {
    // The user set the legacy Copilot proxy toggle explicitly; canonical
    // compression.backend must NOT clobber it back to the default (false).
    const cfg = await load(
      'compression:\n  backend: headroom-lite\nproxy:\n  copilot_headroom:\n    enabled: true\n',
    );
    assert.equal(cfg.proxy.copilot_headroom.enabled, true);
    // And the wiring flows through: an enabled Copilot proxy yields a copilot instance.
    assert.ok(copilotOf(buildEngineInstancePlan(cfg)), 'expected a copilot engine instance');

    // The reverse override is also respected: explicit false wins over a
    // canonically-enabled Copilot proxy.
    const off = await load(
      'compression:\n  backend: headroom-lite\n  copilot_proxy:\n    enabled: true\nproxy:\n  copilot_headroom:\n    enabled: false\n',
    );
    assert.equal(off.proxy.copilot_headroom.enabled, false);
  });

  it('resolves a nominal canonical proxy env port when disabled has no primary instance', async () => {
    // disabled backend => no engine instances; the Claude/shell/wrapper config
    // must still receive a real numeric port, never null/"null".
    const cfg = await load('compression:\n  backend: disabled\n');
    const primary = primaryOf(buildEngineInstancePlan(cfg));
    assert.equal(primary, undefined);
    const envPort = resolveProxyEnvPort(cfg, primary);
    assert.equal(typeof envPort, 'number');
    assert.ok(Number.isInteger(envPort) && envPort > 0, `expected a real port, got ${envPort}`);
    assert.equal(String(envPort) === 'null', false);
  });

  it('reconciles an explicit legacy copilot toggle into resolved compression.copilot_proxy so update keeps it', async () => {
    // User enabled the Copilot proxy via the legacy key while selecting a
    // canonical backend but NOT setting compression.copilot_proxy.enabled.
    // The resolved canonical block (which the update orchestrator reads via
    // resolveCompressionConfig) must reflect the enable, or update stops it.
    const cfg = await load(
      'compression:\n  backend: headroom-lite\nproxy:\n  copilot_headroom:\n    enabled: true\n',
    );
    assert.equal(cfg.compression.copilot_proxy.enabled, true);
    assert.equal(resolveCompressionConfig(cfg).copilotProxy.enabled, true);

    // A legacy explicit disable must likewise flow into the canonical block.
    const off = await load(
      'compression:\n  backend: headroom-lite\nproxy:\n  copilot_headroom:\n    enabled: false\n',
    );
    assert.equal(off.compression.copilot_proxy.enabled, false);
    assert.equal(resolveCompressionConfig(off).copilotProxy.enabled, false);
  });
});
