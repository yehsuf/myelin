# TokenStack — Token-Efficient AI Workspace Design Spec

**Date:** 2026-07-06  
**Status:** Approved for implementation  
**Targets:** Claude Code + GitHub Copilot CLI  
**Platforms:** macOS · Linux · Windows  
**Validated by:** 3 Architects (Opus 4.7, GPT-5.5, Gemini 3.1) + 2 Research agents

---

## 1. Problem Statement

AI coding agents (Claude Code, GitHub Copilot CLI) consume context windows rapidly:
- `cargo test` (262 tests) = 4,823 tokens raw
- `git diff HEAD~1` = 21,500 tokens raw
- Reading a 500-line file fills context fast
- Agents re-read their own output every turn (compounds 6×)

Without intervention, a 200K context window is exhausted in ~30 minutes. Cost on Opus 4.7 with no optimisation: ~$54/hr.

**Goal:** Reduce token consumption by ~93% and extend sessions from 30min to 3-6hrs using a layered, cross-platform, easily maintainable stack — "TokenStack."

---

## 2. Architecture Overview

```
USER PROMPT
    │
    ▼ ── Layer 0: Session Prep (ad hoc CLI helpers) ────────────────
    │  repomix --include "$(git diff --name-only)"   [diff bundles]
    │  Priompt                                        [CLAUDE.md priority-drop]
    │
    ▼ ── Layer 1: Code Discovery (MCP servers, both CLIs) ──────────
    │  serena_*   Serena        LSP structural nav   → symbol-precise lookups
    │  semble_*   Semble        semantic vector      → 98% vs grep+read
    │  astgrep_*  ast-grep MCP  structural patterns  → exact AST matches
    │  git_*      mcp-server-git git diff/show       → 10× smaller for reviews
    │
    ▼ ── Layer 2: Conversation Memory (MCP, both CLIs) ─────────────
    │  mem0_*     mem0          extract facts        → 80-90% vs full history
    │
    ▼ ── Layer 3: Shell Compression (both CLIs) ────────────────────
    │  RTK (bundled in headroom)                     → 60-90% CLI output
    │
    ▼ ── Layer 4: Output Sandboxing ────────────────────────────────
    │  Anthropic SRT  OS-level sandbox     Mac + Linux  [found locally]
    │  context-mode   BM25 virtualisation  Claude Code only → 6× sessions
    │
    ▼ ── Layer 5: Backbone Proxy (configurable port, default 8787, 127.0.0.1 only) ──
    │  Headroom (yehsuf fork)                        → 60-95% outbound
    │    ContentRouter: SmartCrusher / CodeCompressor / Kompress-base
    │    CacheAligner: stabilise KV cache prefixes
    │    CCR: reversible compression (originals retrievable)
    │    Thrash cache: deduplicate repeat tool reads
    │    Diff enforcer: intercept full-file rewrites → force patch format
    │    Copilot enforcement: reject forbidden raw tool calls mid-flight
    │    Corporate SSL: full env var chain (see §7.4)
    │
    ▼ ── Layer 6: Budget Control + Model Router (opt-in) ───────────
    │  LiteLLM sub-router
    │    claude-haiku-4-5  → cheap turns (format, rename, status)
    │    claude-opus-4-7   → complex turns (architect, implement)
    │
    ▼ ── Layer 7: Output Style + Enforcement ───────────────────────
    │  Caveman rules in CLAUDE.md + AGENTS.md        → ~8% verbosity
    │  Node.js enforcement hooks (not bash)          → cross-platform
    │    cbm-discovery-gate → blocks Read/Grep until Serena used
    │    bash-ban-raw-tools → blocks cat/grep/find raw
    │    session-reminder   → reinjects protocol on /clear
    │
    ▼ ── Layer 8: Learning (human-in-loop) ─────────────────────────
    │  headroom learn → ~/.headroom/proposals/       → review queue only
    │  mem0 long-term → cross-session facts
    │
    ▼ ── Observability ─────────────────────────────────────────────
    │  Helicone (self-host Docker) → real-time token/$/cache per session
    │  token-optimizer (Claude Code plugin) → live pre-proxy view
    │  AI Engineering Coach (VS Code extension) → anti-pattern detection
    │  tokenstack stats → unified savings dashboard (§8)
    │
    ▼
Anthropic API / GitHub Copilot Backend
```

---

## 3. Components

