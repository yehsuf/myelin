import { readFileSync, existsSync } from 'node:fs';
import { load as parse } from 'js-yaml';
import { DEFAULT_CONFIG, mergeDeep, normalizeCompressionEngine } from './schema.mjs';
import { COMPRESSION_BACKENDS, reconcileCanonicalCopilotEnabled } from './compression.mjs';
import { homedir } from 'node:os';
import { managedPaths } from '../shared/myelin-paths.mjs';

export const DEFAULT_CONFIG_PATH = managedPaths({ home: homedir() }).configPath;

// One shared compression port for every backend (PR #23 design).
const SHARED_COMPRESSION_PORT = 8787;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reconstructs the legacy `proxy.*` alias from a canonical `compression.*`
 * selection so the install/restart service lifecycle — which still reads
 * `proxy.engine` / `proxy.headroom*` / `proxy.copilot_headroom` via
 * `buildEngineInstancePlan` / `buildServiceEnginePlan` — observes exactly the
 * backend, port, Copilot proxy, and `original.*` settings the user chose
 * canonically.
 *
 * This branch only fires when the user explicitly set `compression.backend`
 * (canonical wins). The canonical block is projected onto the alias for the
 * SELECTED engine: the single shared `compression.port` becomes that engine's
 * port, `compression.copilot_proxy` becomes `proxy.copilot_headroom`, and
 * `compression.original.*` becomes the classic `proxy.headroom.*` settings.
 *
 * A canonical value is only projected onto a legacy field when the user did
 * NOT ALSO set that legacy field explicitly (`userProxy`): an explicit legacy
 * value is treated as a deliberate per-key override and wins. This preserves
 * `myelin config set proxy.headroom.port <n>` (and the analogous
 * `headroom_lite.port` / `copilot_headroom.*`) round-trips, whose write path
 * bakes the whole derived config — including a `compression.backend` — back to
 * disk. When the user did NOT set `compression.backend` at all, the reader
 * forward-derives `compression.*` from `proxy.*` instead (see
 * `deriveCanonicalCompression`).
 */
function proxyAliasFor(backend, compression, userProxy = {}) {
  const userHeadroom = isPlainObject(userProxy.headroom) ? userProxy.headroom : {};
  const userLite = isPlainObject(userProxy.headroom_lite) ? userProxy.headroom_lite : {};
  const userCopilot = isPlainObject(userProxy.copilot_headroom) ? userProxy.copilot_headroom : {};
  const original = compression.original ?? {};

  // Emit `field: value` from `canonicalValue` only when the user did not set
  // the corresponding legacy key explicitly (then the legacy value wins).
  const ifUnset = (userScope, key, canonicalValue) =>
    (canonicalValue != null && !Object.hasOwn(userScope, key)) ? { [key]: canonicalValue } : {};

  const copilotAlias = {
    ...ifUnset(userCopilot, 'enabled', compression.copilot_proxy?.enabled === true),
    ...ifUnset(userCopilot, 'port', compression.copilot_proxy?.port),
    ...ifUnset(userCopilot, 'mode', original.mode),
  };
  if (backend === 'disabled') {
    return {
      compression: { enabled: false },
      copilot_headroom: copilotAlias,
    };
  }
  if (backend === 'headroom-lite') {
    return {
      engine: 'headroom_lite',
      compression: { enabled: true },
      headroom: { enabled: false },
      headroom_lite: { enabled: true, ...ifUnset(userLite, 'port', compression.port) },
      copilot_headroom: copilotAlias,
    };
  }
  return {
    engine: 'headroom',
    compression: { enabled: true },
    headroom: {
      enabled: true,
      ...ifUnset(userHeadroom, 'port', compression.port),
      ...ifUnset(userHeadroom, 'mode', original.mode),
      ...ifUnset(userHeadroom, 'intercept_tool_results', original.intercept_tool_results),
      ...ifUnset(userHeadroom, 'corporate_proxy', original.corporate_proxy),
      ...ifUnset(userHeadroom, 'openai_target_url', original.openai_target_url),
    },
    headroom_lite: { enabled: false },
    copilot_headroom: copilotAlias,
  };
}

/**
 * Derives the canonical `compression.*` block. When the user explicitly set
 * `compression.backend`, canonical wins and the legacy `proxy.*` alias is
 * reconciled to match. Otherwise the canonical block is forward-derived from
 * the already-resolved `proxy.*` model so `compression.*` is always populated.
 */
