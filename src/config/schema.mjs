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
    },
  },
  index_tier: 'default',
  code_discovery: {
    serena: { enabled: true, lsp: { typescript: true, python: true, rust: false, go: true } },
    semble: true,
    astgrep: true,
    mcp_git: true,
    cbm_fallback: { enabled: true, mcp_limit_threshold: 3 },
  },
  conversation_memory: { mem0: true },
  shell_compression: { rtk: true },
  output_sandboxing: { srt: true, context_mode: true },
  budget_routing: {
    litellm: false,
    cheap_model: 'claude-haiku-4-5',
    complex_model: 'claude-opus-4-7',
    cheap_threshold: 0.3,
  },
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
  learning: { headroom_learn: true },
  observability: { helicone: false, token_optimizer: true, ai_engineering_coach: true },
  stacklit: { enabled: false },
  semgrep: { enabled: false },
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
