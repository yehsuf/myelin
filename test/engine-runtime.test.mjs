import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildServiceEnginePlan } from '../src/config/engine-runtime.mjs';

describe('buildServiceEnginePlan', () => {
  it('keeps Python headroom as the managed engine when selected', () => {
    const plan = buildServiceEnginePlan({
      proxy: {
        engine: 'headroom',
        headroom: { port: 8787 },
        headroom_lite: { port: 8790 },
      },
    });

    assert.deepEqual(plan, {
      selectedEngine: 'headroom',
      selectedPort: 8787,
      headroomPort: 8787,
      headroomLitePort: 8790,
      shouldRunManagedHeadroom: true,
      shouldRemoveManagedHeadroom: false,
    });
  });

  it('switches mitm traffic to headroom-lite and removes managed headroom when selected', () => {
    const plan = buildServiceEnginePlan({
      proxy: {
        engine: 'headroom_lite',
        headroom: { port: 8787 },
        headroom_lite: { port: 8790 },
      },
    });

    assert.deepEqual(plan, {
      selectedEngine: 'headroom_lite',
      // explicit proxy.headroom_lite.port: 8790 is honored as a legacy alias;
      // with default config (no explicit port) selectedPort defaults to 8787.
      selectedPort: 8790,
      headroomPort: 8787,
      headroomLitePort: 8790,
      shouldRunManagedHeadroom: false,
      shouldRemoveManagedHeadroom: true,
    });
  });

  it('selectedPort is always the canonical compression.port regardless of engine', () => {
    // Core invariant from the owner requirement: single shared port for both engines.
    // Neither engine change nor per-engine legacy alias changes the active service port.
    assert.equal(
      buildServiceEnginePlan({}).selectedPort,
      8787,
      'default config → 8787',
    );
    assert.equal(
      buildServiceEnginePlan({ proxy: { engine: 'headroom_lite' } }).selectedPort,
      8787,
      'headroom-lite with no explicit compression.port → still 8787',
    );
    assert.equal(
      buildServiceEnginePlan({ compression: { port: 9090 } }).selectedPort,
      9090,
      'explicit compression.port overrides default',
    );
    assert.equal(
      buildServiceEnginePlan({
        compression: { port: 9090 },
        proxy: { engine: 'headroom_lite', headroom_lite: { port: 8790 } },
      }).selectedPort,
      9090,
      'compression.port wins over legacy per-engine port',
    );
  });
});

import { buildEngineInstancePlan } from '../src/config/engine-runtime.mjs';

