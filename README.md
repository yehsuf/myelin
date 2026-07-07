# Myelin

**The neural insulation layer for AI coding agents.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)]()

> In biology, myelin is the substance that wraps around neurons and makes signals travel 100× faster.  
> This is myelin for your AI coding agent.

**~14-72% Copilot token reduction · 91% fewer tools per request · KV cache 69%+ hit rate · works with Claude Code + GitHub Copilot CLI**

---

## What it does

AI coding agents burn through context in 30 minutes. Myelin wraps your agent stack with compression layers:

```
USER PROMPT
    ↓
Serena + Semble    LSP-backed code discovery     →  symbol-precise, no full-file reads
RTK                Shell output compression       →  60-90% on CLI output
mitmproxy addon    Tool filter + compress         →  91% fewer tools, 14-72% byte reduction
Headroom proxy     Outbound compression + cache   →  69%+ KV cache hit rate, cost savings
Enforcement hooks  Prevents agent backsliding     →  makes savings stick
    ↓
Anthropic API / GitHub Copilot API
```

---

## Prerequisites

### macOS
```bash
# Homebrew (required)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js 20+
brew install node

# Python 3.10+ (for mitmproxy/headroom — usually pre-installed on macOS 13+)
python3 --version
```

### Linux (Ubuntu/Debian)
```bash
# Node.js 20+ via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc
nvm install 20 && nvm use 20

# Python 3.10+ (usually pre-installed)
python3 --version

# mitmproxy
pip3 install --user mitmproxy
# Add to PATH if not already:
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

### Windows (PowerShell — run as Administrator once for winget)
```powershell
# 1. Install prerequisites (one-time, as Administrator)
winget install Git.Git OpenJS.NodeJS.LTS Python.Python.3.12

# Restart PowerShell after winget installs, then:

# 2. Install mitmproxy
pip install mitmproxy
# Verify: mitmdump --version

# 3. Clone and install Myelin
git clone https://github.com/yehsuf/myelin.git "$env:USERPROFILE\.tokenstack\repo"
cd "$env:USERPROFILE\.tokenstack\repo"
npm install
node src/install.mjs --yes

# 4. Reload profile (or restart PowerShell)
. $PROFILE
```

What the installer does on Windows:
- Registers **headroom** as a Scheduled Task (`TokenstackHeadroom`) — starts at logon, restarts on failure
- Registers **mitmproxy** as a Scheduled Task (`MyelinMitmproxy`) — starts at logon
- Writes `$env:ANTHROPIC_BASE_URL`, `$env:HEADROOM_PORT`, CA bundle env vars to `~\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`
- Adds `_copilot` PowerShell function (health-checks :8888, falls back gracefully)
- Adds `myelin` function pointing to the CLI

After install, in any new PowerShell window:
```powershell
myelin verify          # health check
_copilot               # Copilot CLI through mitmproxy (compressed)
copilot                # Copilot CLI direct (uncompressed)
claude                 # Claude Code through headroom (compressed)
```

---

## Install

### macOS / Linux
```bash
git clone https://github.com/yehsuf/myelin.git ~/.tokenstack/repo
cd ~/.tokenstack/repo
npm install
node src/install.mjs --yes
source ~/.zshrc        # macOS (zsh)
# or:
source ~/.bashrc       # Linux (bash)
```

### Windows (PowerShell)
```powershell
git clone https://github.com/yehsuf/myelin.git "$env:USERPROFILE\.tokenstack\repo"
cd "$env:USERPROFILE\.tokenstack\repo"
npm install
node src/install.mjs --yes
. $PROFILE    # reload profile in current window
```

---

## Verify

```bash
myelin verify          # health check all 7 components
myelin stats           # compression statistics
myelin config show     # view current settings
```

Expected output:
```
✓ headroom proxy    :8787  healthy
✓ mitmproxy         :8888  healthy
✓ serena            MCP    ready
✓ semble            MCP    ready
✓ rtk               shell  ready
✓ enforcement hooks        active
✓ shell profile            configured
```

---

## Usage

### Claude Code (automatic)
```bash
claude   # ANTHROPIC_BASE_URL automatically points to headroom :8787
```
Headroom compresses messages before forwarding to Anthropic. KV cache alignment reduces costs by up to $1+/day.

### GitHub Copilot CLI (compressed)
```bash
_copilot   # routes through mitmproxy :8888 — compresses + filters tools
copilot    # direct, uncompressed (still works if mitmproxy is down)
```
`_copilot` health-checks port 8888 first — falls back to plain `copilot` with a warning if mitmproxy is offline.

---

## What gets compressed

| Layer | Before | After | Saving |
|-------|--------|-------|--------|
| Tools per request (Copilot) | ~125 tools | ~11 tools | **91%** |
| Bytes per request (Copilot) | baseline | -14 to -72% | **14-72%** |
| KV cache hit rate (Claude) | ~0% cold | ~69% | **69%+ token discount** |
| Text compression (Claude) | baseline | -3.5% additional | small |

---

## Platform feature parity

| Feature | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Installer | ✅ | ✅ | ✅ (untested) |
| Claude Code via headroom | ✅ | ✅ | ✅ (untested) |
| Copilot via mitmproxy | ✅ | ✅ | ✅ (untested) |
| CA generation (no sudo) | ✅ keychain | ✅ ca-bundle.pem | ✅ certutil |
| Background service | ✅ launchd | ✅ systemd user | ✅ Task Scheduler |
| Shell reload (auto) | ✅ AppleScript | ⚠️ run manually | ⚠️ restart shell |
| `myelin stats` | ✅ | ✅ | ✅ |
| `_copilot` health fallback | ✅ | ✅ | ✅ |

---

## Configuration

Config: `~/.tokenstack/config.yaml`

```yaml
proxy:
  headroom:
    port: 8787          # change: myelin config set proxy.headroom.port 9090
    backend: kompress-base   # or: llmlingua-2
  mitm:
    port: 8888
    block_bypass: false      # set true if behind content filter (NetFree etc.)
    override_proxy: ''       # socks5://10.8.0.1:1080

