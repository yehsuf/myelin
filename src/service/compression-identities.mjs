import { SERVER_FORBIDDEN_ENV } from './wrappers.mjs';

const SERVICE_ID_BY_PURPOSE = Object.freeze({
  primary: 'myelin-compression',
  copilot: 'myelin-copilot-compression',
});

const LEGACY_COMPRESSION_SERVICE_IDS = Object.freeze([
  'com.myelin.headroom',
  'com.myelin.headroom-lite',
  'com.ysufrin.headroom',
  'myelin-headroom',
  'myelin-headroom-lite',
  'MyelinHeadroom',
  'com.myelin.copilot-headroom',
  'myelin-copilot-headroom',
  'MyelinCopilotHeadroom',
]);

export function legacyCompressionServiceIds() {
  return [...LEGACY_COMPRESSION_SERVICE_IDS];
}

export function legacyCompressionServiceIdsFor(platform) {
  if (platform === 'darwin') {
    return LEGACY_COMPRESSION_SERVICE_IDS.filter(id => id.startsWith('com.'));
  }
  if (platform === 'linux') {
    return LEGACY_COMPRESSION_SERVICE_IDS.filter(id => id.startsWith('myelin-'));
  }
  return LEGACY_COMPRESSION_SERVICE_IDS.filter(id => id.startsWith('Myelin') || id.startsWith('myelin-'));
}

export function compressionServiceIdentity(runtime, platform) {
  const { purpose, serviceId } = runtime ?? {};
  const expectedServiceId = SERVICE_ID_BY_PURPOSE[purpose];
  if (!expectedServiceId || serviceId !== expectedServiceId) {
    throw new Error(`Invalid compression service identity for purpose '${purpose ?? ''}': ${serviceId ?? ''}`);
  }

  if (platform === 'darwin') {
    return `com.myelin.${serviceId.slice('myelin-'.length)}`;
  }
  if (platform === 'linux') {
    return `${serviceId}.service`;
  }
  return serviceId
    .split('-')
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('');
}

export function compressionServiceIdentities(platform) {
  return Object.fromEntries(
    Object.entries(SERVICE_ID_BY_PURPOSE).map(([purpose, serviceId]) => [
      purpose,
      compressionServiceIdentity({ purpose, serviceId }, platform),
    ]),
  );
}

export function compressionRuntimeEnv(runtime) {
  const forbidden = new Set(SERVER_FORBIDDEN_ENV);
  return Object.fromEntries(
    Object.entries(runtime?.env ?? {})
      .filter(([key, value]) => !forbidden.has(key) && value != null),
  );
}

export function assertCompressionRuntime(runtime) {
  compressionServiceIdentity(runtime, 'linux');
  if (!runtime.enabled) return runtime;
  if (typeof runtime.command !== 'string' || runtime.command.length === 0) {
    throw new Error(`Compression runtime '${runtime.serviceId}' is missing a command`);
  }
  if (!Array.isArray(runtime.args)) {
    throw new Error(`Compression runtime '${runtime.serviceId}' args must be an array`);
  }
  return runtime;
}