### 3.1 Serena (Code Discovery — Structural)
- **Repo:** https://github.com/oraios/serena
- **Already installed:** `/Users/ysufrin/.local/bin/serena` v1.5.4.dev0
- **Role:** Replaces CBM. Real LSP servers (same analysis as VS Code). 40+ languages.
- **Key tools:** `find_symbol`, `find_referencing_symbols`, `get_symbols_overview`, `search_for_pattern_in_files`, `query_project` (cross-project), `write_memory`/`read_memory`
- **Language backends:** LSP (default, free) + JetBrains Plugin (paid, optional)
- **Install:** `uv tool install serena`
- **Windows:** Native support (`activate.bat`, `mslex-split`, Windows GUI dashboard)
- **Copilot CLI:** Confirmed working (tested by GPT-5.4 in Copilot CLI, monorepo evaluation)
- **Memory:** ~80MB baseline + lazy-started LSPs (TS: +150-300MB, Rust: +1-3GB, Python: +80-200MB)

### 3.2 Semble (Code Discovery — Semantic)
- **Repo:** https://github.com/MinishLab/semble
- **Role:** Natural language code search. Fills the semantic gap Serena doesn't cover.
- **Key capability:** "Find retry logic", "How is auth handled?" — vector similarity, not symbol lookup
- **Stats:** NDCG@10=0.854, 98% fewer tokens vs grep+read, 250ms index, 1.5ms query, CPU-only
- **Install:** `uv tool install semble && semble install`
- **Modes:** MCP server, CLI, sub-agent

### 3.3 ast-grep MCP (Code Discovery — Structural Patterns)
- **Repo:** https://github.com/ast-grep/ast-grep
- **Role:** Cross-file structural pattern matching. Neither Serena nor Semble covers "find all JSON.parse without try/catch."
- **Key advantage:** Returns matched code chunks only — not whole files
- **Install:** `cargo install ast-grep` or binary from GitHub releases
- **Memory:** ~0MB (no index — scans at query time)
- **Windows:** Pre-built binaries on GitHub releases

### 3.4 mcp-server-git (Diff/Review Context)
- **Repo:** https://github.com/modelcontextprotocol/servers (src/git)
- **Role:** git_diff, git_show, git_blame, git_log as MCP tools
- **Key advantage:** 10× smaller context for code review vs reading both file versions
- **Install:** `uvx mcp-server-git` (no install — runs on demand)
- **Memory:** ~0MB

### 3.5 mem0 (Conversation Memory)
- **Repo:** https://github.com/mem0ai/mem0
- **Role:** Extracts facts, preferences, decisions from conversation turns. Replaces O(N) history with O(k) structured facts.
- **Stats:** 80-90% reduction on long sessions vs carrying full history
- **Install:** `pip install mem0ai` + MCP server config
- **Modes:** MCP server (2025 release), REST API, Python SDK

### 3.6 RTK (Shell Compression)
- **Repo:** https://github.com/rtk-ai/rtk
- **Role:** Filters/compresses ls, cat, grep, git, 100+ CLI outputs before they enter context
- **Stats:** 60-90% reduction. <10ms overhead. Single Rust binary.
- **Install:** macOS/Linux: `brew install rtk` | Windows: GitHub release binary (fallback: `cargo install rtk`)
- **Note:** Bundled in headroom — no separate install needed when using headroom wrap mode

### 3.7 Headroom — Backbone Proxy (yehsuf fork)
- **Repo:** https://github.com/yehsuf/headroom
- **Role:** Transparent proxy on port 8787. Intercepts ALL API calls before Anthropic/GitHub. Network-layer enforcement — impossible to bypass.
- **Key components:**
  - `ContentRouter`: routes to SmartCrusher (JSON), CodeCompressor (AST), Kompress-base (text)
  - `CacheAligner`: stabilises prompt prefixes for provider KV cache hits
  - `CCR`: reversible compression (originals retrievable on demand)
  - `headroom learn`: mines failed sessions → proposal queue
