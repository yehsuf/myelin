/**
 * Shell wrappers for Copilot CLI and Claude Code.
 *
 * Isolation invariants (do not break):
 *   1. _copilot NEVER sets or leaks any Anthropic-specific env var.
 *   2. _claude  NEVER sets or leaks any Copilot-specific env var.
 *   3. Each wrapper ACTIVELY UNSETS conflicting env vars inherited from the
 *      surrounding shell — even ones the user set manually or picked up from
 *      an unrelated tool — so the launched process only sees what its own
 *      wrapper explicitly grants.
 *
 * Env vars are set per-invocation only and unset/restored immediately after
 * the wrapped process exits, so they cannot leak into sibling commands.
 *
 * This is the sole mechanism for provider env-var isolation. No provider env
 * vars belong in shell $PROFILE, .bashrc/.zshrc, or Windows HKCU\Environment.
 */

const COPILOT_NO_PROXY_HOSTS = [
  // mTLS/CONNECT-incompatible hosts must bypass mitmproxy
  'api.github.com',          // Copilot auth + auto-update
  '*.akamai.com',            // internal Akamai (Jira/Bitbucket/Confluence)
  '*.corp.akamai.com',
  '*.akamaized.net',
  'track.akamai.com',        // some NO_PROXY implementations don't glob — list explicit hosts too
  'git.source.akamai.com',
  'collaborate.akamai.com',
  'registry.npmjs.org',      // MCP server installs
  '*.npmjs.com',
  '*.npmjs.org',
  'repos.akamai.com',
  'localhost',
  '127.0.0.1',
  '::1',
  '*.local',
].join(',');

/**
 * Env vars that must NEVER be visible to Copilot CLI, regardless of what the
 * surrounding shell set. Any of these routes Copilot's Anthropic-compatible
 * SDK calls somewhere other than mitmproxy, silently breaking compression
 * and — worse — sending traffic to unintended endpoints.
 */
export const COPILOT_FORBIDDEN_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ENABLE_PROMPT_CACHING_1H',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
];

/**
 * Env vars that must NEVER be visible to Claude Code, regardless of what
 * the surrounding shell set. Any of these double-routes Claude's outbound
 * calls (Claude → mitmproxy → headroom → …) which is nonsense — Claude
 * already goes direct to headroom via ANTHROPIC_BASE_URL.
 */
export const CLAUDE_FORBIDDEN_ENV = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
];

/**
 * Env vars that must NEVER be visible to our long-running services (main
 * headroom, copilot-headroom, mitmproxy). These are CLIENT-SIDE provider
 * settings that would misdirect the server's own routing or cause
 * proxy-loops if inherited from the shell/session that spawned the service.
 *
 * We do NOT include HTTPS_PROXY here because it is sometimes legitimately
 * set to a corporate proxy chain and mitmproxy consumes it via
 * `--mode upstream:` explicitly.
 */
export const SERVER_FORBIDDEN_ENV = [
  'ANTHROPIC_BASE_URL',            // would confuse headroom's own routing
  'ENABLE_PROMPT_CACHING_1H',      // client-only flag
  'CLAUDE_CODE_SUBAGENT_MODEL',    // client-only
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', // client-only
];

/**
 * Build platform-specific "unset these before starting the service" lines.
 * Ensures a service startup context is clean of client-side env vars,
 * regardless of what the parent shell/session had set.
 *
 *   os === 'windows' → PowerShell `[System.Environment]::SetEnvironmentVariable('X', $null, 'Process')` lines
 *   os === 'linux'   → systemd `UnsetEnvironment=X` directives (systemd 232+)
 *   os === 'darwin'  → POSIX shell `unset X` prefix (used inside `/bin/sh -c` wrappers)
 *
 * Pass a custom `vars` list to override the default SERVER_FORBIDDEN_ENV.
 */