describe('buildEngineInstancePlan', () => {
  it('routes engine state and logs through the relocated managed root', () => {
    const previousRoot = process.env.MYELIN_DIR;
    process.env.MYELIN_DIR = '/custom/myelin';
    try {
      const plan = buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: 8787 },
        },
      }, { home: '/home/alice', os: 'linux' });

      assert.deepEqual(plan.instances[0], {
        engine: 'headroom',
        role: 'primary',
        port: 8787,
        id: 'headroom-primary',
        stateDir: '/custom/myelin/state/headroom-primary',
        logPath: '/custom/myelin/headroom-primary.log',
        healthUrl: 'http://127.0.0.1:8787/health',
        env: {},
      });
    } finally {
      if (previousRoot === undefined) delete process.env.MYELIN_DIR;
      else process.env.MYELIN_DIR = previousRoot;
    }
  });

  it('creates two Lite descriptors without a Python service', () => {
    const plan = buildEngineInstancePlan({
      proxy: {
        engine: 'headroom_lite',
        headroom_lite: { port: 8790 },
        copilot_headroom: { enabled: true, port: 8788 },
        mitm: { egress_port: 8889 },
      },
    });
    assert.deepEqual(plan.instances.map(({ engine, role, port }) => ({ engine, role, port })), [
      { engine: 'headroom_lite', role: 'primary', port: 8790 },
      { engine: 'headroom_lite', role: 'copilot', port: 8788 },
    ]);
    assert.deepEqual(plan.instances[1].env, {
      HEADROOM_LITE_UPSTREAM: 'http://127.0.0.1:8889',
      HEADROOM_LITE_COMPRESS_PROXY: 'true',
    });
  });

  it('creates one Python descriptor when copilot is disabled', () => {
    const plan = buildEngineInstancePlan({
      proxy: {
        engine: 'headroom',
        headroom: { port: 8787 },
        copilot_headroom: { enabled: false, port: 8788 },
      },
    });
    assert.equal(plan.engine, 'headroom');
    assert.equal(plan.instances.length, 1);
    assert.equal(plan.instances[0].role, 'primary');
    assert.equal(plan.instances[0].engine, 'headroom');
    assert.equal(plan.instances[0].port, 8787);
  });

  it('creates two Python descriptors when copilot is enabled', () => {
    const plan = buildEngineInstancePlan({
      proxy: {
        engine: 'headroom',
        headroom: { port: 8787 },
        copilot_headroom: { enabled: true, port: 8788 },
        mitm: { egress_port: 8889 },
      },
    });
    assert.deepEqual(plan.instances.map(({ engine, role, port }) => ({ engine, role, port })), [
      { engine: 'headroom', role: 'primary', port: 8787 },
      { engine: 'headroom', role: 'copilot', port: 8788 },
    ]);
  });

  for (const [label, extraConfig] of [
    ['compression is disabled', { proxy: { compression: { enabled: false } } }],
    ['LiteLLM owns compression', { budget_routing: { litellm: true } }],
  ]) {
    it(`does not plan Copilot or egress listeners when ${label}`, () => {
      const plan = buildEngineInstancePlan({
        ...extraConfig,
        proxy: {
          engine: 'headroom',
          compression: { enabled: true },
          headroom: { port: 8889 },
          copilot_headroom: { enabled: true, port: 8889 },
          mitm: { port: 8888, egress_port: 8889 },
          ...extraConfig.proxy,
        },
      });

      assert.deepEqual(plan.instances.map(({ role, port, env }) => ({ role, port, env })), [
        { role: 'primary', port: 8889, env: {} },
      ]);
    });
  }

  it('gives each role a unique id, stateDir, logPath, and healthUrl', () => {
    const plan = buildEngineInstancePlan({
      proxy: {
        engine: 'headroom_lite',
        headroom_lite: { port: 8790 },
        copilot_headroom: { enabled: true, port: 8788 },
        mitm: { egress_port: 8889 },
      },
    });
    const [primary, copilot] = plan.instances;
    assert.notEqual(primary.id, copilot.id);
    assert.notEqual(primary.stateDir, copilot.stateDir);
    assert.notEqual(primary.logPath, copilot.logPath);
    assert.equal(primary.healthUrl, `http://127.0.0.1:${primary.port}/health`);
    assert.equal(copilot.healthUrl, `http://127.0.0.1:${copilot.port}/health`);
  });

  it('resolves WSL-selected Windows descriptors under the effective Windows home', () => {
    const plan = buildEngineInstancePlan({
      proxy: {
        engine: 'headroom_lite',
        headroom_lite: { port: 8790 },
        copilot_headroom: { enabled: true, port: 8788 },
        mitm: { egress_port: 8889 },
      },
    }, {
      home: '/home/alice',
      os: 'windows',
      defaultWindowsHomeImpl: (home) => {
        assert.equal(home, '/home/alice');
        return 'C:\\Users\\alice';
      },
    });

    assert.deepEqual(plan.instances.map(({ stateDir, logPath }) => ({ stateDir, logPath })), [
      {
        stateDir: 'C:\\Users\\alice\\.myelin\\state\\headroom_lite-primary',
        logPath: 'C:\\Users\\alice\\.myelin\\headroom_lite-primary.log',
      },
      {
        stateDir: 'C:\\Users\\alice\\.myelin\\state\\headroom_lite-copilot',
        logPath: 'C:\\Users\\alice\\.myelin\\headroom_lite-copilot.log',
      },
    ]);
  });
});