- **Compression backends:** Kompress-base (default, fast), LLMLingua-2 (configurable, strategy pattern)
- **LLMLingua-2 strategy:** Kompress-base for <4KB and streaming; LLMLingua-2 for large batches only. Never loaded simultaneously.
- **Corporate SSL env vars (full set):**
  - `HEADROOM_SSL_VERIFY` — true/false/path
  - `HEADROOM_CA_BUNDLE` — path to PEM bundle (appends to system store)
  - `HEADROOM_CLIENT_CERT`, `HEADROOM_CLIENT_KEY` — mTLS
  - `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (and lowercase variants)
  - `NODE_EXTRA_CA_CERTS` — for Claude Code (Node.js runtime)
  - `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE` — Python subprocess (LLMLingua-2)
  - `GIT_SSL_CAINFO` — for git operations
- **Security:** Binds to 127.0.0.1 ONLY. Logs scrub `Authorization:` and `x-api-key` before disk write.
- **Port:** Configurable. Resolution order (highest to lowest priority):
  1. `HEADROOM_PORT` environment variable
  2. `proxy.headroom.port` in `~/.tokenstack/config.yaml`
  3. Default: `8787`
  All downstream references (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, health-check endpoints, service definitions) are generated from the resolved port at install time and updated on port change via `tokenstack config set proxy.headroom.port <N>`.
- **Startup:** Wrapper blocks on `GET http://127.0.0.1:${HEADROOM_PORT}/health` (5s timeout) before exec
- **Install:** `pip install "headroom-ai[all]"` via uv (dedicated venv at `~/.tokenstack/venv/`)

### 3.8 Anthropic SRT (Output Sandboxing)
- **Package:** `@anthropic-ai/sandbox-runtime`
- **Found locally:** `/Users/ysufrin/sandbox-runtime-clean`
- **Role:** OS-level sandbox wraps MCP servers and tool calls. Restricts filesystem/network access — prevents runaway reads from blowing the context window.
- **Platform:** macOS + Linux (bubblewrap on Linux). WSL2 required on Windows.
- **Install:** `npm install -g @anthropic-ai/sandbox-runtime`

### 3.9 context-mode (Output Virtualisation — Claude Code only)
- **Repo:** https://github.com/mksglu/context-mode
- **Role:** Intercepts tool outputs, BM25-indexes them, returns summaries. The primary session-extension mechanism for Claude Code.
- **Stats:** Sessions extend from 30min to 3+ hours
- **Tools:** ctx_execute, ctx_batch_execute, ctx_search, ctx_fetch_and_index
- **Install:** `claude plugin marketplace add mksglu/context-mode`

### 3.10 LiteLLM (Budget Control + Model Router — opt-in)
- **Repo:** https://github.com/BerriAI/litellm
- **Role:** Budget enforcement + intelligent model routing (Haiku for cheap turns, Opus for complex)
- **Integration:** Sub-proxy in the headroom pipeline. Claude Code → Headroom → LiteLLM → Anthropic API
- **Config:** `cheap_model: claude-haiku-4-5`, `complex_model: claude-opus-4-7`
- **Savings:** 30-40% cost reduction (same token count, cheaper model on routine turns)
- **Install:** `pip install litellm` via uv

### 3.11 CBM — Fallback for MCP-Limited Environments
- **Repo:** https://github.com/DeusData/codebase-memory-mcp
- **Role:** Single-binary fallback when the environment limits MCP server count or headless installation needed
- **Auto-selected:** When `mcp_server_count < mcp_limit_threshold` in config
- **Install:** Single binary download from GitHub releases

### 3.12 Observability Stack
- **Helicone** (`helicone.ai` self-host) — per-session token/cost/cache dashboard. Change `ANTHROPIC_BASE_URL=http://localhost:47001` (Helicone sub-proxy).
- **token-optimizer** (`claude plugin install`) — live pre-proxy view in Claude Code
- **AI Engineering Coach** (VS Code Marketplace) — 45 anti-pattern rules, skill finder
- **`tokenstack stats`** command — unified savings report (see §8)

---

## 4. Configuration

### 4.1 Master Config: `~/.tokenstack/config.yaml`