export function buildServiceEnvUnsetLines({ os, vars = SERVER_FORBIDDEN_ENV } = {}) {
  if (os === 'windows') {
    return vars
      .map(k => `[System.Environment]::SetEnvironmentVariable('${k}', $null, 'Process')`)
      .join('\n');
  }
  if (os === 'linux') {
    return vars.map(k => `UnsetEnvironment=${k}`).join('\n');
  }
  // darwin / posix
  return `unset ${vars.join(' ')}`;
}

/**
 * Build the `_copilot` wrapper.
 * - Sets HTTPS_PROXY + NO_PROXY only inside the wrapped `copilot` call.
 * - ACTIVELY UNSETS every var in COPILOT_FORBIDDEN_ENV for that call, even
 *   if the surrounding shell had them set.
 * - Falls back to plain `copilot` (with a warning) if mitmproxy is offline;
 *   forbidden vars remain unset even on the fallback path.
 */
export function buildCopilotWrapper({ os, mitmPort = 8888 } = {}) {
  if (os === 'windows') {
    const savedLines = COPILOT_FORBIDDEN_ENV
      .map(k => `  $saved_${k} = $env:${k}\n  $env:${k} = $null`)
      .join('\n');
    const restoreLines = COPILOT_FORBIDDEN_ENV
      .map(k => `  $env:${k} = $saved_${k}`)
      .join('\n');
    return `# _copilot: routes through Myelin mitmproxy with health-check fallback.
# Actively unsets Claude-provider env vars so a stray ANTHROPIC_BASE_URL in
# the shell can never make Copilot bypass mitmproxy.
function global:_copilot {
${savedLines}
  $probe = Test-NetConnection -ComputerName 127.0.0.1 -Port ${mitmPort} -WarningAction SilentlyContinue -InformationLevel Quiet 2>$null
  if ($probe) {
    $env:HTTPS_PROXY = "http://127.0.0.1:${mitmPort}"
    $env:NO_PROXY = "${COPILOT_NO_PROXY_HOSTS}"
    & copilot @args
    $env:HTTPS_PROXY = $null
    $env:NO_PROXY = $null
  } else {
    Write-Warning "myelin: mitmproxy offline (port ${mitmPort}) - running uncompressed"
    & copilot @args
  }
${restoreLines}
}`;
  }
  const unsetFlags = COPILOT_FORBIDDEN_ENV.map(k => `-u ${k}`).join(' ');
  return `# _copilot routes LLM traffic through Myelin mitmproxy (token compression).
# Actively unsets Claude-provider env vars (via env -u ...) so a stray
# ANTHROPIC_BASE_URL in the shell can never make Copilot bypass mitmproxy.
# Falls back to plain copilot with a warning if mitmproxy is offline.
function _copilot() {
  if nc -z 127.0.0.1 ${mitmPort} 2>/dev/null; then
    env ${unsetFlags} \\
      HTTPS_PROXY=http://127.0.0.1:${mitmPort} \\
      NO_PROXY='${COPILOT_NO_PROXY_HOSTS}' \\
      copilot "$@"
  else
    echo "⚠  myelin: mitmproxy offline (port ${mitmPort}) — running uncompressed" >&2
    env ${unsetFlags} copilot "$@"
  fi
}`;
}

/**
 * Build the `_claude` wrapper.
 * - Sets ANTHROPIC_BASE_URL + ENABLE_PROMPT_CACHING_1H only inside the
 *   wrapped `claude` call.
 * - ACTIVELY UNSETS every var in CLAUDE_FORBIDDEN_ENV for that call, even
 *   if the surrounding shell had HTTPS_PROXY set (would cause double-routing:
 *   claude → mitmproxy → headroom → …).
 * - Falls back to plain `claude` (with a warning) if headroom is offline;
 *   forbidden vars remain unset even on the fallback path.
 *
 * WARNING for maintainers: never set ANTHROPIC_BASE_URL globally (shell
 * $PROFILE, .bashrc, Windows registry) — Anthropic-compatible SDKs used
 * inside Copilot CLI would then be routed to headroom too, bypassing
 * mitmproxy and breaking the MITM pipeline (the July 2026 "418 to
 * api.anthropic.com" regression). Keep it here, per-invocation only.
 */
