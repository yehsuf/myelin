/**
 * Compression-backend selection adapter for the update subsystem.
 *
 * The canonical compression configuration is main's `proxy.engine` model
 * (`headroom` | `headroom_lite`) plus `proxy.compression.enabled` and
 * `proxy.copilot_headroom.enabled`. The atomic-update orchestrator, however,
 * is written against a small "compression selection" shape
 * (`backend` in `headroom-lite` | `headroom-original` | `disabled`, plus a
 * `copilotProxy` flag) and against runtime descriptors with a `healthUrl`.
 *
 * This module maps the canonical `proxy.engine` config onto that shape so the
 * update subsystem stays backend-agnostic without reintroducing the retired
 * top-level `compression.backend` schema.
 */
import { normalizeCompressionEngine } from '../config/schema.mjs';
import { buildEngineInstancePlan } from '../config/engine-runtime.mjs';

const DEFAULT_COPILOT_PORT = 8788;

/**
 * Resolves the selected component backend name used by the update manifest
 * (`headroom-lite` | `headroom-original` | `disabled`) from the canonical
 * `proxy.engine` / `proxy.compression.enabled` config. Legacy `proxy.headroom*`
 * flags are honoured through `normalizeCompressionEngine`.
 */
export function selectedBackend(config = {}) {
  if (config?.proxy?.compression?.enabled === false) return 'disabled';
  const engine = normalizeCompressionEngine(config, () => {});
  return engine === 'headroom_lite' ? 'headroom-lite' : 'headroom-original';
}

/**
 * Returns the compression selection consumed by the orchestrator and the
 * `myelin update` CLI: `{ backend, copilotProxy: { enabled, port } }`.
 */
export function resolveCompressionConfig(config = {}) {
  const backend = selectedBackend(config);
  const copilot = config?.proxy?.copilot_headroom ?? {};
  return {
    backend,
    copilotProxy: {
      enabled: copilot.enabled === true,
      port: copilot.port ?? DEFAULT_COPILOT_PORT,
    },
  };
}

function disabledRuntime(purpose) {
  return { purpose, backend: 'disabled', enabled: false, healthUrl: null, port: null };
}

/**
 * Builds `{ primary, copilot }` runtime descriptors for the selected engine,
 * shaped for the orchestrator's readiness checks. Derived from main's
 * `buildEngineInstancePlan` so a single engine (never a mixed pair) is planned.
 */
export function buildCompressionRuntimes(config = {}) {
  const backend = selectedBackend(config);
  if (backend === 'disabled') {
    return { primary: disabledRuntime('primary'), copilot: disabledRuntime('copilot') };
  }
  const engine = backend === 'headroom-lite' ? 'headroom_lite' : 'headroom';
  const normalized = { ...config, proxy: { ...(config.proxy ?? {}), engine } };
  const { instances } = buildEngineInstancePlan(normalized);
  const byRole = new Map(instances.map(instance => [instance.role, instance]));
  const runtimeFor = purpose => {
    const instance = byRole.get(purpose);
    return instance
      ? { purpose, backend, enabled: true, healthUrl: instance.healthUrl, port: instance.port }
      : disabledRuntime(purpose);
  };
  return { primary: runtimeFor('primary'), copilot: runtimeFor('copilot') };
}

/**
 * Probes a runtime descriptor's `/health` endpoint. Mirrors the shape expected
 * by the orchestrator's `verifyService` consumer: `{ ok, backend, response }`.
 */
export async function probeCompressionHealth(runtime, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 3000,
} = {}) {
  if (!runtime?.enabled || !runtime.healthUrl) {
    return {
      ok: runtime?.backend === 'disabled',
      backend: runtime?.backend ?? 'disabled',
      response: null,
    };
  }
  try {
    const response = await fetchImpl(runtime.healthUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.ok === true, backend: runtime.backend, response: null };
  } catch {
    return { ok: false, backend: runtime.backend, response: null };
  }
}

/**
 * Config migration is a no-op under the canonical `proxy.engine` model: legacy
 * key handling lives in `readUserConfig`/`normalizeCompressionEngine`, and the
 * orchestrator must not rewrite the user's config file during an update.
 */
export function migrateLegacyCompressionConfig(parsed = {}) {
  return { config: structuredClone(parsed ?? {}), changed: false, warnings: [] };
}