```yaml
version: "1.0"

proxy:
  headroom:
    enabled: true
    port: 8787                      # CONFIGURABLE — change with: tokenstack config set proxy.headroom.port <N>
                                    # Override anytime via HEADROOM_PORT env var (takes precedence)
                                    # Changing this regenerates ANTHROPIC_BASE_URL, service definition, health checks
    bind: "127.0.0.1"              # NEVER 0.0.0.0
    backend: kompress-base          # or: llmlingua-2
    thrash_cache: true
    diff_enforcer: true
    corporate_proxy: ""             # set from HTTPS_PROXY if detected

index_tier: default                 # light | default | full
code_discovery:
  serena:
    enabled: true
    lsp:
      typescript: true
      python: true
      rust: false                   # 1-3GB — opt-in only
      go: true
  semble: true
  astgrep: true
  mcp_git: true
  cbm_fallback:
    enabled: true
    mcp_limit_threshold: 3          # use CBM if environment allows <3 MCPs

conversation_memory:
  mem0: true

shell_compression:
  rtk: true

output_sandboxing:
  srt: true                         # Mac/Linux only
  context_mode: true                # Claude Code only

budget_routing:
  litellm: false                    # opt-in
  cheap_model: claude-haiku-4-5
  complex_model: claude-opus-4-7
  cheap_threshold: 0.3

output_style:
  caveman_rules: true
  hooks: true                       # Node.js hooks

learning:
  headroom_learn: true              # proposals queue only

observability:
  helicone: false                   # opt-in, self-host Docker
  token_optimizer: true
  ai_engineering_coach: true

stacklit:
  enabled: false                    # opt-in via: tokenstack init --with-stacklit

semgrep:
  enabled: false                    # opt-in for security/architectural enforcement
```

### 4.2 Claude Code: `~/.claude/settings.json` (deep-merge, preserve user keys)

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:${HEADROOM_PORT:-8787}",
    "ENABLE_PROMPT_CACHING_1H": "1",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-6",
    "HEADROOM_PORT": "8787"
  },
  "model": "claude-opus-4-7",
  "effortLevel": "xhigh",
  "mcpServers": {
    "serena": {
      "command": "serena",
      "args": ["--project", "${workspaceFolder}"]
    },
    "semble": {
      "command": "semble",
      "args": ["mcp"]
    },
    "mcp-git": {
      "command": "uvx",
      "args": ["mcp-server-git", "--repository", "${workspaceFolder}"]
    },
    "mem0": {
      "command": "uvx",
      "args": ["mem0-mcp"]
    }
  },
  "hooks": {
    "preToolUse":  ["cbm-discovery-gate.mjs", "bash-ban-raw-tools.mjs"],
    "postToolUse": ["serena-mcp-marker.mjs"],
    "onClear":     ["session-reminder.mjs"]
  }
}
```

### 4.3 Copilot CLI: `~/.copilot/mcp-config.json`

```json
{
  "servers": {
    "serena": {
      "command": "serena",
      "args": ["--project", "${workspaceFolder}"]
    },
    "semble": {
      "command": "semble",
      "args": ["mcp"]
    },
    "mcp-git": {
      "command": "uvx",
      "args": ["mcp-server-git", "--repository", "${workspaceFolder}"]
    },
    "mem0": {
      "command": "uvx",
      "args": ["mem0-mcp"]
    }
  }
}
```

Note: Headroom proxy enforcement works at network level for Copilot CLI via `OPENAI_BASE_URL=http://127.0.0.1:${HEADROOM_PORT:-8787}` (injected by the wrapper using the resolved port).

### 4.4 CLAUDE.md Managed Section

```markdown
<!-- >>> tokenstack managed >>> -->
## Code Navigation Protocol (MANDATORY)
1. Before ANY file read or grep, call `serena_find_symbol` or `serena_get_symbols_overview`.
2. For semantic/intent queries ("find retry logic"), call `semble_search`.
3. For cross-file structural patterns ("all JSON.parse without try/catch"), call astgrep.
4. For code review context, call `git_diff` or `git_show` — never read both file versions.
5. Never use raw `cat`, `grep`, `find`, `head`, `tail` in the Bash tool.

## Output Protocol
- Terse. No preamble. No recap. No "I will now…". Code diffs only.
- Bullet lists over prose. No emoji. Patch format for file edits.

## Session Hygiene
- Run `/compact` before `/clear`. headroom learn runs end-of-session.
- Watch token-optimizer; if context quality < 0.6, checkpoint and reset.
<!-- <<< tokenstack managed <<< -->
```

### 4.5 AGENTS.md Managed Section (both CLIs, per-repo)

```markdown
<!-- >>> tokenstack managed >>> -->
## Efficient Navigation
- Use MCP tools: `serena.*`, `semble.*` for code discovery.
- Shell commands are RTK-compressed; do NOT pipe through head -n etc.
- Large outputs are indexed by context-mode (Claude Code) — never dump >500 lines.
- For code review: call `git_diff` / `git_show` — not read_file on both versions.
- For cross-file patterns: use astgrep, not grep loops.

## Output Protocol
- Terse. No preamble. Patch format for file edits.
- Bullet lists over prose. No emoji.
<!-- <<< tokenstack managed <<< -->
```