export function buildClaudeWrapper({ os, headroomPort = 8787 } = {}) {
  if (headroomPort == null) {
    // Compression backend disabled → NO proxy exists. Run Claude Code
    // unproxied and ACTIVELY UNSET ANTHROPIC_BASE_URL/HEADROOM_PORT so a stale
    // value left in the shell/global env by a prior install can never point
    // Claude at a nonexistent proxy port.
    const unsetVars = [...CLAUDE_FORBIDDEN_ENV, 'ANTHROPIC_BASE_URL', 'HEADROOM_PORT'];
    if (os === 'windows') {
      const savedLines = unsetVars
        .map(k => `  $saved_${k} = $env:${k}\n  $env:${k} = $null`)
        .join('\n');
      const restoreLines = unsetVars
        .map(k => `  $env:${k} = $saved_${k}`)
        .join('\n');
      return `# _claude: compression backend disabled — runs Claude Code unproxied.
# Actively unsets ANTHROPIC_BASE_URL/HEADROOM_PORT so a stray global value can
# never point Claude at a nonexistent proxy port.
function global:_claude {
${savedLines}
  & claude @args
${restoreLines}
}`;
    }
    const unsetFlags = unsetVars.map(k => `-u ${k}`).join(' ');
    return `# _claude: compression backend disabled — runs Claude Code unproxied.
# Actively unsets ANTHROPIC_BASE_URL/HEADROOM_PORT (via env -u ...) so a stray
# global value can never point Claude at a nonexistent proxy port.
function _claude() {
  env ${unsetFlags} claude "$@"
}`;
  }
  if (os === 'windows') {
    const savedLines = CLAUDE_FORBIDDEN_ENV
      .map(k => `  $saved_${k} = $env:${k}\n  $env:${k} = $null`)
      .join('\n');
    const restoreLines = CLAUDE_FORBIDDEN_ENV
      .map(k => `  $env:${k} = $saved_${k}`)
      .join('\n');
    return `# _claude: routes Claude Code through Myelin headroom with health-check fallback.
# Actively unsets Copilot-proxy env vars so a stray HTTPS_PROXY in the shell
# can never double-route Claude through mitmproxy on top of headroom.
function global:_claude {
${savedLines}
  $probe = Test-NetConnection -ComputerName 127.0.0.1 -Port ${headroomPort} -WarningAction SilentlyContinue -InformationLevel Quiet 2>$null
  if ($probe) {
    $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:${headroomPort}"
    $env:ENABLE_PROMPT_CACHING_1H = "1"
    & claude @args
    $env:ANTHROPIC_BASE_URL = $null
    $env:ENABLE_PROMPT_CACHING_1H = $null
  } else {
    Write-Warning "myelin: headroom offline (port ${headroomPort}) - running uncompressed"
    & claude @args
  }
${restoreLines}
}`;
  }
  const unsetFlags = CLAUDE_FORBIDDEN_ENV.map(k => `-u ${k}`).join(' ');
  return `# _claude routes Claude Code traffic through Myelin headroom (token compression).
# Actively unsets Copilot-proxy env vars (via env -u ...) so a stray
# HTTPS_PROXY in the shell can never double-route Claude through mitmproxy.
# Falls back to plain claude with a warning if headroom is offline.
function _claude() {
  if nc -z 127.0.0.1 ${headroomPort} 2>/dev/null; then
    env ${unsetFlags} \\
      ANTHROPIC_BASE_URL=http://127.0.0.1:${headroomPort} \\
      ENABLE_PROMPT_CACHING_1H=1 \\
      claude "$@"
  else
    echo "⚠  myelin: headroom offline (port ${headroomPort}) — running uncompressed" >&2
    env ${unsetFlags} claude "$@"
  fi
}`;
}