describe('buildEngineInstancePlan — Python copilot env', () => {
  it('populates Python copilot env with egress loopback URLs, HEADROOM_MODE, and NO_PROXY', () => {
    const plan = buildEngineInstancePlan({
      proxy: {
        engine: 'headroom',
        headroom: { port: 8787 },
        copilot_headroom: { enabled: true, port: 8788, mode: 'cache' },
        mitm: { egress_port: 8889 },
      },
    });
    const copilot = plan.instances.find(i => i.role === 'copilot');
    assert.deepEqual(copilot.env, {
      ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889',
      OPENAI_TARGET_API_URL: 'http://127.0.0.1:8889',
      HEADROOM_MODE: 'cache',
      NO_PROXY: '127.0.0.1,localhost,::1',
    });
  });

  it('uses mode from config in Python copilot HEADROOM_MODE', () => {
    const plan = buildEngineInstancePlan({
      proxy: {
        engine: 'headroom',
        headroom: { port: 8787 },
        copilot_headroom: { enabled: true, port: 8788, mode: 'passthrough' },
        mitm: { egress_port: 8889 },
      },
    });
    const copilot = plan.instances.find(i => i.role === 'copilot');
    assert.equal(copilot.env.HEADROOM_MODE, 'passthrough');
  });

  it('Python copilot env never contains a real provider URL', () => {
    const plan = buildEngineInstancePlan({
      proxy: {
        engine: 'headroom',
        headroom: { port: 8787 },
        copilot_headroom: { enabled: true, port: 8788, mode: 'cache' },
        mitm: { egress_port: 8889 },
      },
    });
    const copilot = plan.instances.find(i => i.role === 'copilot');
    for (const v of Object.values(copilot.env)) {
      assert.ok(!String(v).includes('anthropic.com'), `env value should not contain real provider URL: ${v}`);
      assert.ok(!String(v).includes('openai.com'), `env value should not contain real provider URL: ${v}`);
      assert.ok(!String(v).includes('githubcopilot.com'), `env value should not contain real provider URL: ${v}`);
    }
  });
});

describe('buildEngineInstancePlan — port collision rejection', () => {
  it('throws when primary port equals copilot port', () => {
    assert.throws(
      () => buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: 8788 },
          copilot_headroom: { enabled: true, port: 8788 },
          mitm: { port: 8888, egress_port: 8889 },
        },
      }),
      /collision|conflict|same port/i,
    );
  });

  it('throws when copilot port equals MITM ingress port', () => {
    assert.throws(
      () => buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: 8787 },
          copilot_headroom: { enabled: true, port: 8888 },
          mitm: { port: 8888, egress_port: 8889 },
        },
      }),
      /collision|conflict|same port/i,
    );
  });

  it('throws when copilot port equals MITM egress port', () => {
    assert.throws(
      () => buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: 8787 },
          copilot_headroom: { enabled: true, port: 8889 },
          mitm: { port: 8888, egress_port: 8889 },
        },
      }),
      /collision|conflict|same port/i,
    );
  });

  it('throws when primary port equals MITM ingress port', () => {
    assert.throws(
      () => buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: 8888 },
          copilot_headroom: { enabled: false, port: 8788 },
          mitm: { port: 8888, egress_port: 8889 },
        },
      }),
      /collision|conflict|same port/i,
    );
  });

  it('throws when primary port equals MITM egress port', () => {
    assert.throws(
      () => buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: 8889 },
          copilot_headroom: { enabled: true, port: 8788 },
          mitm: { port: 8888, egress_port: 8889 },
        },
      }),
      /collision|conflict|same port/i,
    );
  });

  it('does not throw when all ports are distinct', () => {
    assert.doesNotThrow(() =>
      buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: 8787 },
          copilot_headroom: { enabled: true, port: 8788 },
          mitm: { port: 8888, egress_port: 8889 },
        },
      }),
    );
  });
});

describe('buildEngineInstancePlan — MITM ingress/egress collision and defaulted ports', () => {
  it('throws when MITM ingress and egress share a port', () => {
    assert.throws(
      () => buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: 8787 },
          copilot_headroom: { enabled: true, port: 8788 },
          mitm: { port: 8888, egress_port: 8888 },
        },
      }),
      /collision|conflict|same port/i,
    );
  });

  it('throws when copilot port collides with defaulted MITM egress port', () => {
    // partial config — no mitm block; effective egress defaults to 8889
    assert.throws(
      () => buildEngineInstancePlan({
        proxy: {
          copilot_headroom: { enabled: true, port: 8889 },
        },
      }),
      /collision|conflict|same port/i,
    );
  });

  it('does not throw for valid partial config with copilot enabled at non-colliding port', () => {
    // partial config — no mitm block; effective ports 8888/8889, copilot at 8788
    assert.doesNotThrow(() =>
      buildEngineInstancePlan({
        proxy: {
          copilot_headroom: { enabled: true, port: 8788 },
        },
      }),
    );
  });
});