### 4.6 Index Memory Tiers

| Tier | Config | Active tools | RAM estimate |
|------|--------|-------------|--------------|
| `light` | `index_tier: light` | Serena (1 LSP, no Rust), ast-grep, mcp-git | 250–400MB |
| `default` | `index_tier: default` | + Semble | 450–700MB |
| `full` | `index_tier: full` | + additional LSPs as configured | 700MB–1.5GB+ |

---

## 5. Installation Architecture

### 5.1 Entry Points

```bash
# macOS / Linux
curl -fsSL https://get.tokenstack.dev | sh

# Windows (PowerShell — execute before downloading anything)
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
powershell -ExecutionPolicy Bypass -c "irm https://get.tokenstack.dev/install.ps1 | iex"
```

### 5.2 File Structure

```
install.sh       macOS/Linux bootstrap: checks Node + uv, runs install.mjs
install.ps1      Windows bootstrap: same, PowerShell-native
install.mjs      Core installer (Node.js, 90% of logic, cross-platform)
uninstall.mjs    Idempotent removal
```

### 5.3 install.mjs Logic (pseudocode)

```javascript
parse_flags()         // --profile, --index-tier, --no-headroom, --no-litellm,
                      //   --with-stacklit, --copilot-only, --claude-only, --check, --dry-run
detect_environment()  // OS, shell, existing tools, corporate proxy, CA files
detect_state()        // which tools already installed + versions → STATE map
if (--check) { print_state_table(); exit(0) }
if (--dry-run) { print_planned_changes(); exit(0) }

// Tier 1: always
install_uv()
install_serena()            // uv tool install serena
install_semble()            // uv tool install semble && semble install
install_astgrep()           // GitHub release binary or cargo install ast-grep
install_mcp_git()           // uvx mcp-server-git (no install, on-demand)
install_mem0()              // pip install mem0ai via uv
install_rtk()               // brew install rtk | GitHub release | cargo install rtk (WARN on Windows)
install_headroom()          // uv tool install "headroom-ai[all]" → ~/.tokenstack/venv/

// Tier 2 (default profile)
install_context_mode()      // claude plugin marketplace add mksglu/context-mode (Claude Code only)
install_token_optimizer()   // claude plugin install token-optimizer                 (Claude Code only)
install_srt()               // npm install -g @anthropic-ai/sandbox-runtime (Mac+Linux)

// Tier 3 (opt-in)
if (flags.withStacklit)   install_stacklit()
if (flags.withLitellm)    install_litellm()
if (flags.withHelicone)   configure_helicone()

// Config
configure_corporate_ssl()   // auto-detect HTTPS_PROXY, existing CA files
                            //   inject full env var chain into headroom + launchd/systemd
merge_settings_json()       // deep merge, preserve user keys
append_claude_md()          // managed markers
append_agents_md()          // managed markers
write_copilot_mcp_config()  // merge MCP entries

// Service
install_service()
  // macOS:   write ~/Library/LaunchAgents/com.tokenstack.headroom.plist
  //          launchctl bootout ... && launchctl bootstrap ...
  // Linux:   write ~/.config/systemd/user/headroom.service
  //          systemctl --user enable --now headroom
  // Windows: Register-ScheduledTask (no admin) + 5-min health-check task

// Hooks (Node.js, NOT bash)
install_hooks()             // write ~/.claude/hooks/*.mjs

// Verify
verify_all()                // ping /health, test MCP launch, verify hook load
report()                    // print status table: {tool, version, status, verified}
```

### 5.4 Idempotency Rules

- Every binary install checks version first. Skip if already up-to-date.
- Every config write uses managed markers (`<!-- >>> tokenstack managed >>>`) — user content outside markers is NEVER touched.
- Config backup: `settings.json.bak.YYYYMMDD-HHMMSS` before each modification.
- Service install: bootout existing → bootstrap new (launchd), `daemon-reload` + `enable --now` (systemd), `Register-ScheduledTask -Force` (Windows).

### 5.5 Windows-Specific Notes

