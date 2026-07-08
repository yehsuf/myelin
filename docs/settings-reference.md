# TokenStack Settings Reference

Every setting in `~/.tokenstack/config.yaml` explained — what it does, what you gain, what you lose, and when to change it.

**How to change a setting:**
```bash
tokenstack config set <key.path> <value>   # change one setting
tokenstack config edit                      # open full config in $EDITOR
tokenstack config show                      # print current config with defaults
tokenstack config reset                     # restore factory defaults (keeps backups)
```

**Port changes regenerate downstream config automatically** — you never manually update `ANTHROPIC_BASE_URL` or service definitions.

---

## Table of Contents

1. [Proxy Settings](#1-proxy-settings)
2. [Index Tier](#2-index-tier)
3. [Code Discovery](#3-code-discovery)
4. [Conversation Memory](#4-conversation-memory)
5. [Shell Compression](#5-shell-compression)
6. [Output Sandboxing](#6-output-sandboxing)
7. [Budget Routing](#7-budget-routing)
8. [Output Style + Enforcement](#8-output-style--enforcement)
9. [Learning](#9-learning)
10. [Observability](#10-observability)
11. [Optional Tools](#11-optional-tools)
12. [Environment Variables Reference](#12-environment-variables-reference)
13. [Quick Recipes](#13-quick-recipes)

---

## 1. Proxy Settings

The proxy is the backbone of TokenStack. It sits between your AI agent and the LLM API, compressing everything that leaves your machine before Anthropic or GitHub Copilot ever sees it.

---

### `proxy.headroom.enabled`
**Type:** boolean | **Default:** `true`

**What it does:** Enables the Headroom transparent proxy. When enabled, all Claude Code and Copilot CLI API calls pass through the local proxy before reaching the LLM provider.

**What you gain:** 60-95% outbound token compression. Network-layer enforcement (impossible to bypass, unlike hooks). Corporate SSL interception support. Cross-agent shared memory.

**What you lose:** A background process must run. ~80MB RAM overhead. 5-15ms latency per API call (negligible vs LLM response time).

**When to disable:** Inside sandboxed CI environments where local processes can't bind ports. Use `--profile mcp` instead.

```yaml
proxy:
  headroom:
    enabled: false   # switches to MCP-only profile automatically
```

---

### `proxy.headroom.port`
**Type:** integer | **Default:** `8787` | **Range:** 1024–65535

**What it does:** The local port the Headroom proxy listens on. All agent API calls are routed to `http://127.0.0.1:<port>`.

**Resolution order (highest priority first):**
1. `HEADROOM_PORT` environment variable (for temporary overrides)
2. This config value (persistent)
3. Built-in default: `8787`

**What happens when you change it:** `tokenstack config set proxy.headroom.port 9090` automatically:
- Updates `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`
- Updates `OPENAI_BASE_URL` injected for Copilot CLI
- Regenerates the launchd plist / systemd unit / Windows Task with the new port
- Restarts the service
- Verifies the new port responds on `/health`

**When to change:** Port 8787 is already in use on your machine by another service. Check with `lsof -i :8787` (macOS/Linux) or `Get-NetTCPConnection -LocalPort 8787` (Windows).

```yaml
proxy:
  headroom:
    port: 9090   # any free port 1024-65535
```

---

### `proxy.headroom.bind`
**Type:** string | **Default:** `"127.0.0.1"` | **Allowed:** `"127.0.0.1"` only

**What it does:** The network interface the proxy binds to.

**Why this is locked to 127.0.0.1:** Binding to `0.0.0.0` would expose an unauthenticated LLM proxy to everyone on your local network (your colleagues, coffee shop patrons, corporate LAN). Anyone who can reach your IP could use your Anthropic API key. This setting cannot be changed to `0.0.0.0` without a source code modification — intentionally.

---

### `proxy.headroom.backend`
**Type:** string | **Default:** `"kompress-base"` | **Options:** `"kompress-base"`, `"llmlingua-2"`

**What it does:** Selects the compression model used by the Headroom proxy.

**`kompress-base` (default):**
- Headroom's proprietary model trained on agentic traces
- Deterministic, fast (<10ms per chunk), streamable
- Works on all content types (JSON via SmartCrusher, AST via CodeCompressor, text via Kompress-base)
- Zero GPU requirement, <50MB model size
- Reversible (originals stored via CCR)

**`llmlingua-2`:**
- Microsoft research model (XLM-RoBERTa-based token classifier)
- Up to 20× compression on dense text vs 60-95% for Kompress-base
- **Requires:** ~1.8GB RAM, 150-400ms per chunk on CPU (vs <10ms for Kompress-base)
- **Strategy pattern applied automatically:** LLMLingua-2 is only used for payloads >4KB AND when streaming is not active. Streaming responses always use Kompress-base.
- **First load:** 4-8 second cold start when proxy starts (model load). Pre-loads on service startup.
- **When to use:** You have 16GB+ RAM free, you're doing batch/non-interactive tasks, and you want maximum compression on large code review payloads.

```yaml
proxy:
  headroom:
    backend: llmlingua-2    # enable heavy compression profile
```

---

### `proxy.headroom.thrash_cache`
**Type:** boolean | **Default:** `true`

**What it does:** When an agent reads the same file or runs the same shell command twice in a session, the proxy intercepts the second (and subsequent) calls and returns a cached summary instead of re-sending the full output to the LLM.

**What you gain:** Prevents the most common token waste pattern — agents that call `read_file("auth.ts")` 4 times in one session because they forgot what they read. Each repeat was paying the full file cost. With thrash cache, only the first call is real; repeats cost ~50 tokens (the summary).

**What you lose:** In rare cases where the file changed between calls (you saved a file mid-session), the agent gets a stale cached version. The cache auto-invalidates when Serena/Semble detect a file modification event. Cache TTL is one session.

**When to disable:** When actively pair-programming or watching file changes in real time where freshness of each re-read matters more than token savings.

```yaml
proxy:
  headroom:
    thrash_cache: false
```

---

### `proxy.headroom.diff_enforcer`
**Type:** boolean | **Default:** `true`

**What it does:** Intercepts outgoing tool-use requests where the agent is about to rewrite an entire file. Automatically converts them to patch/diff format: only the changed lines are sent in the response, not the full file contents.

**What you gain:** The single biggest remaining token win after code discovery. If an agent reads a 500-line file and changes 2 lines, without this setting you pay for 500 tokens to read + 500 tokens to write = 1000 tokens for a 2-line change. With diff enforcement: read costs ~50 tokens (summary), write costs ~20 tokens (patch). ~97% reduction on edit operations.

**What you lose:** Extremely rarely, a model gets confused by patch format vs full file and makes an incorrect edit. If you see repeated edit failures, temporarily disable this.

**When to disable:** Working with binary files or auto-generated code where patch format isn't meaningful.

```yaml
proxy:
  headroom:
    diff_enforcer: false
```

---

### `proxy.headroom.corporate_proxy`
**Type:** string | **Default:** `""` (auto-detected)

**What it does:** Upstream HTTP/HTTPS proxy that Headroom uses when forwarding requests to Anthropic/GitHub. Headroom itself acts as a local proxy; this setting tells it where to send traffic if YOUR network requires a corporate proxy.

**Auto-detection:** On startup, TokenStack checks `HTTPS_PROXY`, `HTTP_PROXY`, and system proxy settings. If found, this is set automatically and you don't need to configure it manually.

**Format:** `http://proxy.company.com:8080` or `http://user:password@proxy.company.com:8080`

```yaml
proxy:
  headroom:
    corporate_proxy: "http://proxy.corp.example.com:3128"
```

---

## 2. Index Tier

Controls how much memory the indexing layer uses. Determines which LSP servers are active.

---

### `index_tier`
**Type:** string | **Default:** `"default"` | **Options:** `"light"`, `"default"`, `"full"`

**What it does:** Sets the memory profile for the code discovery layer (Serena + Semble).

| Tier | Active tools | RAM estimate | Best for |
|------|-------------|--------------|----------|
| `light` | Serena (1 LSP, LSP off for heavy langs), ast-grep, mcp-git | 250–400MB | Laptops under memory pressure, CI, quick tasks |
| `default` | + Semble semantic search | 450–700MB | Daily coding on most projects |
| `full` | + all configured LSPs active | 700MB–1.5GB+ | Deep work on large TypeScript/Rust projects |

**What you gain from `full`:** Serena's LSP-backed symbol resolution is the most accurate it can be. Type-level information, interface implementations, overload resolution — all available. On a large TypeScript codebase, this means `find_referencing_symbols` returns results with resolved types, not just text matches.

**What you lose from `full`:** Memory. A `default` → `full` switch on a TypeScript project might cost +400MB (tsserver) or +1-3GB (rust-analyzer). Your laptop will notice.

**Tip:** Use `tokenstack status` to see current RAM usage per LSP. Use `full` for your primary project, `light` for quick scripts or unfamiliar repos.

```bash
tokenstack config set index_tier light    # reduce memory pressure
tokenstack config set index_tier full     # maximum code intelligence
```

---

## 3. Code Discovery

---

### `code_discovery.serena.enabled`
**Type:** boolean | **Default:** `true`

**What it does:** Enables Serena as the structural code intelligence MCP server. Serena wraps real language servers (the same ones VS Code uses internally) and exposes them as MCP tools.

**What you gain:** Symbol-level lookups without reading whole files. `find_symbol("UserService")` returns the class definition and its location (20 tokens). Without Serena, the agent reads every likely file until it finds it (potentially thousands of tokens). On a 100K LOC project this is the difference between a 3-token MCP call and a 50,000-token grep expedition.

**What you lose:** Serena itself uses ~80MB RAM + per-LSP memory (see below). Cold start of a language server adds 3-15 seconds to the first query (subsequent queries are fast).

**When to disable:** Memory-critical environments. When CBM fallback is preferred for its lower overhead.

---

### `code_discovery.serena.lsp.typescript`
**Type:** boolean | **Default:** `true` | **RAM cost:** +150–400MB

**What it does:** Enables `tsserver` (TypeScript language server) within Serena for TypeScript and JavaScript projects. Provides full type resolution, interface lookup, overload resolution, cross-file imports.

**What you gain over tree-sitter-only:** When Serena calls `find_symbol("UserRepository")`, with LSP it knows which class implements the `IUserRepository` interface, what the return type of each method is, and which module exports it. Without LSP, you get the symbol name and approximate location — no type information.

**When to disable:** Pure JavaScript projects without type annotations (type resolution adds no value). Python-only projects. Memory pressure.

---

### `code_discovery.serena.lsp.python`
**Type:** boolean | **Default:** `true` | **RAM cost:** +80–200MB

**What it does:** Enables Pyright or pylsp (configurable in `~/.serena/serena_config.yml`) for Python projects.

**What you gain:** Django model relationships, SQLAlchemy type chains, FastAPI route parameter types, cross-module import resolution. `find_referencing_symbols("UserSerializer")` returns every view and test that uses it.

**When to disable:** Quick scripts, non-Python projects, memory pressure.

---

### `code_discovery.serena.lsp.rust`
**Type:** boolean | **Default:** `false` | **RAM cost:** +1–3GB

**What it does:** Enables rust-analyzer for Rust projects.

**Why it defaults to OFF:** rust-analyzer is the most capable language server available for any language — and the most memory-hungry. On a medium Rust project it uses 1-2GB RAM. On large projects (tokio, axum, etc.) it can use 3GB+. Most developers do not have this available alongside their browser, IDE, and other tools.

**What you gain when enabled:** Trait resolution, lifetime analysis, macro expansion, precise `find_referencing_symbols` that understands Rust's ownership model. For Rust development this is transformative.

**How to enable only for Rust projects:**
```bash
cd my-rust-project
tokenstack init --enable-lsp rust   # enables rust only for this repo
```

```yaml
code_discovery:
  serena:
    lsp:
      rust: true   # enable globally (requires 16GB+ free RAM)
```

---

### `code_discovery.serena.lsp.go`
**Type:** boolean | **Default:** `true` | **RAM cost:** +80–150MB

Enables gopls for Go projects. Lightweight compared to TypeScript/Rust. Provides interface implementation lookup, cross-package navigation.

---

### `code_discovery.semble`
**Type:** boolean | **Default:** `true`

**What it does:** Enables Semble as a semantic search MCP server. Where Serena answers "where is function X defined", Semble answers "where does the codebase handle rate limiting?" — natural language, intent-based queries.

**What you gain:** Covers the ~40% of code discovery queries that are conceptual rather than symbol-based. "Find retry logic", "How is authentication done", "Where do we validate user input" — Semble returns the 3-5 most relevant code chunks (each ~200 tokens) rather than requiring the agent to grep through files.

**What you lose:** ~300MB RAM for the embedding index. 250ms to build index on first run per repo.

**How it differs from Serena:** Serena is precise (exact symbol lookup). Semble is fuzzy (semantic similarity). They're genuinely complementary — use Serena when you know what you're looking for, Semble when you're exploring.

---

### `code_discovery.astgrep`
**Type:** boolean | **Default:** `true`

**What it does:** Enables ast-grep as a structural pattern matching MCP server. Finds all code that matches a structural pattern across your entire codebase.

**What you gain:** Catches the queries neither Serena nor Semble can answer: "find all `JSON.parse` calls not inside try/catch", "find all React components using both useState and useEffect", "find all async functions that don't await their return value". These are anti-pattern detection, migration automation, and code quality queries.

**What you lose:** Near-zero (no index, scans at query time, Rust binary ~0MB RAM).

**Performance:** Fast on repos up to ~200K files. On very large monorepos a single ast-grep query may take 2-5 seconds (still fast vs alternatives).

---

### `code_discovery.mcp_git`
**Type:** boolean | **Default:** `true`

**What it does:** Enables `mcp-server-git` which exposes git operations as MCP tools: `git_diff`, `git_show`, `git_status`, `git_log`, `git_blame`, `git_commit`.

**What you gain:** For code review tasks, an agent calling `git_diff HEAD~1` gets only the changed lines — typically 200-2000 tokens. Without this, the agent reads the current file (potentially 5000 tokens) AND the previous version (another 5000 tokens) to understand what changed. 10× smaller context for review tasks.

**Also enables:** `git_blame` for debugging ("when was this introduced?"), `git_log` for context ("what else changed at the same time?"). These are the gaps from the original `mcp-server-git` that are now included.

---

### `code_discovery.cbm_fallback.enabled`
**Type:** boolean | **Default:** `true`

**What it does:** Keeps CBM (codebase-memory-mcp) installed as a fallback. When the environment limits MCP server count below `mcp_limit_threshold`, TokenStack automatically switches from Serena+Semble to CBM-only.

**Why CBM as fallback:** Some environments (certain CI setups, restricted corporate tooling, VSCode Web) limit how many MCP servers can be active simultaneously. CBM is a single static binary with zero dependencies that fits within a 1-server MCP constraint while still providing meaningful code discovery.

**What you lose vs Serena:** No real LSP type resolution. Tree-sitter only (accurate for structure, not semantics). No cross-project queries. But ~10× better than raw file reading.

---

### `code_discovery.cbm_fallback.mcp_limit_threshold`
**Type:** integer | **Default:** `3`

**What it does:** If the detected MCP server count limit is below this number, CBM fallback activates instead of Serena+Semble.

**Example:** An environment allows 2 MCP servers. With threshold=3: only 2 available → below threshold → use CBM (1 server) + mcp-git (1 server). If threshold=2: exactly 2 available → still switches to CBM.

```yaml
code_discovery:
  cbm_fallback:
    mcp_limit_threshold: 2   # switch to CBM if fewer than 2 slots available
```

---

## 4. Conversation Memory

---

### `conversation_memory.mem0`
**Type:** boolean | **Default:** `true`

**What it does:** Enables mem0 as an MCP server. mem0 intercepts conversation turns, extracts structured facts (decisions made, files touched, constraints discovered, failed approaches), and stores them in a local vector database. On each new turn, it injects only the relevant facts — not the full conversation history.

**What you gain:** Session history normally grows linearly — every turn adds to the context. After 20 turns you're carrying 20× the initial cost. With mem0, history is replaced by O(k) extracted facts where k is typically 5-15 items (a few hundred tokens) regardless of session length. **80-90% reduction on conversation history tokens for sessions longer than 15 minutes.**

**Concrete example:** 30 minutes of coding generates ~30 conversation turns. Raw history = ~80,000 tokens re-sent every turn. mem0 extracts: "working in auth module", "decided to use JWT", "avoid session cookies per user request", "UserService is the entry point" — ~200 tokens total. Savings: 99.75% on history alone.

**What you lose:** Some nuance in older turns may not be captured as a structured fact. For highly context-dependent workflows where exact phrasing matters, raw history is more faithful.

**When to disable:** Short sessions (<10 minutes). Tasks where exact historical phrasing is critical (e.g., legal or compliance document review).

---

## 5. Shell Compression

---

### `shell_compression.rtk`
**Type:** boolean | **Default:** `true`

**What it does:** RTK (Rust Token Killer) wraps every shell command executed by the agent and compresses its output before it enters the context window. It understands the output format of 100+ common commands and applies intelligent filtering: `git log` shows only the key fields, `ls -la` omits irrelevant columns, `cargo test` shows only failing tests plus a count, `npm install` collapses verbose package trees to a summary.

**What you gain:** 60-90% reduction on shell output tokens. The most impactful example: `cargo test` with 262 tests produces 4,823 tokens raw → ~500 tokens with RTK. A developer running tests 10 times per session saves ~43,000 tokens just from test output.

**What you lose:** Occasionally RTK's filtering removes a line you needed (e.g., a specific install path printed during `npm install`). RTK preserves all error output by default — failures are never filtered.

**When to disable:** When debugging RTK's filtering behaviour itself, or when you specifically need verbose raw output for a particular session. Use `tokenstack shell rtk off` to disable for one session without changing config.

---

## 6. Output Sandboxing

---

### `output_sandboxing.srt`
**Type:** boolean | **Default:** `true` (macOS + Linux only; automatically `false` on Windows)

**What it does:** Enables Anthropic's Sandbox Runtime (`@anthropic-ai/sandbox-runtime`). SRT wraps MCP servers and bash tool calls at the OS level (using `sandbox-exec` on macOS, `bubblewrap` on Linux). It restricts what each tool can access: a file-reading MCP can't accidentally traverse `/` and read thousands of files; a shell command can't access sensitive directories.

**What you gain:** Two benefits in one:
1. **Token governor:** By restricting filesystem access, SRT prevents runaway tool calls that consume enormous context (e.g., an MCP that accidentally reads all of `node_modules` because a glob pattern was too broad).
2. **Security:** Limits blast radius if a rogue or compromised MCP server tries to read files outside the project.

**What you lose:** Slight performance overhead per tool call (~5ms). Some tools that legitimately need broad filesystem access must have explicit allow-paths configured in `~/.tokenstack/srt-policy.json`.

**Windows:** SRT is not available natively on Windows. The Windows installer skips this automatically and logs: `[SKIP] srt — requires macOS/Linux. Consider WSL2 for SRT support.`

---

### `output_sandboxing.context_mode`
**Type:** boolean | **Default:** `true` (Claude Code only; has no effect with Copilot CLI)

**What it does:** Enables `context-mode` — the most powerful session extension tool in the stack. When a tool produces a large output (test results, file contents, API responses), context-mode intercepts it, indexes the full content into a local BM25 knowledge base, and returns only a compact summary to the conversation. The full content remains searchable via `ctx_search`.

**What you gain:** This is the #1 reason sessions extend from 30 minutes to 3+ hours. Without context-mode, every large tool output permanently occupies context window space for the rest of the session. With context-mode, large outputs cost ~100-200 tokens (the summary) regardless of their original size.

**Concrete example:** Running a test suite that produces 50,000 tokens of output:
- Without context-mode: those 50,000 tokens stay in context for every subsequent turn.
- With context-mode: the agent gets a 150-token summary. If it needs specific details, it calls `ctx_search("failing test name")` and gets just the relevant section.

**What you lose:** Indirect access to tool outputs (must use `ctx_search` for detail). In rare cases the BM25 summary omits a specific detail and the agent needs a follow-up search.

**Why Claude Code only:** context-mode is a Claude Code plugin. GitHub Copilot CLI has no plugin system. The proxy's thrash-cache and diff-enforcer provide partial mitigation for Copilot CLI sessions (see §1.4 and §1.5).

---

## 7. Budget Routing

---

### `budget_routing.litellm`
**Type:** boolean | **Default:** `false` (opt-in)

**What it does:** Enables LiteLLM as a model router in the proxy pipeline. Instead of all turns going to the same model, LiteLLM classifies each turn by complexity and routes cheap turns (formatting, simple renames, status checks, yes/no questions) to a fast/cheap model and complex turns (architecture, implementation, analysis) to the full model.

**What you gain:** 30-40% cost reduction with no quality loss on complex tasks. Claude Haiku 4.5 costs approximately 10% of Claude Opus 4.7 at the same token volume. If 40-50% of turns in a typical session are "cheap" turns, routing them to Haiku saves substantial cost.

**What you lose:** Slightly more complex proxy pipeline (Headroom → LiteLLM → provider). Rare misclassifications (a turn you expected to be cheap gets routed to Haiku and gives a lower-quality response). Easy to fix: `tokenstack routing report` shows which turns were routed where.

**When to enable:** High-volume coding sessions. Teams with usage budgets. When you're comfortable with the stack and want the next layer of savings.

```bash
tokenstack enable budget_routing.litellm
```

---

### `budget_routing.cheap_model`
**Type:** string | **Default:** `"claude-haiku-4-5"`

**What it does:** The model used for low-complexity turns when LiteLLM routing is active.

**When to change:** If Anthropic releases a newer Haiku (e.g., `claude-haiku-4-6`) and you want to use it. Also supports non-Anthropic models if you're experimenting: `gpt-5.4-mini`, etc.

---

### `budget_routing.complex_model`
**Type:** string | **Default:** `"claude-opus-4-7"`

**What it does:** The model used for high-complexity turns when LiteLLM routing is active.

**When to change:** To pin to a specific model version, or to route complex turns to `claude-sonnet-4-6` for a middle-ground cost/quality tradeoff.

---

### `budget_routing.cheap_threshold`
**Type:** float (0.0–1.0) | **Default:** `0.3`

**What it does:** The complexity classifier score below which a turn is routed to `cheap_model`. Score 0.0 = trivially simple, 1.0 = maximally complex.

**Tuning guidance:**
- `0.2` — only the most obvious simple turns go to Haiku (very conservative)
- `0.3` — default, good balance
- `0.5` — roughly half of turns go to Haiku (aggressive, watch quality)

Check routing decisions with `tokenstack routing report --last-session` to see if the threshold is calibrated well for your workflows.

---

## 8. Output Style + Enforcement

---

### `output_style.caveman_rules`
**Type:** boolean | **Default:** `true`

**What it does:** Injects the "Caveman output protocol" into the managed section of `~/.claude/CLAUDE.md` and the repo-level `AGENTS.md`. Instructs the model to respond in terse, direct language: no preambles ("I'll now help you with..."), no summaries of what it just did, no emoji, code diffs only (not full unchanged files), bullets over prose.

**What you gain:** 48-75% reduction in assistant output tokens depending on your model and task type. The model reads its own prior responses on every turn — verbose responses compound in cost. A 9× more concise response (as shown in Caveman's benchmarks) saves 89% on response token re-reads across the session.

**What you lose:** Responses feel blunter. Some developers prefer a more conversational style. If you want a middle ground, edit the `Output Protocol` section inside the managed markers in your CLAUDE.md to soften it.

---

### `output_style.hooks`
**Type:** boolean | **Default:** `true`

**What it does:** Installs three Node.js enforcement hooks for Claude Code (`.mjs` files in `~/.claude/hooks/`):

| Hook | Triggers on | What it does |
|------|-------------|--------------|
| `cbm-discovery-gate.mjs` | `PreToolUse: Read, Grep, Glob` | Blocks the first raw file read of each session and asks the agent to use Serena first. After Serena has been used once, the gate disarms and all subsequent reads are allowed. |
| `bash-ban-raw-tools.mjs` | `PreToolUse: Bash` | Blocks `cat`, `grep`, `find`, `head`, `tail`, `wc` as raw commands. Redirects the agent to use Serena's `search_for_pattern_in_files` or RTK-wrapped equivalents. |
| `session-reminder.mjs` | `SessionStart, /clear, /compact` | Re-injects the Serena-first and terse-output protocol at the start of each session or after a context reset. |

**What you gain:** The hooks are the difference between theoretical savings and actual savings. Without enforcement, agents default to `cat file.py` because it's the path of least resistance. The hooks make the efficient path the only path.

**What you lose:** Occasional friction when you explicitly WANT raw output. Override with `tokenstack hooks disable --for-session` to disable enforcement for one session without changing config permanently.

**Windows compatibility:** All hooks are Node.js `.mjs` files — not bash. They work identically on Windows, macOS, and Linux.

**Why hooks don't work in Copilot CLI:** Copilot CLI has no PreToolUse hook system. Enforcement there comes from AGENTS.md prompt rules + proxy-level interception (see proxy.headroom diff_enforcer and the Copilot-specific enforcement section).

---

## 9. Learning

---

### `learning.headroom_learn`
**Type:** boolean | **Default:** `true`

**What it does:** Enables `headroom learn` — Headroom's session failure mining feature. At the end of each session (and on `headroom learn run`), it analyses recent failed turns (errors, rejected answers, repeated retries), identifies patterns, and generates proposed rule additions for `CLAUDE.md` and `AGENTS.md`.

**What you gain:** Over time, the stack learns your specific codebase's conventions, common failure patterns, and useful shortcuts. Rules like "in this project, always check the migrations folder before editing models" accumulate automatically.

**Critical design: proposals only, never auto-write.** `headroom learn` NEVER modifies your files directly. It writes proposals to `~/.headroom/proposals/YYYY-MM-DD.md`. You review with `headroom learn review` and approve/reject each one. Only approved rules are appended (inside managed markers) to your config files.

**What you lose:** None, unless you ignore the proposals queue and it grows stale.

**Rule TTL:** Each learned rule has a 30-day expiry. If it isn't triggered and reinforced within 30 days, `tokenstack update --check` flags it for review. Prevents stale rules from accumulating.

**When to disable:** Never, really — it's passive and non-intrusive. Only disable if you have strict policy against automated file suggestions.

---

## 10. Observability

---

### `observability.helicone`
**Type:** boolean | **Default:** `false` (opt-in)

**What it does:** Routes API calls through a self-hosted Helicone instance (Docker) before Headroom forwards them to the provider. Helicone logs every request+response with token counts, cost, latency, cache hit/miss, and model used. Exposes a real-time dashboard at `http://localhost:47001`.

**What you gain:** The most detailed token observability available. Per-request breakdowns (not just session totals), cache hit rate trends, cost attribution by session/workspace/model, anomaly detection ("this session used 10× normal tokens — why?"). Useful for identifying which specific tasks or patterns are costing the most.

**What you lose:** Another Docker container (~300MB RAM). An additional proxy hop (adds ~3ms latency). Setup takes ~5 minutes.

**When to enable:** After the rest of the stack is stable and you want to understand precisely where the remaining tokens go. `tokenstack setup helicone` runs the Docker container and reconfigures the proxy chain.

```bash
tokenstack enable observability.helicone
tokenstack setup helicone   # starts Docker container + reconfigures proxy
```

---

### `observability.token_optimizer`
**Type:** boolean | **Default:** `false` (Claude Code only) — **opt-in only**

**License note:** token-optimizer is [PolyForm Noncommercial](https://polyformproject.org/licenses/noncommercial/1.0.0/) licensed, which conflicts with Myelin's MIT license and its distributability to companies/teams. It is never installed by default and must be explicitly enabled by the user, who is responsible for confirming their own use case complies with that license.

**What it does:** Installs the token-optimizer Claude Code plugin. Shows a live dashboard in Claude Code's status area: current session token count, estimated cost, context quality score (0.0–1.0), and autocompaction events.

**What you gain:** Real-time visibility into the pre-proxy token state. While Headroom's `headroom perf` shows post-compression numbers, token-optimizer shows what Claude Code itself is tracking — useful for spotting context quality degradation before it causes a session failure.

**Context quality score:** A score below 0.6 means the context is getting noisy (lots of repeated content, stale references). This is your signal to run `/compact` proactively.

**To enable (non-commercial use only):**
```
tokenstack enable observability.token_optimizer
```

---

### `observability.ai_engineering_coach`
**Type:** boolean | **Default:** `true`

**What it does:** Configures the Microsoft AI Engineering Coach VS Code extension. It reads your local AI session logs (never sends data externally) and detects 45 anti-patterns across five categories:
- Prompt quality (vague instructions, missing context)
- Session hygiene (not using /clear, overly long sessions)
- Code review patterns (not using diff-based context)
- Tool mastery (using raw file reads instead of MCP tools)
- Context management (ignoring compaction signals)

**What you gain:** A weekly report of your top anti-patterns with specific improvement suggestions. The skill finder identifies prompts you use repeatedly and suggests turning them into reusable skills.

**What you lose:** Requires VS Code (not available in terminal-only setups). Extension reads your session log directory — review its file access if you have privacy concerns.

---

## 11. Optional Tools

---

### `stacklit.enabled`
**Type:** boolean | **Default:** `false`

**What it does:** When enabled via `tokenstack init --with-stacklit`, generates `stacklit.json` (machine-readable repo index) and `DEPENDENCIES.md` (Mermaid dependency diagram) and commits them to your repo. A GitHub Action keeps them fresh on every push.

**What you gain:** A GitHub-rendered, human-readable, PR-reviewable snapshot of your repo's architecture. Useful for onboarding, architecture reviews, and sharing context with team members who don't use TokenStack.

**What you lose:** Stacklit artifacts become stale between CI runs. When Serena (live graph) and Stacklit (committed snapshot) disagree, Serena always wins for agent decisions — Stacklit is for humans.

**When to enable:** Team repos where the GitHub-visible dependency map has value. Do NOT enable for personal scratch repos.

```bash
tokenstack init --with-stacklit   # generates files + installs CI workflow
```

---

### `semgrep.enabled`
**Type:** boolean | **Default:** `false`

**What it does:** Configures Semgrep as an MCP tool for architectural rule enforcement and security pattern detection.

**What you gain:** Unlike ast-grep (which matches structure) and Semble (which matches meaning), Semgrep evaluates architectural rules: "no direct database access outside the repository layer", "all HTTP client calls must go through our wrapper", "find all deprecated API usages that need migration". Semgrep's rule ecosystem also covers security patterns (SQL injection paths, XSS vectors, hardcoded credentials).

**When to enable:** Teams with explicit architectural rules that need enforcement. Security-focused agents. Codebase migrations where you need to find every instance of a pattern.

```bash
tokenstack init --with-semgrep    # installs + configures per repo
```

---

## 12. Environment Variables Reference

These override config file values (env vars take precedence over config.yaml).

| Variable | Config equivalent | Purpose |
|----------|------------------|---------|
| `HEADROOM_PORT` | `proxy.headroom.port` | Proxy port (temporary override without changing config) |
| `HEADROOM_SSL_VERIFY` | — | `true`/`false`/`/path/to/cert.pem` — SSL verification mode |
| `HEADROOM_CA_BUNDLE` | — | Path to corporate CA bundle (appended to system store, not replaced) |
| `HEADROOM_CLIENT_CERT` | — | Path to client certificate (mTLS environments) |
| `HEADROOM_CLIENT_KEY` | — | Path to client private key (mTLS environments) |
| `HTTPS_PROXY` | `proxy.headroom.corporate_proxy` | Standard upstream proxy (auto-detected, sets corporate_proxy) |
| `HTTP_PROXY` | — | HTTP-specific upstream proxy |
| `NO_PROXY` | — | Comma-separated hostnames to bypass proxy |
| `NODE_EXTRA_CA_CERTS` | — | Extra CAs for Node.js (Claude Code runtime). Auto-set from HEADROOM_CA_BUNDLE |
| `REQUESTS_CA_BUNDLE` | — | Extra CAs for Python (LLMLingua-2, mem0). Auto-set from HEADROOM_CA_BUNDLE |
| `SSL_CERT_FILE` | — | Alternative Python CA bundle path |
| `GIT_SSL_CAINFO` | — | CA bundle for git operations. Auto-set from HEADROOM_CA_BUNDLE |
| `TOKENSTACK_PROFILE` | — | Override active profile: `proxy`, `mcp`, `minimal` |
| `TOKENSTACK_INDEX_TIER` | `index_tier` | Override index tier for this session |
| `TOKENSTACK_DISABLE_HOOKS` | — | Set to `1` to disable enforcement hooks for current session |

**Auto-propagation:** When `HEADROOM_CA_BUNDLE` is set (or auto-detected from your system's CA store), TokenStack automatically sets `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, and `GIT_SSL_CAINFO` to the same path. You only need to set one.

---

## 13. Quick Recipes

### "I'm on a memory-constrained machine (8GB RAM)"
```yaml
index_tier: light
code_discovery:
  serena:
    lsp:
      typescript: false
      python: true
      rust: false
      go: false
  semble: false
budget_routing:
  litellm: true   # offset memory savings with cost savings
```
Expected RAM: ~250-350MB for the full stack.

---

### "I'm on a corporate network with SSL inspection"
```bash
# Auto-detection should handle this, but if not:
export HEADROOM_CA_BUNDLE=/path/to/corporate-ca.pem
tokenstack config set proxy.headroom.corporate_proxy http://proxy.corp.com:8080
tokenstack restart   # restarts proxy with new SSL config
tokenstack verify    # confirms connectivity to Anthropic through the proxy
```

---

### "I want to use a different port (8787 is taken)"
```bash
tokenstack config set proxy.headroom.port 9090
# TokenStack automatically:
# - Updates ANTHROPIC_BASE_URL and OPENAI_BASE_URL
# - Regenerates launchd/systemd/Task Scheduler definition
# - Restarts the proxy on the new port
# - Verifies health on the new port
```

---

### "I want maximum token savings, money is no object"
```yaml
proxy:
  headroom:
    backend: llmlingua-2
    thrash_cache: true
    diff_enforcer: true
index_tier: full
conversation_memory:
  mem0: true
output_sandboxing:
  context_mode: true
observability:
  helicone: true    # so you can measure exactly what you're saving
```

---

### "I want maximum savings AND minimum cost"
Enable everything above PLUS:
```yaml
budget_routing:
  litellm: true
  cheap_model: claude-haiku-4-5
  cheap_threshold: 0.4   # more aggressive routing
```

---

### "I'm doing a code review session only"
```bash
# Enable diff-heavy tooling, disable code indexing overhead
tokenstack config set index_tier light
tokenstack config set code_discovery.semble false
# Use: git_diff, git_show, git_blame heavily
# repomix --include "$(git diff --name-only origin/main)"  ← before session start
```

---

### "Copilot CLI only — no Claude Code"
```bash
tokenstack install --copilot-only
# Installs: Serena, Semble, ast-grep, mcp-git, mem0, RTK, headroom proxy
# Skips: context-mode, token-optimizer, Claude Code hooks
# Sets: OPENAI_BASE_URL in ~/.copilot/env (or shell profile)
```

---

### "Reset to defaults and start over"
```bash
tokenstack config reset                # restores defaults (backs up current config)
tokenstack verify                      # confirms stack is healthy
tokenstack stats --last-session        # sanity check savings are working
```

---

*Reference version: 1.0 · Spec: 2026-07-06-tokenstack-design.md*
