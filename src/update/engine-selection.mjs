/**
 * Compression-backend selection adapter for the update subsystem.
 *
 * The canonical compression configuration is PR #23's `compression.backend`
 * model (`headroom-lite` | `headroom-original` | `disabled`) plus a shared
 * `compression.port` and a `compression.copilot_proxy` toggle. The legacy
 * `proxy.engine` / `proxy.headroom*` keys are honoured as a derived alias so
 * raw configs that predate the canonical block (e.g. the orchestrator's parsed
 * YAML snapshots) keep resolving to the correct backend.
 *
 * The atomic-update orchestrator is written against a small "compression
 * selection" shape (`backend`, plus a `copilotProxy` flag) and against runtime
 * descriptors with a `healthUrl`. This module maps whichever config model is
 * present onto that shape so the update subsystem stays backend-agnostic.
 */
import { normalizeCompressionEngine } from '../config/schema.mjs';
import { COMPRESSION_BACKENDS } from '../config/compression.mjs';
import { buildEngineInstancePlan } from '../config/engine-runtime.mjs';

const DEFAULT_COPILOT_PORT = 8788;

/**
 * True when the config carries a canonical `compression.backend` selection.
 */
function hasCanonicalBackend(config) {
  const compression = config?.compression;
  return typeof compression === 'object'
    && compression !== null
    && !Array.isArray(compression)
    && compression.backend != null;
}

/**
 * Resolves the selected component backend name used by the update manifest
 * (`headroom-lite` | `headroom-original` | `disabled`). Prefers the canonical
 * `compression.backend`; falls back to the legacy `proxy.engine` /
 * `proxy.compression.enabled` derivation for raw configs that lack it.
 */
export function selectedBackend(config = {}) {
  if (hasCanonicalBackend(config)) {
    const backend = config.compression.backend;
    if (!COMPRESSION_BACKENDS.includes(backend)) {
      throw new Error(
        `[myelin] invalid compression.backend "${backend}"; expected one of ${COMPRESSION_BACKENDS.join(', ')}`,
      );
    }
    return backend;
  }
  if (config?.proxy?.compression?.enabled === false) return 'disabled';
  const engine = normalizeCompressionEngine(config, () => {});
  return engine === 'headroom_lite' ? 'headroom-lite' : 'headroom-original';
}

/**
 * Returns the compression selection consumed by the orchestrator and the
 * `myelin update` CLI: `{ backend, copilotProxy: { enabled, port } }`. Reads the
 * canonical `compression.copilot_proxy` when present, else the legacy
 * `proxy.copilot_headroom` alias.
 */
export function resolveCompressionConfig(config = {}) {
  const backend = selectedBackend(config);
  const copilot = hasCanonicalBackend(config)
    ? (config.compression.copilot_proxy ?? {})
    : (config?.proxy?.copilot_headroom ?? {});
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
