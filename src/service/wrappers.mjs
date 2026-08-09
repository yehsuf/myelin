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
 * Env vars that must NEVER reach bare `copilot` — proxy vars that could
 * silently route Copilot CLI through mitmproxy or a corporate proxy chain.
 */
export const COPILOT_CLEAN_ENV = [
  'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy',
];

/**
 * Env vars that must NEVER reach bare `claude` — provider routing vars that
 * could silently redirect Claude Code to headroom or a stale proxy endpoint.
 */
export const CLAUDE_CLEAN_ENV = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'ENABLE_PROMPT_CACHING_1H', 'HEADROOM_PORT',
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
export function buildCopilotWrapper({ os, mitmPort = 8888, copilotBin = 'copilot' } = {}) {
  if (os === 'windows') {
    // On Windows, copilotBin may be an absolute path with backslashes. PowerShell
    // call operator (&) accepts both quoted strings and bare names, so we always
    // quote it to handle spaces in paths correctly.
    const psCall = copilotBin === 'copilot' ? '& copilot @args' : `& "${copilotBin}" @args`;
    const savedLines = COPILOT_FORBIDDEN_ENV
      .map(k => `  $saved_${k} = $env:${k}\n  $env:${k} = $null`)
      .join('\n');
    const restoreLines = COPILOT_FORBIDDEN_ENV
      .map(k => `  $env:${k} = $saved_${k}`)
      .join('\n');
    // Call the binary directly (by Application type) so that if the user's
    // profile also defines a bare `copilot` clean wrapper, _copilot never
    // recurses into it — functions take precedence over binaries in PowerShell.
    // If copilotBin was resolved to something other than bare 'copilot' (POSIX
    // callers may pass a brew/absolute path; Windows currently never does),
    // call that explicit path instead of re-resolving via Get-Command.
    const psCallBin = copilotBin === 'copilot'
      ? '& (Get-Command copilot -Type Application -ErrorAction Stop).Source @args'
      : psCall;
    return `# _copilot: routes through Myelin mitmproxy with health-check fallback.
# Actively unsets Claude-provider env vars so a stray ANTHROPIC_BASE_URL in
# the shell can never make Copilot bypass mitmproxy.
# Calls the copilot binary directly (Type Application) to avoid recursing into
# the bare 'copilot' clean wrapper when both are defined in the same profile.
function global:_copilot {
${savedLines}
  $probe = Test-NetConnection -ComputerName 127.0.0.1 -Port ${mitmPort} -WarningAction SilentlyContinue -InformationLevel Quiet 2>$null
  if ($probe) {
    $env:HTTPS_PROXY = "http://127.0.0.1:${mitmPort}"
    $env:NO_PROXY = "${COPILOT_NO_PROXY_HOSTS}"
    ${psCallBin}
    $env:HTTPS_PROXY = $null
    $env:NO_PROXY = $null
  } else {
    Write-Warning "myelin: mitmproxy offline (port ${mitmPort}) - running uncompressed"
    ${psCallBin}
  }
${restoreLines}
}`;
  }
  const unsetFlags = COPILOT_FORBIDDEN_ENV.map(k => `-u ${k}`).join(' ');
  // -u MallocStackLogging: completely remove from env (not set to 0 — that enables
  // a "lite" mode that fails with "could not tag MSL-related memory as no_footprint").
  // Unsetting means macOS never starts the logging machinery at all, but triggers a
  // harmless "can't turn off stack logging because it was not enabled" stderr line from
  // Node.js native addons that call turn_off_stack_logging() unconditionally. Filter
  // those lines with a stderr passthrough so they never reach the user's terminal.
  const mallocFlag = '-u MallocStackLogging';
  // Embed the resolved binary path. Single-quote for POSIX safety — prevents
  // $VAR / backtick expansion if the path somehow contains special chars.
  // Embedded single quotes are escaped via the 'foo'"'"'bar' idiom.
  const posixCmd = copilotBin.includes(' ') || copilotBin.includes("'") || copilotBin !== 'copilot'
    ? "'" + copilotBin.replace(/'/g, "'\\''") + "'"
    : copilotBin;
  return `# _copilot routes LLM traffic through Myelin mitmproxy (token compression).
# Actively unsets Claude-provider env vars (via env -u ...) so a stray
# ANTHROPIC_BASE_URL in the shell can never make Copilot bypass mitmproxy.
# Falls back to plain copilot with a warning if mitmproxy is offline.
function _copilot() {
  # osc52d: start clipboard daemon so compact-prepare can reach the real tty
  # via OSC 52 even from within the captured AI subprocess context.
  local _osc52_pid="" _osc52_sock="/tmp/osc52d-$(id -u).sock"
  local _osc52_bin="\${HOME}/.myelin/current/src/bin/osc52d.py"
  if command -v python3 >/dev/null 2>&1 && [ -f "$_osc52_bin" ] && ! [ -S "$_osc52_sock" ]; then
    OSC52_SOCKET="$_osc52_sock" python3 "$_osc52_bin" &
    _osc52_pid=$!
    local _i=0
    while [ "$_i" -lt 20 ] && ! [ -S "$_osc52_sock" ]; do sleep 0.05; _i=$((_i+1)); done
  fi
  local _osc52_env=""; [ -S "$_osc52_sock" ] && _osc52_env="OSC52_SOCKET=$_osc52_sock"
  if nc -z 127.0.0.1 ${mitmPort} 2>/dev/null; then
    env ${unsetFlags} ${mallocFlag} \\
      HTTPS_PROXY=http://127.0.0.1:${mitmPort} \\
      NO_PROXY='${COPILOT_NO_PROXY_HOSTS}' \\
      $_osc52_env \\
      ${posixCmd} "$@" 2> >(grep -Fv 'MallocStackLogging:' >&2)
  else
    echo "⚠  myelin: mitmproxy offline (port ${mitmPort}) — running uncompressed" >&2
    env ${unsetFlags} ${mallocFlag} $_osc52_env ${posixCmd} "$@" 2> >(grep -Fv 'MallocStackLogging:' >&2)
  fi
  [ -n "$_osc52_pid" ] && { kill "$_osc52_pid" 2>/dev/null; rm -f "$_osc52_sock" 2>/dev/null; }
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
 * WARNING: Do NOT set ANTHROPIC_FOUNDRY_BASE_URL here. Claude Code passes
 * all process env vars to child processes including MCP servers. MCP servers
 * (e.g. akamai-tools) create their own Foundry clients and fail with
 * "Must provide baseURL or resource" if ANTHROPIC_FOUNDRY_BASE_URL is a
 * localhost URL. Standard Anthropic routing uses ANTHROPIC_BASE_URL only.
 */
export function buildClaudeWrapper({ os, headroomPort = 8787 } = {}) {
  if (headroomPort == null) {
    // Compression backend disabled → NO proxy exists. Run Claude Code
    // unproxied and ACTIVELY UNSET ANTHROPIC_BASE_URL/HEADROOM_PORT
    // so a stale value left in the shell/global env by a prior install can never
    // point Claude at a nonexistent proxy port.
    const unsetVars = [...CLAUDE_FORBIDDEN_ENV, 'ANTHROPIC_BASE_URL', 'HEADROOM_PORT'];
    if (os === 'windows') {
      const savedLines = unsetVars
        .map(k => `  $saved_${k} = $env:${k}\n  $env:${k} = $null`)
        .join('\n');
      const restoreLines = unsetVars
        .map(k => `  $env:${k} = $saved_${k}`)
        .join('\n');
    // Call the binary directly to avoid recursing into the bare 'claude' clean wrapper.
    const psClaudeBin = `(Get-Command claude -Type Application -ErrorAction Stop).Source`;
    return `# _claude: compression backend disabled — runs Claude Code unproxied.
# Actively unsets ANTHROPIC_BASE_URL/HEADROOM_PORT so a stray
# global value can never point Claude at a nonexistent proxy port.
function global:_claude {
${savedLines}
  & ${psClaudeBin} @args
${restoreLines}
}`;
    }
    const unsetFlags = unsetVars.map(k => `-u ${k}`).join(' ');
    return `# _claude: compression backend disabled — runs Claude Code unproxied.
# Actively unsets ANTHROPIC_BASE_URL/HEADROOM_PORT (via env -u ...)
# so a stray global value can never point Claude at a nonexistent proxy port.
function _claude() {
  env ${unsetFlags} -u MallocStackLogging claude "$@"
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
# Detects Foundry mode to avoid setting conflicting provider vars — never set
# both ANTHROPIC_BASE_URL and ANTHROPIC_FOUNDRY_BASE_URL simultaneously.
# Calls the claude binary directly (Type Application) to avoid recursing into
# the bare 'claude' clean wrapper when both are defined in the same profile.
function global:_claude {
${savedLines}
  $_claudeBin = (Get-Command claude -Type Application -ErrorAction Stop).Source
  $probe = Test-NetConnection -ComputerName 127.0.0.1 -Port ${headroomPort} -WarningAction SilentlyContinue -InformationLevel Quiet 2>$null
  if ($probe) {
    if ($env:CLAUDE_CODE_USE_FOUNDRY -eq '1') {
      $env:ANTHROPIC_FOUNDRY_BASE_URL = "http://127.0.0.1:${headroomPort}"
      $env:ENABLE_PROMPT_CACHING_1H = "1"
      $env:ANTHROPIC_BASE_URL = $null
      & $_claudeBin @args
      $env:ANTHROPIC_FOUNDRY_BASE_URL = $null
      $env:ENABLE_PROMPT_CACHING_1H = $null
    } else {
      $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:${headroomPort}"
      $env:ENABLE_PROMPT_CACHING_1H = "1"
      & $_claudeBin @args
      $env:ANTHROPIC_BASE_URL = $null
      $env:ENABLE_PROMPT_CACHING_1H = $null
    }
  } else {
    Write-Warning "myelin: headroom offline (port ${headroomPort}) - running uncompressed"
    & $_claudeBin @args
  }
${restoreLines}
}`;
  }
  const unsetFlags = CLAUDE_FORBIDDEN_ENV.map(k => `-u ${k}`).join(' ');
  const mallocFlag = '-u MallocStackLogging';
  return `# _claude routes Claude Code traffic through Myelin headroom (token compression).
# Actively unsets Copilot-proxy env vars (via env -u ...) so a stray
# HTTPS_PROXY in the shell can never double-route Claude through mitmproxy.
# Detects Foundry mode at runtime to avoid setting conflicting provider env
# vars — ANTHROPIC_BASE_URL and ANTHROPIC_FOUNDRY_BASE_URL must never both be
# set or the MCP child SDK resolver enters a split-brain state.
# Falls back to plain claude with a warning if headroom is offline.
function _claude() {
  # osc52d: start clipboard daemon so compact-prepare can reach the real tty
  # via OSC 52 even from within the captured AI subprocess context.
  local _osc52_pid="" _osc52_sock="/tmp/osc52d-$(id -u).sock"
  local _osc52_bin="\${HOME}/.myelin/current/src/bin/osc52d.py"
  if command -v python3 >/dev/null 2>&1 && [ -f "$_osc52_bin" ] && ! [ -S "$_osc52_sock" ]; then
    OSC52_SOCKET="$_osc52_sock" python3 "$_osc52_bin" &
    _osc52_pid=$!
    local _i=0
    while [ "$_i" -lt 20 ] && ! [ -S "$_osc52_sock" ]; do sleep 0.05; _i=$((_i+1)); done
  fi
  local _osc52_env=""; [ -S "$_osc52_sock" ] && _osc52_env="OSC52_SOCKET=$_osc52_sock"
  if nc -z 127.0.0.1 ${headroomPort} 2>/dev/null; then
    if [ "\${CLAUDE_CODE_USE_FOUNDRY:-}" = "1" ]; then
      # Foundry mode: set ONLY ANTHROPIC_FOUNDRY_BASE_URL — never set both vars
      # simultaneously or the Foundry SDK in spawned MCP servers breaks.
      env ${unsetFlags} ${mallocFlag} -u ANTHROPIC_BASE_URL \\
        ANTHROPIC_FOUNDRY_BASE_URL=http://127.0.0.1:${headroomPort} \\
        ENABLE_PROMPT_CACHING_1H=1 \\
        $_osc52_env \\
        claude "$@"
    else
      # Standard Anthropic API mode.
      env ${unsetFlags} ${mallocFlag} \\
        ANTHROPIC_BASE_URL=http://127.0.0.1:${headroomPort} \\
        ENABLE_PROMPT_CACHING_1H=1 \\
        $_osc52_env \\
        claude "$@"
    fi
  else
    echo "⚠  myelin: headroom offline (port ${headroomPort}) — running uncompressed" >&2
    env ${unsetFlags} ${mallocFlag} $_osc52_env claude "$@"
  fi
  [ -n "$_osc52_pid" ] && { kill "$_osc52_pid" 2>/dev/null; rm -f "$_osc52_sock" 2>/dev/null; }
}`;
}

/**
 * Build a bare `copilot` wrapper that guarantees HTTPS_PROXY and all proxy
 * vars are NEVER visible to Copilot CLI, regardless of what the surrounding
 * shell or SSH session has set. This is the defensive complement to
 * `_copilot`: use `copilot` for auth/plugins/config, `_copilot` for AI calls.
 *
 * On Windows the function calls the binary via Get-Command -Type Application
 * to bypass PowerShell function lookup (prevents self-recursion).
 * On POSIX, `type -P` skips function lookup and finds the PATH binary.
 */
export function buildBareCopilotWrapper({ os } = {}) {
  const proxyVars = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy'];
  if (os === 'windows') {
    const saveLines = proxyVars.map(k => `  $p_${k.replace(/[^a-zA-Z]/g, '_')} = $env:${k}; $env:${k} = $null`).join('\n');
    const restoreLines = proxyVars.map(k => `  $env:${k} = $p_${k.replace(/[^a-zA-Z]/g, '_')}`).join('\n');
    return `# copilot: proxy-clean wrapper — strips HTTPS_PROXY/HTTP_PROXY so bare
# 'copilot' never routes through mitmproxy regardless of session env.
# Use _copilot for AI calls (compression), copilot for auth/plugins/updates.
function global:copilot {
${saveLines}
  & (Get-Command copilot -Type Application -ErrorAction Stop).Source @args
${restoreLines}
}`;
  }
  const unsetFlags = proxyVars.map(k => `-u ${k}`).join(' ');
  return `# copilot: proxy-clean wrapper — strips HTTPS_PROXY/HTTP_PROXY so bare
# 'copilot' never routes through mitmproxy regardless of session env.
# Use _copilot for AI calls (compression), copilot for auth/plugins/updates.
# type -P finds the binary in PATH, skipping this function definition.
function copilot() {
  env ${unsetFlags} -u MallocStackLogging \\
    "\$(type -P copilot)" "\$@" 2> >(grep -Fv 'MallocStackLogging:' >&2)
}`;
}

/**
 * Build a bare `claude` wrapper that guarantees ANTHROPIC_BASE_URL and
 * headroom routing vars are NEVER visible to bare Claude CLI. Prevents
 * accidental routing through headroom when the user runs `claude` directly
 * (e.g. for auth, config, or one-off queries without compression).
 */
export function buildBareClaudeWrapper({ os } = {}) {
  const claudeVars = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ENABLE_PROMPT_CACHING_1H', 'HEADROOM_PORT'];
  if (os === 'windows') {
    const saveLines = claudeVars.map(k => `  $c_${k.replace(/[^a-zA-Z]/g, '_')} = $env:${k}; $env:${k} = $null`).join('\n');
    const restoreLines = claudeVars.map(k => `  $env:${k} = $c_${k.replace(/[^a-zA-Z]/g, '_')}`).join('\n');
    return `# claude: provider-clean wrapper — strips ANTHROPIC_BASE_URL/headroom vars
# so bare 'claude' never routes through headroom regardless of session env.
# Use _claude for compressed AI calls, claude for auth/config/one-off use.
function global:claude {
${saveLines}
  & (Get-Command claude -Type Application -ErrorAction Stop).Source @args
${restoreLines}
}`;
  }
  const unsetFlags = claudeVars.map(k => `-u ${k}`).join(' ');
  return `# claude: provider-clean wrapper — strips ANTHROPIC_BASE_URL/headroom vars
# so bare 'claude' never routes through headroom regardless of session env.
# Use _claude for compressed AI calls, claude for auth/config/one-off use.
# type -P finds the binary in PATH, skipping this function definition.
function claude() {
  env ${unsetFlags} -u MallocStackLogging \\
    "\$(type -P claude)" "\$@" 2> >(grep -Fv 'MallocStackLogging:' >&2)
}`;
}
