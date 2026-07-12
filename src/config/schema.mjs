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
    // headroom-lite (@yehsuf/headroom-lite): multi-provider, deterministic
    // compression sidecar that replaces the older Python `headroom` on
    // per-provider routes. Runs as a small Node.js server managed by
    // `myelin restart` when `enabled !== false`. Falls back gracefully to a
    // hint if the `headroom-lite` binary isn't installed.
    headroom_lite: {
      enabled: true,
      port: 8790,
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
    //
    // Copilot's real destination stays owned by mitmproxy. The dedicated
    // Headroom instance loops back to mitmproxy's local egress listener; the
    // addon carries/restores the original provider host per request.
    //
    // See docs/copilot-headroom-architecture.md for the full design.
    copilot_headroom: {
      enabled: false,
      port: 8788,
      mode: 'cache',
    },
    // windows_service: controls HOW Windows services are managed.
    // - manager: 'registry' (default, current shipped behavior — unchanged,
    //   zero-risk) starts each process via Start-Process + a
    //   HKCU\...\Run registry key, which persists across logins but does
    //   NOT auto-restart on crash. 'winsw' switches to a real Windows
    //   Service (via WinSW) that auto-restarts on crash/exit — a genuine,
    //   unvalidated-on-real-Windows behavioral change, so it stays opt-in
    //   until a human validates it on a real Windows box. Never flips
    //   automatically; existing installs keep 'registry' forever unless you
    //   explicitly change this.
    // - watchdog_enabled/watchdog_interval_minutes: SECOND-layer Scheduled
    //   Task health checks, meaningful only when manager is 'winsw' (WinSW
    //   itself only restarts on process exit; this catches the "process
    //   still exists but /health is hung" failure mode WinSW can't see).
    //   Ignored when manager is 'registry'; ignored on macOS/Linux.
    windows_service: {
      manager: 'registry',
      watchdog_enabled: false,
      watchdog_interval_minutes: 2,
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
    mcp_git_extra: true,
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
  observability: {
    // token_optimizer: opt-in integration of alexgreensh/token-optimizer
    // (https://github.com/alexgreensh/token-optimizer) — PolyForm
    // Noncommercial License 1.0.0
    // (https://polyformproject.org/licenses/noncommercial/1.0.0). Free for
    // personal/noncommercial/educational/government use; company/commercial
    // use requires a separate license from the author (see the LICENSE file,
    // or contact via the repo). Disabled by default — Myelin always prints
    // this license notice again before performing any install step, even
    // after this flag is enabled, so enabling it here is not silent/implicit
    // consent to the install action itself.
    token_optimizer: false,
  },
  // copilot_hud: opt-in Copilot CLI status-line plugin for live context /
  // token-burn visibility. Disabled by default because setup also requires a
  // one-time interactive `/copilot-hud:setup` run that the installer cannot
  // perform headlessly.
  copilot_hud: { enabled: false },
  copilot: {
    model: 'claude-sonnet-4-6',   // change with: myelin config set copilot.model <model>
  },
  budget_routing: {
    litellm: false,
    litellm_port: 4000,
    api_base: '',
    cheap_model: 'claude-haiku-4-5',
    complex_model: 'claude-sonnet-4-6',
    cheap_threshold: 0.3,
  },
};

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeDeep(base, override) {
  if (!isPlainObject(base)) return override;
  if (!isPlainObject(override)) return override;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    result[key] = isPlainObject(override[key])
      ? mergeDeep(base[key] ?? {}, override[key])
      : override[key];
  }
  return result;
}

export function pruneUnknownKeys(userConfig, schema = DEFAULT_CONFIG) {
  if (!isPlainObject(schema)) return userConfig;
  if (!isPlainObject(userConfig)) return userConfig;

  const result = {};
  for (const key of Object.keys(userConfig)) {
    if (!Object.hasOwn(schema, key)) continue;
    result[key] = (isPlainObject(schema[key]) && isPlainObject(userConfig[key]))
      ? pruneUnknownKeys(userConfig[key], schema[key])
      : userConfig[key];
  }
  return result;
}

function collectLeafPaths(value, prefix) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) return [prefix];
  return Object.entries(value).flatMap(([key, nested]) => collectLeafPaths(nested, `${prefix}.${key}`));
}

export function listUnknownKeyPaths(userConfig, schema = DEFAULT_CONFIG, prefix = '') {
  if (!isPlainObject(userConfig) || !isPlainObject(schema)) return [];

  const staleKeys = [];
  for (const key of Object.keys(userConfig)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(schema, key)) {
      staleKeys.push(...collectLeafPaths(userConfig[key], path));
      continue;
    }
    if (isPlainObject(userConfig[key]) && isPlainObject(schema[key])) {
      staleKeys.push(...listUnknownKeyPaths(userConfig[key], schema[key], path));
    }
  }
  return staleKeys;
}
