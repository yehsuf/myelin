export const DEFAULT_CONFIG = {
  version: '1.0',
  proxy: {
    headroom: {
      enabled: true,
      port: 8787,
      bind: '127.0.0.1',
      backend: 'kompress-base',
      // cache: freeze prior turns to maximise provider prompt-cache hit rate.
      // token: recompress prior turns for max text compression (default in
      // headroom itself, but measurably worse for Anthropic — cache reads are
      // ~0.1x cost and writes ~1.25-2x, so recompressing to save a few % text
      // loses to caching within 2-3 reused turns). See docs/specs.
      mode: 'cache',
      // ast-grep-based outlining of large Read/tool-result payloads before
      // they enter the prompt. Off by default in headroom itself ("while
      // this feature ships") — we opt in since it has no cache-stability
      // downside (outlined content is new, gets cached once) and 35-55%
      // measured savings on large-repo reads.
      intercept_tool_results: true,
      thrash_cache: true,
      diff_enforcer: true,
      corporate_proxy: '',
      openai_target_url: 'https://api.githubcopilot.com',
    },
    mitm: {
      enabled: true,
      port: 8888,
      // block_bypass: set true to enable 418 block detection + override proxy retry.
      // Requires override_proxy to be set.
      block_bypass: false,
      // block_marker: case-insensitive text that must appear in a 418 response body
      // to confirm it is a network filter block page (not a legitimate API 418).
      // Default 'netfree' matches all NetFree block pages regardless of format.
      // Set to '' to treat any 418 as a block.
      block_marker: 'netfree',
      // override_proxy: SOCKS5 or HTTP proxy to route blocked requests through.
      // Format: socks5://host:port  or  http://host:port
      // When set, any 418 block page causes the request to be replayed via this proxy.
      // No domain file, no polling — mitmproxy switches the upstream transport per-flow.
      override_proxy: '',
      // vpn_domains_file: legacy fallback if override_proxy is not set.
      vpn_domains_file: '',
      // extra_providers: JSON object extending the built-in provider map.
      extra_providers: '',
      // egress_port: second listener on the same mitmproxy process, used only
      // when copilot_headroom.enabled is true. This is the leg that owns real
      // network egress for the dedicated Copilot-Headroom instance's own
      // outbound calls (block-bypass/CA/corp-upstream logic applies here too —
      // never on the loopback redirect leg, which can't be network-blocked).
      egress_port: 8889,
    },
    // copilot_headroom: a SEPARATE, dedicated Headroom instance (distinct from
    // proxy.headroom above, which serves Claude Code) that gives Copilot CLI
    // traffic the same full pipeline treatment (cache-mode, content_router,
    // TOIN, stats) instead of the stateless /v1/compress-only sidecar call.
    // Disabled by default — opt-in until validated on your own install.
    // See docs/copilot-headroom-architecture.md for the full
    // design: mitmproxy redirects /v1/messages and /chat/completions to this
    // instance's loopback port; its own outbound call tunnels back out
    // through proxy.mitm.egress_port so mitmproxy remains the sole owner of
    // real network egress (NetFree bypass, corp CA, etc.).
    copilot_headroom: {
      enabled: false,
      port: 8788,
      mode: 'cache',
      // anthropic/openai_target_url: Copilot's real API host. Use
      // api.business.githubcopilot.com for Business/Enterprise accounts,
      // api.githubcopilot.com for individual accounts.
      anthropic_target_url: 'https://api.business.githubcopilot.com',
      openai_target_url: 'https://api.business.githubcopilot.com',
    },
  },
  index_tier: 'default',
  code_discovery: {
    serena: {
      enabled: true,
      lsp: {
        typescript: true,
        python: true,
        // rust-analyzer/Serena LSP integration not yet validated in this setup — flip to true after confirming rust-analyzer is installed and Serena resolves rust symbols for your project
        rust: false,
        go: true,
      },
    },
    semble: true,
    astgrep: true,
    // codegraph: function-level dependency graph MCP/CLI (callers, callees,
    // impact) built per-repo via `myelin init`. Defaults OFF for now: this is
    // a brand-new Myelin integration, and upstream currently requires a newer
    // Node than Myelin itself (README badge: >=22.6; package.json: >=22.12.0
    // vs Myelin's own >=20). Opt in after validating it on your own repos.
    codegraph: false,
    mcp_git: true,
    cbm_fallback: { enabled: true, mcp_limit_threshold: 3 },
  },
  shell_compression: { rtk: true },
  native_compression: {
    // cross_turn_dedup: myelin-native (non-Headroom) cross-turn verbatim folding
    // that replaces later repeated spans with absolute earlier-turn pointers.
    cross_turn_dedup: true,
    // adaptive_sizer: myelin-native (non-Headroom) Kneedle-based sizing helper
    // that chooses saturation-aware truncation lengths instead of fixed top-N caps.
    adaptive_sizer: true,
    // lossless_compaction: myelin-native (non-Headroom) reversible grep/log/diff
    // compaction with runtime round-trip checks and safe fallback to original bytes.
    lossless_compaction: true,
  },
  output_sandboxing: { context_mode: true },
  output_style: {
    caveman_rules: true,
    hooks: true,
    code_navigation: true,
    // token_efficiency: injects a "Token efficiency" instruction block
    // (top-priority placement) into the managed section of both
    // ~/.claude/CLAUDE.md (global) and repo-level AGENTS.md. See
    // src/config/instruction-snippets.mjs for scoping (global/repo,
    // provider, model) and placement rules.
    token_efficiency: true,
  },
  // copilot_hud: opt-in Copilot CLI status-line plugin for live context /
  // token-burn visibility. Disabled by default because setup also requires a
  // one-time interactive `/copilot-hud:setup` run that the installer cannot
  // perform headlessly.
  copilot_hud: { enabled: false },
  copilot: {
    model: 'claude-sonnet-4-6',   // change with: myelin config set copilot.model <model>
  },
};

export function mergeDeep(base, override) {
  if (typeof base !== 'object' || base === null) return override;
  if (typeof override !== 'object' || override === null) return override;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    result[key] = (typeof override[key] === 'object' && !Array.isArray(override[key]) && override[key] !== null)
      ? mergeDeep(base[key] ?? {}, override[key])
      : override[key];
  }
  return result;
}
