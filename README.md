# Myelin

**The neural insulation layer for AI coding agents.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)]()

> In biology, myelin is the substance that wraps around neurons and makes signals travel 100× faster.  
> This is myelin for your AI coding agent.

**~93% token reduction · 6× longer sessions · 30 min → 3+ hrs · works with Claude Code + GitHub Copilot CLI**

---

## What it does

AI coding agents (Claude Code, GitHub Copilot CLI) burn through context windows in 30 minutes. `cargo test` alone costs 4,823 tokens. `git diff HEAD~1` costs 21,500. Agents re-read their own output every turn — the waste compounds.

Myelin wraps your agent stack with 9 compression layers, each catching what the previous missed:

```
USER PROMPT
    ↓
Serena + Semble         LSP-backed code discovery       →  symbol-precise, no full-file reads
RTK                     Shell output compression         →  60-90% on CLI output
Headroom proxy          Outbound compression layer       →  60-95% before Anthropic/GitHub sees it
mem0                    Conversation memory              →  80-90% reduction on session history
context-mode            Output virtualisation            →  30min → 3+ hour sessions
CacheAligner            KV cache stabilisation           →  90% discount on repeated prefixes
Enforcement hooks       Prevents agent backsliding       →  makes savings stick
    ↓
Anthropic API / GitHub Copilot
```

## Quick Start

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/yehsuf/myelin/main/install.sh | sh

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/yehsuf/myelin/main/install.ps1 | iex"
```

Or clone and run directly:

```bash
git clone https://github.com/yehsuf/myelin.git ~/.tokenstack/repo
cd ~/.tokenstack/repo && npm install
node src/install.mjs --check    # see what's on your machine
node src/install.mjs --dry-run  # preview what would be installed
node src/install.mjs            # install
```

## CLI

```bash
tokenstack verify              # health check all components
tokenstack diagnose            # detect port conflicts, find fixes
tokenstack config show         # view current settings
tokenstack config set proxy.headroom.port 9090
tokenstack update --check      # see what has updates
tokenstack update              # apply all updates
```

## The Stack

| Layer | Tool | Savings |
|-------|------|---------|
| Code discovery (structural) | [Serena](https://github.com/oraios/serena) | Symbol-precise — no full-file reads |
| Code discovery (semantic) | [Semble](https://github.com/MinishLab/semble) | 98% fewer tokens vs grep+read |
| Structural patterns | [ast-grep](https://github.com/ast-grep/ast-grep) | Exact AST matches, not whole files |
| Diff/review context | [mcp-server-git](https://github.com/modelcontextprotocol/servers) | 10× smaller for reviews |
| Conversation memory | [mem0](https://github.com/mem0ai/mem0) | 80-90% vs full history |
| Shell compression | [RTK](https://github.com/rtk-ai/rtk) | 60-90% on CLI output |
| Output sandboxing | [Anthropic SRT](https://github.com/anthropics/sandbox-runtime) | OS-level output control |
| Backbone proxy | [Headroom](https://github.com/yehsuf/headroom) | 60-95% outbound compression |
| Output virtualisation | [context-mode](https://github.com/mksglu/context-mode) | 6× session extension (Claude Code) |
| Model routing | [LiteLLM](https://github.com/BerriAI/litellm) | 30-40% cost reduction (opt-in) |

## Configuration

Config lives at `~/.tokenstack/config.yaml`. Every setting is documented in [`docs/settings-reference.md`](docs/settings-reference.md).

Key settings:

```yaml
proxy:
  headroom:
    port: 8787        # change with: tokenstack config set proxy.headroom.port <N>
    backend: kompress-base  # or: llmlingua-2 (heavier, more compression)

index_tier: default   # light | default | full (controls RAM usage)

budget_routing:
  litellm: false      # set true to route cheap turns to Haiku
```

## Profiles

```bash
node src/install.mjs --profile proxy    # default: full proxy stack
node src/install.mjs --profile mcp      # MCPs only, no proxy daemon
node src/install.mjs --profile minimal  # Serena + RTK only
```

## Corporate / SSL Environments

Myelin auto-detects corporate proxy settings and CA bundles. If auto-detection misses yours:

```bash
export HEADROOM_CA_BUNDLE=/path/to/corporate-ca.pem
export HTTPS_PROXY=http://proxy.corp.example.com:3128
tokenstack config set proxy.headroom.port 9090  # if 8787 is taken
```

## Platforms

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | ✅ Full support | launchd service, Homebrew for RTK |
| Linux | ✅ Full support | systemd user service |
| Windows | ✅ Full support | Task Scheduler, native PowerShell hooks |

## Architecture

See [`docs/specs/2026-07-06-tokenstack-design.md`](docs/specs/2026-07-06-tokenstack-design.md) for the full architecture spec, validated by 3 architects (Claude Opus 4.7, GPT-5.5, Gemini 3.1) + 2 research agents.

## License

MIT — see [LICENSE](LICENSE)
