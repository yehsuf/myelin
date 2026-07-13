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

function buildEngineInstance({ engine, role, port, config }) {
  const id = `${engine}-${role}`;
  const stateDir = join(homedir(), '.myelin', 'state', id);
  const logPath = join(homedir(), '.myelin', `${id}.log`);
  const healthUrl = `http://127.0.0.1:${port}/health`;
  const egressPort = config?.proxy?.mitm?.egress_port ?? 8889;
  let env = {};
  if (engine === 'headroom_lite' && role === 'copilot') {
    env = {
      HEADROOM_LITE_UPSTREAM: `http://127.0.0.1:${egressPort}`,
      HEADROOM_LITE_COMPRESS_PROXY: 'true',
    };
  }
  return { engine, role, port, id, stateDir, logPath, healthUrl, env };
}

export function buildEngineInstancePlan(config = {}) {
  const engine = selectedEngine(config);
  const primaryPort = selectedEnginePort(config);
  const copilot = config.proxy?.copilot_headroom ?? {};
  const instances = [buildEngineInstance({ engine, role: 'primary', port: primaryPort, config })];
  if (copilot.enabled === true) {
    instances.push(buildEngineInstance({
      engine, role: 'copilot', port: copilot.port ?? 8788, config,
    }));
  }
  return { engine, instances };
}
