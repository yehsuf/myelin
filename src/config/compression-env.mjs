/**
 * Resolve the mitmproxy compression-related environment from config.
 *
 * Pure + side-effect-free so it can be unit-tested without running the
 * installer. Honors the user's intent to disable compression (the top-level
 * legacy `compression.backend: disabled`, the migrated
 * `proxy.headroom.backend: disabled`, or `proxy.headroom.enabled: false`) and
 * ensures MYELIN_COMPRESS is emitted EXPLICITLY ('0' or '1') so a stale value
 * never lingers in the service environment. When compression is disabled the
 * dedicated Copilot-Headroom redirect is suppressed too (it would otherwise run
 * the full pipeline despite "disabled").
 *
 * @param {object} cfg loaded config
 * @returns {{ compressEnabled: boolean, MYELIN_COMPRESS: '0'|'1', copilotHeadroomPort: number|undefined }}
 */
export function resolveMitmCompression(cfg = {}) {
  const headroom = cfg.proxy?.headroom ?? {};
  const copilotHeadroomCfg = cfg.proxy?.copilot_headroom ?? {};

  const disabled =
    cfg.compression?.backend === 'disabled' ||
    headroom.backend === 'disabled' ||
    headroom.enabled === false;

  // LiteLLM front-end owns compression when enabled → the sidecar must not also
  // compress (preserves the existing behavior).
  const litellm = cfg.budget_routing?.litellm === true;

  const compressEnabled = !disabled && !litellm;

  const copilotHeadroomPort =
    compressEnabled && copilotHeadroomCfg.enabled
      ? (copilotHeadroomCfg.port ?? 8788)
      : undefined;

  return {
    compressEnabled,
    MYELIN_COMPRESS: compressEnabled ? '1' : '0',
    copilotHeadroomPort,
  };
}
