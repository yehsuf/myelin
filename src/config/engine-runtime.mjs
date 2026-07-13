export function selectedEngine(config = {}) {
  return config?.proxy?.engine === 'headroom_lite' ? 'headroom_lite' : 'headroom';
}

export function selectedEnginePort(config = {}) {
  return selectedEngine(config) === 'headroom_lite'
    ? (config?.proxy?.headroom_lite?.port ?? 8790)
    : (config?.proxy?.headroom?.port ?? 8787);
}

export function buildServiceEnginePlan(config = {}) {
  const engine = selectedEngine(config);
  const headroomPort = config?.proxy?.headroom?.port ?? 8787;
  const headroomLitePort = config?.proxy?.headroom_lite?.port ?? 8790;

  return {
    selectedEngine: engine,
    selectedPort: engine === 'headroom_lite' ? headroomLitePort : headroomPort,
    headroomPort,
    headroomLitePort,
    shouldRunManagedHeadroom: engine === 'headroom',
    shouldRemoveManagedHeadroom: engine !== 'headroom',
  };
}

import { homedir } from 'node:os';
import { join } from 'node:path';

function normalizePort(value, label) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port for ${label}: ${JSON.stringify(value)} is not a valid port (1–65535)`);
  }
  return n;
}

function buildEngineInstance({ engine, role, port, egressPort, config }) {
  const id = `${engine}-${role}`;
  const stateDir = join(homedir(), '.myelin', 'state', id);
  const logPath = join(homedir(), '.myelin', `${id}.log`);
  const healthUrl = `http://127.0.0.1:${port}/health`;
  let env = {};
  if (engine === 'headroom_lite' && role === 'copilot') {
    env = {
      HEADROOM_LITE_UPSTREAM: `http://127.0.0.1:${egressPort}`,
      HEADROOM_LITE_COMPRESS_PROXY: 'true',
    };
  } else if (engine === 'headroom' && role === 'copilot') {
    const loopbackTarget = `http://127.0.0.1:${egressPort}`;
    env = {
      ANTHROPIC_TARGET_API_URL: loopbackTarget,
      OPENAI_TARGET_API_URL: loopbackTarget,
      HEADROOM_MODE: config?.proxy?.copilot_headroom?.mode ?? 'cache',
      NO_PROXY: '127.0.0.1,localhost,::1',
    };
  }
  return { engine, role, port, id, stateDir, logPath, healthUrl, env };
}

function assertNoPlanPortCollisions(primaryPort, copilotPort, mitmPort, egressPort) {
  const pairs = [
    [primaryPort, copilotPort, 'primary and copilot'],
    [primaryPort, mitmPort, 'primary and MITM ingress'],
    [primaryPort, egressPort, 'primary and MITM egress'],
    [copilotPort, mitmPort, 'copilot and MITM ingress'],
    [copilotPort, egressPort, 'copilot and MITM egress'],
    [mitmPort, egressPort, 'MITM ingress and egress'],
  ];
  for (const [a, b, label] of pairs) {
    if (a != null && b != null && a === b) {
      throw new Error(`Port collision: ${label} share port ${a}`);
    }
  }
}

export function buildEngineInstancePlan(config = {}) {
  const engine = selectedEngine(config);

  const rawPrimaryPort = selectedEnginePort(config);
  const copilot = config.proxy?.copilot_headroom ?? {};
  const rawMitmPort = config?.proxy?.mitm?.port ?? 8888;
  const rawEgressPort = config?.proxy?.mitm?.egress_port ?? 8889;

  const primaryPort = normalizePort(rawPrimaryPort, 'primary');
  const mitmPort = normalizePort(rawMitmPort, 'MITM ingress');
  const egressPort = normalizePort(rawEgressPort, 'MITM egress');

  if (copilot.enabled === true) {
    const rawCopilotPort = copilot.port ?? 8788;
    const copilotPort = normalizePort(rawCopilotPort, 'copilot');
    assertNoPlanPortCollisions(primaryPort, copilotPort, mitmPort, egressPort);

    const instances = [
      buildEngineInstance({ engine, role: 'primary', port: primaryPort, egressPort, config }),
      buildEngineInstance({ engine, role: 'copilot', port: copilotPort, egressPort, config }),
    ];
    return { engine, instances };
  } else {
    assertNoPlanPortCollisions(primaryPort, null, mitmPort, egressPort);
    const instances = [
      buildEngineInstance({ engine, role: 'primary', port: primaryPort, egressPort, config }),
    ];
    return { engine, instances };
  }
}
