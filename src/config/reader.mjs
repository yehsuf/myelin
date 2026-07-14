import { readFileSync, existsSync } from 'node:fs';
import { load as parse } from 'js-yaml';
import { DEFAULT_CONFIG, mergeDeep, normalizeCompressionEngine } from './schema.mjs';
import { COMPRESSION_BACKENDS } from './compression.mjs';
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
 * selection so downstream consumers that still read `proxy.engine` /
 * `proxy.headroom*` observe the same backend the user chose canonically.
 *
 * Only backend-selection flags are reconciled (engine + per-service `enabled`
 * + compression on/off). Ports and detailed `headroom.*` settings are left
 * untouched so they keep flowing proxy → compression via forward-derivation;
 * this preserves `myelin config set proxy.headroom.port <n>` and keeps the
 * whole derivation idempotent across write/read round-trips.
 */
function proxyAliasFor(backend, compression) {
  const copilotEnabled = compression.copilot_proxy?.enabled === true;
  if (backend === 'disabled') {
    return {
      compression: { enabled: false },
      copilot_headroom: { enabled: copilotEnabled },
    };
  }
  return {
    engine: backend === 'headroom-lite' ? 'headroom_lite' : 'headroom',
    compression: { enabled: true },
    headroom: { enabled: backend === 'headroom-original' },
    headroom_lite: { enabled: backend === 'headroom-lite' },
    copilot_headroom: { enabled: copilotEnabled },
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
    return { compression, proxyOverride: proxyAliasFor(backend, compression) };
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
