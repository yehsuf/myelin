/**
 * Resolve the mitmproxy compression-related environment from config.
 *
 * Pure + side-effect-free so it can be unit-tested without running the
 * installer. Compression is controlled by the schema field
 * `proxy.compression.enabled` (and suppressed when a LiteLLM front-end owns
 * compression). Engine selection does not affect it. It intentionally does NOT
 * key off a top-level
 * `compression.backend` value: that is a legacy/unknown key not present in the
 * schema (`myelin config prune` removes it), and honoring a stale
 * `compression.backend: disabled` would silently turn Copilot compression off
 * against the user's intent. `MYELIN_COMPRESS` is emitted EXPLICITLY ('0'/'1')
 * so a stale value never lingers in the service environment. When compression
 * is disabled the dedicated Copilot-Headroom redirect is suppressed too.
 *
 * @param {object} cfg loaded config
 * @returns {{ compressEnabled: boolean, MYELIN_COMPRESS: '0'|'1', copilotHeadroomPort: number|undefined }}
 */
export function resolveMitmCompression(cfg = {}) {
  const compression = cfg.proxy?.compression ?? {};
  const copilotHeadroomCfg = cfg.proxy?.copilot_headroom ?? {};

  const disabled = compression.enabled === false;

  // LiteLLM front-end owns compression when enabled → the sidecar must not also
  // compress (preserves the existing behavior).
  const litellm = cfg.budget_routing?.litellm === true;

  const compressEnabled = !disabled && !litellm;

  // Copilot proxy requires MITM to be running (needs the loopback egress
  // listener). Suppress it automatically when MITM is disabled so
  // buildEngineInstancePlan never sees a copilot-enabled + MITM-off combo.
  const mitmEnabled = cfg.proxy?.mitm?.enabled !== false;

  const copilotHeadroomPort =
    compressEnabled && copilotHeadroomCfg.enabled && mitmEnabled
      ? (copilotHeadroomCfg.port ?? 8788)
      : undefined;

  return {
    compressEnabled,
    MYELIN_COMPRESS: compressEnabled ? '1' : '0',
    copilotHeadroomPort,
  };
}