describe('buildEngineInstancePlan — port normalization and validation', () => {
  it('detects collision when primary port is string "8889" and MITM egress is numeric 8889', () => {
    assert.throws(
      () => buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: '8889' },
          copilot_headroom: { enabled: true, port: 8788 },
          mitm: { port: 8888, egress_port: 8889 },
        },
      }),
      /collision|conflict|same port/i,
    );
  });

  it('detects collision when copilot port is string "8788" and primary port is numeric 8788', () => {
    assert.throws(
      () => buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: 8788 },
          copilot_headroom: { enabled: true, port: '8788' },
          mitm: { port: 8888, egress_port: 8889 },
        },
      }),
      /collision|conflict|same port/i,
    );
  });

  it('normalizes valid quoted port "8787" and produces descriptor with numeric port 8787', () => {
    const plan = buildEngineInstancePlan({
      proxy: {
        engine: 'headroom',
        headroom: { port: '8787' },
        copilot_headroom: { enabled: false },
        mitm: { port: 8888, egress_port: 8889 },
      },
    });
    assert.strictEqual(plan.instances[0].port, 8787);
  });

  it('normalizes valid quoted MITM egress port "8889" and uses it in copilot env', () => {
    const plan = buildEngineInstancePlan({
      proxy: {
        engine: 'headroom_lite',
        headroom_lite: { port: 8790 },
        copilot_headroom: { enabled: true, port: 8788 },
        mitm: { port: 8888, egress_port: '8889' },
      },
    });
    assert.strictEqual(plan.instances[1].env.HEADROOM_LITE_UPSTREAM, 'http://127.0.0.1:8889');
  });

  it('rejects a non-numeric port value', () => {
    assert.throws(
      () => buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: 'abc' },
          copilot_headroom: { enabled: false },
        },
      }),
      /invalid port|out.of.range|not a.*port/i,
    );
  });

  it('rejects a fractional port value', () => {
    assert.throws(
      () => buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: 8787.5 },
          copilot_headroom: { enabled: false },
        },
      }),
      /invalid port|out.of.range|not a.*port/i,
    );
  });

  it('rejects a port of 0', () => {
    assert.throws(
      () => buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: 0 },
          copilot_headroom: { enabled: false },
        },
      }),
      /invalid port|out.of.range|not a.*port/i,
    );
  });

  it('rejects a port above 65535', () => {
    assert.throws(
      () => buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: 99999 },
          copilot_headroom: { enabled: false },
        },
      }),
      /invalid port|out.of.range|not a.*port/i,
    );
  });

  it('rejects a negative port value', () => {
    assert.throws(
      () => buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: -1 },
          copilot_headroom: { enabled: false },
        },
      }),
      /invalid port|out.of.range|not a.*port/i,
    );
  });
});

describe('buildEngineInstancePlan — active-listener-only collision detection', () => {
  it('does not throw when Copilot is disabled and primary port matches MITM egress (egress is inactive)', () => {
    // egress listener only exists when copilot_headroom.enabled === true
    assert.doesNotThrow(() =>
      buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: 8889 },
          copilot_headroom: { enabled: false },
          mitm: { port: 8888, egress_port: 8889 },
        },
      }),
    );
  });

  it('does not throw when MITM is disabled and primary port matches MITM ingress (ingress is inactive)', () => {
    // MITM ingress listener only exists when mitm.enabled !== false
    assert.doesNotThrow(() =>
      buildEngineInstancePlan({
        proxy: {
          engine: 'headroom',
          headroom: { port: 8888 },
          copilot_headroom: { enabled: false },
          mitm: { enabled: false, port: 8888, egress_port: 8889 },
        },
      }),
    );
  });

  it('silently disables Copilot when MITM is off (no throw — MITM gate handles it)', () => {
    // With copilot_headroom.enabled:true default, MITM-disabled installs must not throw.
    // resolveMitmCompression gates copilot on mitmEnabled, so buildEngineInstancePlan
    // sees copilotEnabled=false and returns a single primary instance.
    const plan = buildEngineInstancePlan({
      proxy: {
        engine: 'headroom',
        headroom: { port: 8787 },
        copilot_headroom: { enabled: true, port: 8788 },
        mitm: { enabled: false, port: 8888, egress_port: 8889 },
      },
    });
    assert.equal(plan.instances.length, 1);
    assert.equal(plan.instances[0].role, 'primary');
  });
});
