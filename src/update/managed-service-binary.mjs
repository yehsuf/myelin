import nodeFs from 'node:fs';

import { COMPONENTS } from './component-manifest.mjs';
import { buildComponentInstallPlan } from './component-installers.mjs';
import { componentVersionDir, readPointersReadOnly } from './version-store.mjs';

/**
 * Managed compression component that backs each compression proxy backend. The
 * staged apply must resolve executables from these pinned components rather than
 * from unpinned global `which` lookups.
 */
const BACKEND_COMPONENT = new Map([
  ['headroom-lite', 'headroomLite'],
  ['headroom-original', 'headroomOriginal'],
]);

const MITM_COMPONENT_NAME = 'mitmproxy';

export function managedCompressionComponentName(backend) {
  return BACKEND_COMPONENT.get(backend) ?? null;
}

function pinnedExecutableError(message) {
  const error = new Error(message);
  error.code = 'ERR_UPDATE_PINNED_EXECUTABLE_MISSING';
  return error;
}

/**
 * Resolves the pinned executable for a manifest-managed component from its
 * activated component pointer. Fails hard (never falls back to a global binary)
 * when the pointer is missing or the pinned executable is absent, so a staged
 * apply always runs the pinned version.
 */
function resolveManagedComponentBinary(name, {
  componentsRoot,
  platform = process.platform,
  fs = nodeFs,
  existsImpl,
} = {}) {
  if (typeof componentsRoot !== 'string' || componentsRoot.length === 0) {
    throw pinnedExecutableError('Managed component binary resolution requires a components root.');
  }

  const component = COMPONENTS[name];
  if (!component) {
    throw pinnedExecutableError(`Unknown managed component "${name}".`);
  }

  const normalizedPlatform = platform === 'windows' ? 'win32' : platform;
  const { current } = readPointersReadOnly(componentsRoot, name, { platform: normalizedPlatform, fs });
  if (typeof current !== 'string' || current.length === 0) {
    throw pinnedExecutableError(
      `No pinned ${name} component pointer under ${componentsRoot}.`,
    );
  }

  const destination = componentVersionDir(componentsRoot, name, current);
  const { binPath } = buildComponentInstallPlan(component, destination, normalizedPlatform);
  if (typeof binPath !== 'string' || binPath.length === 0) {
    throw pinnedExecutableError(`Managed ${name} component has no executable path.`);
  }

  const exists = existsImpl ? existsImpl(binPath) : fs.existsSync(binPath);
  if (!exists) {
    throw pinnedExecutableError(`Pinned ${name} executable is missing at ${binPath}.`);
  }

  return { name, version: current, binPath };
}

/**
 * Resolves the pinned compression backend executable. A disabled/unknown backend
 * has no managed binary and returns `null`; a managed backend fails hard when its
 * pointer or executable is missing.
 */
export function resolveManagedCompressionBinary({
  backend,
  componentsRoot,
  platform = process.platform,
  fs = nodeFs,
  existsImpl,
}) {
  const name = managedCompressionComponentName(backend);
  if (!name) return null;
  return resolveManagedComponentBinary(name, { componentsRoot, platform, fs, existsImpl });
}

/**
 * Resolves the pinned `mitmdump` executable from the managed `mitmproxy`
 * component pointer. Used by the staged apply so the MITM service always runs
 * the activated pinned mitmproxy instead of a stale global `mitmdump`.
 */
export function resolveManagedMitmBinary({
  componentsRoot,
  platform = process.platform,
  fs = nodeFs,
  existsImpl,
}) {
  return resolveManagedComponentBinary(MITM_COMPONENT_NAME, { componentsRoot, platform, fs, existsImpl });
}