function deriveCanonicalCompression(merged, userConfig) {
  const userCompression = isPlainObject(userConfig.compression) ? userConfig.compression : null;

  if (userCompression && userCompression.backend != null) {
    const backend = userCompression.backend;
    if (!COMPRESSION_BACKENDS.includes(backend)) {
      throw new Error(
        `[myelin] invalid compression.backend "${backend}"; expected one of ${COMPRESSION_BACKENDS.join(', ')}`,
      );
    }
    const compression = mergeDeep(DEFAULT_CONFIG.compression, userCompression);
    const userProxy = isPlainObject(userConfig.proxy) ? userConfig.proxy : {};

    // Reverse reconciliation (mirror of proxyAliasFor's `ifUnset`): when the
    // user toggled the Copilot proxy via the LEGACY `proxy.copilot_headroom.enabled`
    // key but did NOT set the canonical `compression.copilot_proxy.enabled`, the
    // legacy value must flow INTO the canonical block. The update orchestrator
    // reads the canonical `compression.copilot_proxy.enabled` (see
    // update/engine-selection.mjs resolveCompressionConfig); without this it
    // would see the canonical default and stop a Copilot proxy the user
    // explicitly enabled. Shared helper keeps both read paths consistent.
    const reconciledCopilotEnabled = reconcileCanonicalCopilotEnabled(userConfig);
    if (reconciledCopilotEnabled !== undefined) {
      compression.copilot_proxy = { ...compression.copilot_proxy, enabled: reconciledCopilotEnabled };
    }

    return { compression, proxyOverride: proxyAliasFor(backend, compression, userProxy) };
  }

  const proxy = merged.proxy ?? {};
  const headroom = proxy.headroom ?? {};
  const copilot = proxy.copilot_headroom ?? {};
  const disabled = proxy.compression?.enabled === false;
  const backend = disabled
    ? 'disabled'
    : (proxy.engine === 'headroom_lite' ? 'headroom-lite' : 'headroom-original');
  const compression = {
    backend,
    port: headroom.port ?? SHARED_COMPRESSION_PORT,
    copilot_proxy: {
      enabled: copilot.enabled === true,
      port: copilot.port ?? DEFAULT_CONFIG.compression.copilot_proxy.port,
    },
    original: {
      mode: headroom.mode ?? DEFAULT_CONFIG.compression.original.mode,
      intercept_tool_results:
        headroom.intercept_tool_results ?? DEFAULT_CONFIG.compression.original.intercept_tool_results,
      corporate_proxy: headroom.corporate_proxy ?? DEFAULT_CONFIG.compression.original.corporate_proxy,
      openai_target_url:
        headroom.openai_target_url ?? DEFAULT_CONFIG.compression.original.openai_target_url,
    },
  };
  return { compression, proxyOverride: null };
}

export function readUserConfig(configPath = DEFAULT_CONFIG_PATH, warn = console.warn) {
  let userConfig = {};
  if (existsSync(configPath)) {
    try {
      userConfig = parse(readFileSync(configPath, 'utf8')) ?? {};
    } catch (e) {
      warn(`[myelin] Warning: Could not parse config at ${configPath}: ${e.message}`);
    }
  }
  return userConfig;
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH, warn = console.warn) {
  const userConfig = readUserConfig(configPath, warn);
  let merged = mergeDeep(DEFAULT_CONFIG, userConfig);

  // Env var overrides (highest priority)
  if (process.env.HEADROOM_PORT) {
    const rawPort = parseInt(process.env.HEADROOM_PORT, 10);
    if (!Number.isNaN(rawPort)) {
      merged = mergeDeep(merged, { proxy: { headroom: { port: rawPort } } });
    } else {
      warn(`[myelin] Warning: HEADROOM_PORT="${process.env.HEADROOM_PORT}" is not a valid integer, ignoring.`);
    }
  }
  if (process.env.MYELIN_PROFILE) {
    merged._profile = process.env.MYELIN_PROFILE;
  }
  if (process.env.MYELIN_INDEX_TIER) {
    merged.index_tier = process.env.MYELIN_INDEX_TIER;
  }

  const engine = normalizeCompressionEngine(userConfig, warn);
  const legacyCompressionDisabled =
    userConfig.proxy?.compression?.enabled === undefined &&
    userConfig.proxy?.headroom?.enabled === false &&
    userConfig.proxy?.engine !== 'headroom_lite' &&
    userConfig.proxy?.headroom_lite?.enabled !== true;
  merged = mergeDeep(merged, {
    proxy: {
      engine,
      ...(legacyCompressionDisabled ? { compression: { enabled: false } } : {}),
      headroom: { enabled: engine === 'headroom' },
      headroom_lite: { enabled: engine === 'headroom_lite' },
    },
  });

  // Canonical compression.* (PR #23). When the user set compression.backend it
  // wins and reconciles the legacy proxy.* alias; otherwise compression.* is
  // forward-derived from the resolved proxy model so it is always populated.
  const { compression, proxyOverride } = deriveCanonicalCompression(merged, userConfig);
  merged = mergeDeep(merged, { compression });
  if (proxyOverride) {
    merged = mergeDeep(merged, { proxy: proxyOverride });
  }

  return merged;
}
