import { resolveCompressionConfig } from '../config/compression.mjs';

const PRIMARY_SERVICE_ID = 'myelin-compression';
const COPILOT_SERVICE_ID = 'myelin-copilot-compression';
const DEFAULT_EGRESS_PORT = 8889;

function serviceIdFor(purpose) {
  return purpose === 'primary' ? PRIMARY_SERVICE_ID : COPILOT_SERVICE_ID;
}

function healthUrlFor(port) {
  return `http://127.0.0.1:${port}/health`;
}

function normalizeTcpPort(value, {
  fallback,
  label = 'port',
} = {}) {
  if (value === undefined && fallback !== undefined) return fallback;

  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;

  throw new Error(
    `Invalid compression runtime ${label}: ${value}. Expected a TCP port between 1 and 65535.`,
  );
}

function resolveEgressPort(config, explicitEgressPort) {
  return explicitEgressPort !== undefined
    ? normalizeTcpPort(explicitEgressPort, { label: 'egress port' })
    : normalizeTcpPort(config?.proxy?.mitm?.egress_port, {
        fallback: DEFAULT_EGRESS_PORT,
        label: 'egress port',
      });
}

function disabledRuntime(purpose, port) {
  return {
    purpose,
    backend: 'disabled',
    port,
    enabled: false,
    command: null,
    args: [],
    env: { MYELIN_COMPRESS: '0' },
    healthUrl: null,
    serviceId: serviceIdFor(purpose),
  };
}

function runtimeFor({
  purpose,
  selected,
  port,
  headroomLiteBin,
  headroomOriginalBin,
  egressPort,
}) {
  if (selected.backend === 'disabled') return disabledRuntime(purpose, port);

  const serviceId = serviceIdFor(purpose);
  const upstream = `http://127.0.0.1:${egressPort}`;

  if (selected.backend === 'headroom-lite') {
    return {
      purpose,
      backend: selected.backend,
      port,
      enabled: true,
      command: headroomLiteBin,
      args: [],
      env: purpose === 'primary'
        ? { HEADROOM_LITE_PORT: String(port) }
        : {
            HEADROOM_LITE_PORT: String(port),
            HEADROOM_LITE_COMPRESS_PROXY: 'true',
            HEADROOM_LITE_UPSTREAM: upstream,
          },
      healthUrl: healthUrlFor(port),
      serviceId,
    };
  }

  return {
    purpose,
    backend: selected.backend,
    port,
    enabled: true,
    command: headroomOriginalBin,
    args: ['proxy', '--port', String(port), '--mode', selected.original.mode],
    env: purpose === 'primary'
      ? {
          HEADROOM_PORT: String(port),
          HEADROOM_MODE: selected.original.mode,
          HEADROOM_INTERCEPT_ENABLED:
            selected.original.intercept_tool_results ? '1' : '0',
          OPENAI_TARGET_API_URL: selected.original.openai_target_url,
          ...(selected.original.corporate_proxy
            ? { HTTPS_PROXY: selected.original.corporate_proxy }
            : {}),
        }
      : {
          HEADROOM_PORT: String(port),
          HEADROOM_MODE: selected.original.mode,
          ANTHROPIC_TARGET_API_URL: upstream,
          OPENAI_TARGET_API_URL: upstream,
          NO_PROXY: '127.0.0.1,localhost,::1',
        },
    healthUrl: healthUrlFor(port),
    serviceId,
  };
}

function assertDistinctPorts(primary, copilot, egressPort) {
  if (primary.enabled && copilot.enabled && primary.port === copilot.port) {
    throw new Error(
      `compression runtime ports conflict: ${primary.port} is configured for both primary and copilot`,
    );
  }

  if (!copilot.enabled) return;

  if (primary.enabled && primary.port === egressPort) {
    throw new Error(
      `compression runtime ports conflict: ${primary.port} is configured for both primary and egress`,
    );
  }

  if (copilot.port === egressPort) {
    throw new Error(
      `compression runtime ports conflict: ${copilot.port} is configured for both copilot and egress`,
    );
  }
}

export function buildCompressionRuntimes(
  config,
  {
    headroomLiteBin,
    headroomOriginalBin,
  } = {},
  options = {},
) {
  const selected = resolveCompressionConfig(config);
  const egressPort = resolveEgressPort(config, options.egressPort);
  const primary = runtimeFor({
    purpose: 'primary',
    selected,
    port: selected.port,
    headroomLiteBin,
    headroomOriginalBin,
    egressPort,
  });
  const copilot = selected.copilotProxy.enabled
    ? runtimeFor({
        purpose: 'copilot',
        selected,
        port: selected.copilotProxy.port,
        headroomLiteBin,
        headroomOriginalBin,
        egressPort,
      })
    : disabledRuntime('copilot', selected.copilotProxy.port);

  assertDistinctPorts(primary, copilot, egressPort);
  return { primary, copilot };
}
