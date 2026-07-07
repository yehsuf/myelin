export const DEFAULT_CONFIG = {
  version: '1.0',
  proxy: {
    headroom: {
      enabled: true,
      port: 8787,
      bind: '127.0.0.1',
      backend: 'kompress-base',
      thrash_cache: true,
      diff_enforcer: true,
      corporate_proxy: '',
      openai_target_url: 'https://api.githubcopilot.com',
    },
    mitm: {
      enabled: true,
      port: 8888,
      // block_marker: body substring that confirms a network block page (418 response).
      // Leave empty to treat any 418 as a block (when override_proxy is set).
      block_marker: '',
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
  output_style: { caveman_rules: true, hooks: true },
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