- **RTK:** Attempt GitHub release `.exe` download first. Fallback: `cargo install rtk` (warns about 3GB VS Build Tools). Skip gracefully if neither works.
- **Defender exclusion:** Add `$env:USERPROFILE\.tokenstack\bin` to Defender exclusion BEFORE binary download.
- **API keys:** `[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", key, "User")` — persists to registry.
- **Service:** Task Scheduler (no admin) + companion 5-min health-check task using `Test-NetConnection -Port 8787`.
- **Shell hooks:** Node.js `.mjs` files — Claude Code uses `node` on Windows, no bash dependency.
- **MAX_PATH:** Attempt `Set-ItemProperty LongPathsEnabled 1` (silent if no admin).

---

## 6. Profiles

| Profile | Tools active | Use case |
|---------|-------------|----------|
| `proxy` (default) | All layers active | Full savings, full enforcement |
| `mcp` | All MCPs, no proxy daemon | Lower RAM, no proxy maintenance |
| `minimal` | Serena + CBM fallback + RTK | Restricted environments, quick setup |

```bash
tokenstack profile proxy      # switch to proxy profile
tokenstack profile mcp        # switch to MCP-only
tokenstack profile minimal    # switch to minimal
tokenstack enable litellm     # toggle individual layer
tokenstack disable context_mode
```

---

## 7. Per-Repo Setup

```bash
cd my-project
tokenstack init
# Runs:
#   semble install          (creates per-repo index)
#   serena onboarding       (creates .serena/ project notes)
#   repomix --init          (creates .repomixignore)
#   git mcp config check    (verifies mcp-server-git finds repo)
#   optional: --with-stacklit flag → generates + commits stacklit.json + DEPENDENCIES.md

tokenstack init --with-stacklit   # also installs Stacklit + CI GitHub Action
tokenstack init --with-semgrep    # also configures Semgrep for architectural rules
```

---

## 8. Observability — `tokenstack stats`

Queries Headroom metrics API + token-optimizer session data. Output:

```
Session: 2026-07-06  Duration: 47min  Turns: 34
─────────────────────────────────────────────────────────
Layer            Tokens Before   After    Saved   %
─────────────────────────────────────────────────────────
Serena/Semble     412,000     3,400   408,600  99.2%
RTK shell          28,000     5,600    22,400  80.0%
context-mode       95,000     1,900    93,100  98.0%
Headroom proxy     75,000    22,500    52,500  70.0%
Caveman output     18,000     9,200     8,800  48.9%
─────────────────────────────────────────────────────────
TOTAL           1,800,000   127,000 1,673,000  92.9%
─────────────────────────────────────────────────────────
Cost saved: ~$24.78  (Opus 4-7 pricing)
Cache hits:  73%  (CLAUDE.md prefix stable)
Model routing: 18/34 turns → Haiku  (-$8.40 additional)
─────────────────────────────────────────────────────────
```

---

## 9. Maintenance

### Update Commands

```bash
tokenstack update               # update all tools
tokenstack update --check       # dry-run: show what would change
```

### Per-tool update managers

| Manager | Tools | Command |
|---------|-------|---------|
| uv tool | Serena, Semble, headroom-ai, mem0, mcp-git | `uv tool upgrade --all` |
| cargo | RTK, ast-grep | `cargo install rtk ast-grep --locked` |
| npm -g | SRT, Stacklit, Caveman | `npm update -g` |
| Claude plugin | context-mode, token-optimizer | `claude plugin update --all` |
| Homebrew | RTK (macOS/Linux) | `brew upgrade rtk` |
| VS Code | AI Engineering Coach | auto |

### Cadence

- **Weekly:** `tokenstack update --check` (drift detection, no side effects)
- **Bi-weekly:** `tokenstack update` (idempotent upgrade)
- **After Claude Code release:** verify hooks still register (`tokenstack verify`)
- **Monthly:** `tokenstack init` per active repo (refresh Serena/Semble indexes)
- **Never auto-update:** Headroom compression model — pin version, test fidelity manually

### Known Breakage Vectors

1. **MCP protocol bumps** — Claude Code/Copilot CLI upgrade may require MCP server upgrades. Symptom: tools appear connected but invisible.
2. **Headroom port already in use** — run `tokenstack diagnose` to kill orphan beacons.
3. **Claude Code hook API changes** — hooks are highest-churn surface. Run `tokenstack verify` after each Claude Code release.
4. **Serena LSP server deprecation** — individual language servers (pyright, tsserver) release independently. `uv tool upgrade serena` pulls latest.
5. **Corporate proxy changes** — VPN connect/disconnect can change `HTTPS_PROXY` state. Headroom re-reads env vars on restart.