index_tier: default     # light | default | full
```

### Corporate / SSL environments
Myelin auto-detects corporate proxies and CA bundles. If it misses yours:
```bash
export HTTPS_PROXY=http://proxy.corp.example.com:3128
export HEADROOM_CA_BUNDLE=/path/to/corporate-ca.pem
```

### Block bypass (NetFree / content filters)
```bash
myelin config set proxy.mitm.block_bypass true
myelin config set proxy.mitm.override_proxy socks5://10.8.0.1:1080
node ~/.tokenstack/repo/src/install.mjs --yes   # re-registers service
```

---

## Profiles

```bash
node src/install.mjs --profile proxy    # default: full proxy + MCPs
node src/install.mjs --profile mcp      # MCPs only, no proxy daemon
node src/install.mjs --profile minimal  # Serena + RTK only
```

---

## Update

```bash
cd ~/.tokenstack/repo
git fetch origin && git reset --hard origin/main
npm install
node src/install.mjs --yes
```

---

## Uninstall

```bash
# macOS
launchctl bootout gui/$(id -u)/com.myelin.mitmproxy 2>/dev/null
launchctl bootout gui/$(id -u)/com.tokenstack.headroom 2>/dev/null
rm ~/Library/LaunchAgents/com.myelin.mitmproxy.plist
rm ~/Library/LaunchAgents/com.tokenstack.headroom.plist

# Linux
systemctl --user disable --now myelin-mitmproxy.service tokenstack-headroom.service
rm ~/.config/systemd/user/myelin-mitmproxy.service ~/.config/systemd/user/tokenstack-headroom.service
systemctl --user daemon-reload

# Windows
Unregister-ScheduledTask -TaskName "MyelinMitmproxy" -Confirm:$false
Unregister-ScheduledTask -TaskName "TokenstackHeadroom" -Confirm:$false
# Edit ~/.zshrc (macOS) or ~/.bashrc (Linux) and remove the
# '# >>> myelin managed >>>' ... '# <<< myelin managed <<<' block
rm -rf ~/.tokenstack
```

---

## Architecture

See [`docs/specs/2026-07-06-tokenstack-design.md`](docs/specs/2026-07-06-tokenstack-design.md) for the full architecture spec.

## License

MIT — see [LICENSE](LICENSE)

