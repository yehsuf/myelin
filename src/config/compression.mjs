export const COMPRESSION_BACKENDS = Object.freeze([
  'headroom-lite',
  'headroom-original',
  'disabled',
]);

const DEFAULT_PORT = 8787;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reconciles an explicit LEGACY `proxy.copilot_headroom.enabled` toggle into the
 * canonical `compression.copilot_proxy.enabled` value for a raw config that
 * carries a canonical `compression.backend`.
 *
 * Precedence mirrors reader.mjs `proxyAliasFor`'s `ifUnset`: an explicit
 * canonical value always wins; only when the canonical `enabled` is UNSET and
 * the legacy `enabled` is SET does the legacy value flow into the canonical
 * block. Returns the effective boolean, or `undefined` when no reconciliation
 * applies.
 *
 * Shared by config/reader.mjs (the loadConfig path) and
 * update/engine-selection.mjs (the raw-YAML update path that parses the config
 * with js-yaml directly and never runs loadConfig).
 */
export function reconcileCanonicalCopilotEnabled(config = {}) {
  const compression = isObject(config?.compression) ? config.compression : null;
  if (!compression || compression.backend == null) return undefined;
  const canonicalCopilot = isObject(compression.copilot_proxy) ? compression.copilot_proxy : {};
  if (Object.hasOwn(canonicalCopilot, 'enabled')) return undefined;
  const proxy = isObject(config?.proxy) ? config.proxy : {};
  const legacyCopilot = isObject(proxy.copilot_headroom) ? proxy.copilot_headroom : {};
  if (!Object.hasOwn(legacyCopilot, 'enabled')) return undefined;
  return legacyCopilot.enabled === true;
}

function asPort(value, fallback = DEFAULT_PORT) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : fallback;
}

function legacyOriginalSettings(headroom = {}) {
  return {
    mode: headroom.mode ?? 'cache',
    intercept_tool_results: headroom.intercept_tool_results ?? true,
    corporate_proxy: headroom.corporate_proxy ?? '',
    openai_target_url: headroom.openai_target_url ?? 'https://api.githubcopilot.com',
  };
}

function hasLegacyCompressionKeys(proxy = {}) {
  return Object.hasOwn(proxy, 'headroom')
    || Object.hasOwn(proxy, 'headroom_lite')
    || Object.hasOwn(proxy, 'copilot_headroom');
}

const CANONICAL_WINS_WARNING = 'Canonical compression settings were kept; removed legacy proxy.headroom, proxy.headroom_lite, and proxy.copilot_headroom keys.';

export function migrateLegacyCompressionConfig(rawConfig = {}) {
  const proxy = rawConfig.proxy ?? {};
  const hasCanonicalCompression =
    typeof rawConfig.compression === 'object'
    && rawConfig.compression !== null
    && !Array.isArray(rawConfig.compression);
  const hasLegacyCompression = hasLegacyCompressionKeys(proxy);

  if (hasCanonicalCompression && !hasLegacyCompression) {
    return { config: structuredClone(rawConfig), changed: false, warnings: [] };
  }

  if (hasCanonicalCompression) {
    const config = structuredClone(rawConfig);
    config.proxy = { ...(config.proxy ?? {}) };
    delete config.proxy.headroom;
    delete config.proxy.headroom_lite;
    delete config.proxy.copilot_headroom;
    return {
      config,
      changed: true,
      warnings: [CANONICAL_WINS_WARNING],
    };
  }

  if (!hasLegacyCompression) {
    return { config: structuredClone(rawConfig), changed: false, warnings: [] };
  }

  const config = structuredClone(rawConfig);
  const clonedProxy = config.proxy ?? {};
  const original = clonedProxy.headroom ?? {};
  const lite = clonedProxy.headroom_lite ?? {};
  const copilotProxy = clonedProxy.copilot_headroom ?? {};
  const originalConfigured = Object.hasOwn(clonedProxy, 'headroom');
  const liteConfigured = Object.hasOwn(clonedProxy, 'headroom_lite');
  const originalExplicitlyEnabled = original.enabled === true;
  const originalEnabled = originalConfigured && original.enabled !== false;
  const liteEnabled = lite.enabled !== false;
  const warnings = [];

  let backend = 'disabled';
  if (liteConfigured && !liteEnabled && !originalConfigured) {
    backend = 'headroom-original';
  } else if (liteConfigured ? liteEnabled : !originalExplicitlyEnabled && liteEnabled) {
    backend = 'headroom-lite';
  }
  else if (originalEnabled) backend = 'headroom-original';

  if (liteConfigured && originalEnabled && lite.enabled !== false) {
    warnings.push(
      'Both legacy compression backends were enabled; selecting headroom-lite.',
    );
  }

  const port = backend === 'headroom-lite'
    ? asPort(lite.port, asPort(original.port))
    : asPort(original.port);

  config.compression = {
    backend,
    port,
    copilot_proxy: {
      enabled: copilotProxy.enabled === true,
      port: asPort(copilotProxy.port, 8788),
    },
    original: legacyOriginalSettings(original),
  };
  config.proxy = { ...clonedProxy };
  delete config.proxy.headroom;
  delete config.proxy.headroom_lite;
  delete config.proxy.copilot_headroom;

  return { config, changed: true, warnings };
}

export function resolveCompressionConfig(config = {}) {
  const compression = config.compression ?? {};
  const backend = compression.backend ?? 'headroom-lite';
  if (!COMPRESSION_BACKENDS.includes(backend)) {
    throw new Error(`Invalid compression.backend: ${backend}`);
  }

  return {
    backend,
    port: asPort(compression.port),
    copilotProxy: {
      enabled: compression.copilot_proxy?.enabled === true,
      port: asPort(compression.copilot_proxy?.port, 8788),
    },
    original: {
      mode: compression.original?.mode ?? 'cache',
      intercept_tool_results:
        compression.original?.intercept_tool_results ?? true,
      corporate_proxy: compression.original?.corporate_proxy ?? '',
      openai_target_url:
        compression.original?.openai_target_url ??
        'https://api.githubcopilot.com',
    },
  };
}