---

## 10. Error Handling + Fallbacks

### Proxy Failure (Headroom)

```
Start:    Service pre-warmed by daemon (launchd/systemd/Task Scheduler)
Wrapper:  Poll GET /health, 100ms backoff, 5s max → then exec CLI
Mid-session crash: CLI sees connection refused → fail clearly with message
                   Service manager auto-restarts (KeepAlive/Restart=always)
                   Next session: proxy healthy on launch
Fallback: --profile mcp is available as manual fallback
```

### MCP Server Failure

```
Serena crash: Claude Code falls back to built-in file tools (worse but functional)
Semble crash: semantic search unavailable; Serena structural search still works
All MCPs:     tokenstack verify → restart individual MCPs via tokenstack restart serena
```

### CBM Auto-Selection

```
Environment limits MCP count to < mcp_limit_threshold (config):
  → Serena + Semble disabled
  → CBM binary loaded instead (single process, fits within MCP limit)
  → Logs: "[tokenstack] MCP limit detected, using CBM fallback"
```

### headroom learn (Human-in-Loop)

```
Session end:  proposals written to ~/.headroom/proposals/YYYY-MM-DD.md
Review:       user runs `headroom learn review` (interactive CLI)
Approve:      appends rule inside managed markers in CLAUDE.md / AGENTS.md
Reject:       proposal archived to ~/.headroom/proposals/rejected/
Rule TTL:     30 days; expired rules flagged in next `tokenstack update --check`
NEVER:        auto-write to CLAUDE.md/AGENTS.md without explicit approval
```

---

## 11. Security

- Proxy binds to `127.0.0.1` only — never `0.0.0.0`
- All proxy logs scrub `Authorization:`, `x-api-key`, `Bearer ` before writing to disk
- Corporate CA private key: `chmod 600` on macOS/Linux; strict ACLs on Windows
- Defender exclusion added before binary download (Windows)
- API keys: macOS Keychain / Linux `~/.tokenstack/.env` (chmod 600) / Windows registry HKCU
- Serena processes are read-only by default; file writes require explicit `create_text_file` call
- SRT (sandbox-runtime) provides OS-level isolation for MCP tools — restricts filesystem and network access

---

## 12. Projected Token Savings

| Layer | Cumulative % remaining |
|-------|----------------------|
| Baseline | 100% |
| + Caveman rules + system prompt | 92% |
| + Serena + Semble (code discovery) | 50% |
| + mem0 (conversation history) | 35% |
| + RTK (shell compression) | 25% |
| + context-mode + SRT (output sandboxing) | 15% |
| + Headroom proxy (outbound compression) | ~7% |
| **Total token reduction** | **~93%** |
| + LiteLLM model routing | same tokens, **40-60% lower cost** |

**30-minute baseline cost (Opus 4-7): ~$27**  
**30-minute with full stack: ~$1.90 tokens + ~$1.10 routing savings = ~$0.80**  
**Savings: ~$26/session. 40-hr work-week: ~$1,040/week.**

Sessions extend: 30 min → 3-6 hrs on same context window.

---

## 13. Open Items / Future Roadmap

1. **git blame/log MCP** — extend mcp-server-git with `git_blame` and `git_log` tools
2. **LSP diagnostics MCP** — expose type errors, hover, go-to-def as MCP tools (separate from Serena's structural tools)
3. **Symbol importance / PageRank** — "top-N most central classes in this codebase" (not currently answered)
4. **Enterprise tier** — CocoIndex + mcp-server-qdrant for 500K+ LOC repos; Sourcegraph/SCIP for multi-repo
5. **Dependency source navigation** — on-demand indexing of node_modules/.venv
6. **Non-code indexing** — notebooks (.ipynb), SQL files, markdown runbooks (Semble may cover with config)
7. **Priompt integration** — CLAUDE.md priority-drop tooling (currently manual authoring discipline)

---

*Spec validated by: Architect (Claude Opus 4.7, high), Architect (GPT-5.5, high), Architect (Gemini 3.1 Pro), Research × 2*  
*Session: 24fc8f38-e29d-41cb-aade-bed260cf9e73*
