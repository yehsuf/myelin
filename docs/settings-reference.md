# Myelin Settings Reference

Every setting in `~/.myelin/config.yaml` explained — what it does, what you gain, what you lose, and when to change it.

**How to change a setting:**
```bash
myelin config show
myelin config show --path proxy.headroom.port
myelin config set proxy.headroom.port 9999
myelin config get proxy.headroom.port
myelin config reset
```

**Port changes regenerate downstream config automatically** — you never manually update `ANTHROPIC_BASE_URL` or service definitions.

---

## 0. Cross-Platform Config Notes

- **Config file location:** the path is always `~/.myelin/config.yaml`, resolved via `src/config/reader.mjs` using your home directory on every OS. Examples: macOS `/Users/<user>/.myelin/config.yaml`, Linux `/home/<user>/.myelin/config.yaml`, Windows `C:\Users\<user>\.myelin\config.yaml`.
- **Config commands:** `myelin config show`, `myelin config show --path <dotted.key>`, `myelin config set <dotted.key> <value>`, `myelin config get <dotted.key>`, and `myelin config reset` use the same syntax on macOS, Linux, and Windows (`src/cli/config-cmd.mjs`).
- **WSL now bridges to Windows service management correctly:** when Myelin is running inside Windows Subsystem for Linux, it detects WSL explicitly and routes service management through the existing Windows PowerShell-based path instead of treating the session as native Linux. The WSL-specific home-directory lookup is read-only interop for path resolution only; Myelin still never auto-invokes WSL from a native Windows process, and it never silently crosses the WSL/Windows trust boundary without an explicit `myelin install` or `myelin verify` command.
- **Important limitation:** `config set`/`config get` do not validate keys against the schema — typos or removed keys are silently accepted or return `undefined`, so double-check spelling against this file or `src/config/schema.mjs`. As the schema evolves, stale removed keys can also linger in the physical file; run `myelin config prune --dry-run` to preview cleanup, or `myelin config prune` to remove them.
- **Where platform differences actually live:** OS-specific behavior is in the service/install layer, where `src/service/index.mjs` dispatches to `src/service/launchd.mjs`, `src/service/systemd.mjs`, or `src/service/windows.mjs`; CA-bundle and certificate trust handling also differs there. These are internal implementation details, not user-facing config toggles.
- **`output_style.*` is cross-platform:** the `code_navigation`, `token_efficiency`, `caveman_rules`, and `hooks` features are plain Node.js `.mjs` hooks/config writers and behave the same on macOS, Linux, and Windows (see §7).

---

## Table of Contents

0. [Cross-Platform Config Notes](#0-cross-platform-config-notes)
1. [Proxy Settings](#1-proxy-settings)
2. [Index Tier](#2-index-tier)
3. [Code Discovery](#3-code-discovery)
4. [Shell Compression](#4-shell-compression)
5. [Native Compression](#5-native-compression)
6. [Output Sandboxing](#6-output-sandboxing)
7. [Output Style + Enforcement](#7-output-style--enforcement)
8. [Optional Integrations](#8-optional-integrations)
9. [Environment Variables Reference](#9-environment-variables-reference)
10. [Quick Recipes](#10-quick-recipes)
11. [Appendix: Planned / Not Yet Implemented](#appendix-planned--not-yet-implemented)

---

## 1. Proxy Settings

The proxy is the backbone of TokenStack. It sits between your AI agent and the LLM API, compressing everything that leaves your machine before Anthropic or GitHub Copilot ever sees it.

---

### `proxy.engine`
**Type:** `'headroom' | 'headroom_lite'` | **Default:** `headroom`

**What it does:** Selects the one compression backend Myelin installs, starts, probes, and supervises. The non-selected engine is never installed, started, probed, watched, or used as a fallback.

- **`headroom`** (default): Python Headroom. Requires Python 3.10+. Supports configurable backends (`kompress-base`, `llmlingua-2`) and Python-specific settings under `proxy.headroom`.
- **`headroom_lite`**: Node-native Headroom Lite. No Python dependency. Fast cold-start, deterministic lossless transforms. Does not use `proxy.headroom.backend`; Lite settings live under `proxy.headroom_lite`.

**When Lite is selected and the Lite binary is missing, Myelin reports a Lite error. It does not fall back to Python Headroom.**

```yaml
proxy:
  engine: headroom_lite   # or: headroom (default)
```

---

### `proxy.headroom_lite.port`
**Type:** integer | **Default:** `8790` | **Range:** 1024–65535

**What it does:** Port for the Headroom Lite primary instance. Only active when `proxy.engine: headroom_lite`.

```yaml
proxy:
  headroom_lite:
    port: 8790
```

---

### `proxy.headroom.enabled`
**Type:** boolean | **Default:** `true` | **Active when:** `proxy.engine: headroom`

**What it does:** Enables Python Headroom. When `proxy.engine` is `headroom` (the default) and this is `true`, Claude Code API calls pass through the Python Headroom proxy before reaching the LLM provider. Has no effect when `proxy.engine: headroom_lite`.

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

**What happens when you change it:** `myelin config set proxy.headroom.port 9090` automatically:
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
**Type:** string | **Default:** `"kompress-base"` | **Options:** `"kompress-base"`, `"llmlingua-2"` | **Active when:** `proxy.engine: headroom`

**What it does:** Selects the compression model used by Python Headroom. Has no effect when `proxy.engine: headroom_lite`.

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

### `proxy.windows_service.manager`
**Type:** `'registry' | 'winsw'` | **Default:** `'registry'` (unchanged, current behavior)

**What it does:** Controls HOW myelin manages its Windows background processes (Headroom, mitmproxy, Copilot-Headroom).

- **`registry`** (default): the original mechanism — starts each process via `Start-Process` (hidden window) plus a `HKCU\...\Run` registry key so it restarts on next login. Does **not** auto-restart on a crash; only on next login. This is exactly what every existing install already does — the default never changes this behavior for you.
- **`winsw`**: switches to a real Windows Service via [WinSW](https://github.com/winsw/winsw), which auto-restarts on crash/exit (escalating delay: 5 sec, then 30 sec forever after; failure count resets after 1 hour of stable running) — the Windows equivalent of launchd's `KeepAlive`/systemd's `Restart=always`. This is a genuine behavioral change, unvalidated on real Windows at the time of writing — opt-in only.

**Why opt-in:** switching process-management mechanisms is inherently higher-risk than a simple feature flag — do not flip this on a machine you depend on until you've validated it works there first.

```yaml
proxy:
  windows_service:
    manager: winsw
```

---

### `proxy.windows_service.watchdog_enabled` / `watchdog_interval_minutes`
**Type:** boolean / integer | **Default:** `false` / `2` | **Windows only, requires `manager: winsw`**

**What it does:** A SECOND recovery layer on top of WinSW: a Scheduled Task that periodically calls the local Headroom `/health` endpoint and, if it stops responding, restarts the corresponding WinSW service.

**Why a second layer exists:** WinSW already handles the crash/exit case (`onfailure restart`). It cannot detect the "process still exists but the HTTP service is hung" case, because the process never exited. The watchdog closes that gap by checking real liveness instead of mere process existence.

**What it watches:** The selected-engine primary service, plus the selected-engine Copilot instance if `proxy.copilot_headroom.enabled` is `true`.

**Has no effect unless `manager` is `winsw`** — a registry-based install has no WinSW service for the watchdog to restart.

```yaml
proxy:
  windows_service:
    manager: winsw
    watchdog_enabled: true
    watchdog_interval_minutes: 1   # faster detection/recovery
```

---

### `proxy.copilot_headroom.enabled` / `.port`
**Type:** boolean / integer | **Default:** `false` / `8788`

**What it does:** Enables an isolated second instance of the *selected* engine for Copilot CLI traffic. `proxy.copilot_headroom` names the role, not an engine: `proxy.engine` determines which engine both the primary and Copilot instances use.

When enabled, Copilot traffic follows this loopback path:

```
Copilot CLI → MITM ingress (:8888) → selected-engine Copilot instance (:8788) → MITM egress (:8889) → Copilot API
```

The Copilot instance has isolated cache, workspace, log, and telemetry state from the primary instance. MITM is the sole real Copilot-provider egress owner; the engine instance targets only the MITM loopback egress port and never receives a configured Copilot provider URL. Requests reaching MITM egress without the private loopback headers are rejected.

**When Lite is selected,** a missing Lite binary is reported as a Lite error — Myelin never starts Python Headroom as a substitute.

```bash
myelin config set proxy.copilot_headroom.enabled true
myelin install
myelin verify   # shows primary and copilot selected-engine rows plus MITM
```

```yaml
proxy:
  engine: headroom_lite
  headroom_lite:
    port: 8790
  copilot_headroom:
    enabled: true
    port: 8788
  mitm:
    port: 8888
    egress_port: 8889
```

---

### `proxy.mitm.egress_port`
**Type:** integer | **Default:** `8889` | **Range:** 1024–65535

**What it does:** Port for the MITM loopback egress listener. The selected-engine Copilot instance targets `http://127.0.0.1:<egress_port>` rather than the real Copilot provider URL. MITM restores the original destination at this listener before forwarding to the provider.

```yaml
proxy:
  mitm:
    egress_port: 8889
```

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

**Tip:** Use `myelin status` to see current RAM usage per LSP. Use `full` for your primary project, `light` for quick scripts or unfamiliar repos.

```bash
myelin config set index_tier light    # reduce memory pressure
myelin config set index_tier full     # maximum code intelligence
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
myelin init --enable-lsp rust   # enables rust only for this repo
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

### `code_discovery.codegraph`
**Type:** boolean | **Default:** `false` (opt-in)

**What it does:** Enables codegraph as a function-level dependency graph MCP server, plus a per-repo `codegraph build` step during `myelin init`. Agents can query callers, callees, shortest paths, and blast radius directly instead of reconstructing them from grep/read loops.

**What you gain:** Structural context Serena and Semble do not specialize in: "who calls this function", "what breaks if I change it", "how does A reach B", and "show me the whole dependency chain". Best when an agent is about to edit an existing function and needs impact awareness first.

**What you lose:** Another local index to build per repo, plus a stricter runtime requirement upstream: `@optave/codegraph` currently requires newer Node than TokenStack itself (README badge: 22.6+, current package metadata: 22.12+).

**Why it defaults to OFF:** The integration is safe/local (no network, no telemetry), but it is still brand new in TokenStack. Keep it opt-in until you validate it on your own repos and Node toolchain.

```yaml
code_discovery:
  codegraph: true
```

---

### `code_discovery.mcp_git`
**Type:** boolean | **Default:** `true`

**What it does:** Enables `mcp-server-git` which exposes git operations as MCP tools: `git_diff`, `git_show`, `git_status`, `git_log`, `git_blame`, `git_commit`.

**What you gain:** For code review tasks, an agent calling `git_diff HEAD~1` gets only the changed lines — typically 200-2000 tokens. Without this, the agent reads the current file (potentially 5000 tokens) AND the previous version (another 5000 tokens) to understand what changed. 10× smaller context for review tasks.

**Also enables:** `git_blame` for debugging ("when was this introduced?"), `git_log` for context ("what else changed at the same time?"). These are the gaps from the original `mcp-server-git` that are now included.

---

### `code_discovery.cbm_fallback.enabled`
**Type:** boolean | **Default:** `true`

**What it does:** Keeps CBM (codebase-memory-mcp) installed as a fallback. When the environment limits MCP server count below `mcp_limit_threshold`, Myelin automatically switches from Serena+Semble to CBM-only.

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

## 4. Shell Compression

---

### `shell_compression.rtk`
**Type:** boolean | **Default:** `true`

**What it does:** RTK (Rust Token Killer) wraps every shell command executed by the agent and compresses its output before it enters the context window. It understands the output format of 100+ common commands and applies intelligent filtering: `git log` shows only the key fields, `ls -la` omits irrelevant columns, `cargo test` shows only failing tests plus a count, `npm install` collapses verbose package trees to a summary.

**What you gain:** 60-90% reduction on shell output tokens. The most impactful example: `cargo test` with 262 tests produces 4,823 tokens raw → ~500 tokens with RTK. A developer running tests 10 times per session saves ~43,000 tokens just from test output.

**What you lose:** Occasionally RTK's filtering removes a line you needed (e.g., a specific install path printed during `npm install`). RTK preserves all error output by default — failures are never filtered.

**When to disable:** When debugging RTK's filtering behaviour itself, or when you specifically need verbose raw output for a particular session. Use `myelin shell rtk off` to disable for one session without changing config.

---

## 5. Native Compression

These flags control Myelin's own deterministic compression helpers — native reimplementations of the safe, non-ML parts of Headroom added so a machine can keep deterministic compression capability even when Headroom itself must be removed for compliance reasons. They do **not** require a Headroom service or model runtime.

---

### `native_compression.cross_turn_dedup`
**Type:** boolean | **Default:** `true`

**What it does:** Enables Myelin-native cross-turn verbatim deduplication. When a later tool output repeats a large contiguous span that already appeared verbatim earlier in the same conversation, Myelin can replace the later span with an absolute pointer to the earlier turn instead of repeating the bytes again.

**What you gain:** Big savings on the most common "agent forgot it already read this file" pattern: `cat file` → `sed -n 50,100p file` → `git diff` → `cat file` again. Only the earliest copy stays in full; later duplicates collapse to a short in-context reference.

**What you lose:** The repeated block is no longer shown inline a second time — you read the earlier occurrence instead. This is still information-preserving: only verbatim spans already present earlier in the same request are eligible.

**When to disable:** When debugging exact raw tool transcripts and you want every repeated byte shown again verbatim.

---

### `native_compression.adaptive_sizer`
**Type:** boolean | **Default:** `true`

**What it does:** Enables Myelin-native adaptive truncation sizing. Instead of fixed rules like "keep top 20 matches", Myelin tracks cumulative unique bigrams as items are added in importance order, then uses the Kneedle algorithm to find the saturation point where extra items stop adding much new information.

**What you gain:** Better sizing across wildly different workloads. Redundant result lists shrink harder; diverse result lists keep more. This avoids both under-truncating noisy outputs and over-truncating genuinely information-dense ones.

**What you lose:** Slightly less predictability than a hardcoded top-N cap. The sizing is still fully deterministic for the same input order.

**When to disable:** When you are comparing behaviour against a fixed-size truncation baseline and want a constant keep-count for every run.

---

### `native_compression.lossless_compaction`
**Type:** boolean | **Default:** `true`

**What it does:** Enables Myelin-native reversible compaction helpers for grep/ripgrep output, logs, diffs, plain text, and path listings. The compactor keeps each format looking like itself, self-checks its inverse at runtime, and falls back to the original content unchanged if the compacted form is not smaller or cannot be reversed safely.

**What you gain:** Smaller tool output without retrieval markers, model inference, or a Headroom dependency. ANSI color can be dropped from logs, repeated identical lines can collapse, grep results can switch to heading form, and unified diffs can shed non-semantic `index` lines.

**What you lose:** Formatting may become more compact, so byte-for-byte visual shape can differ from the raw tool output. If a round-trip is unsafe, Myelin keeps the original instead.

**When to disable:** When validating exact original formatting or investigating an edge case in the native compactor itself.

---

## 6. Output Sandboxing

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

## 7. Output Style + Enforcement

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

**What you lose:** Occasional friction when you explicitly WANT raw output. Override with `myelin hooks disable --for-session` to disable enforcement for one session without changing config permanently.

**Windows compatibility:** All hooks are Node.js `.mjs` files — not bash. They work identically on Windows, macOS, and Linux.

**Why hooks don't work in Copilot CLI:** Copilot CLI has no PreToolUse hook system. Enforcement there comes from AGENTS.md prompt rules + proxy-level interception (see proxy.headroom diff_enforcer and the Copilot-specific enforcement section).

---

## 8. Optional Integrations

---

### `observability.token_optimizer`
**Type:** boolean | **Default:** `false` (opt-in)

**What it does:** Enables the real `alexgreensh/token-optimizer` integration for Claude Code and GitHub Copilot. On macOS/Linux, Myelin can clone the upstream repo and run its Copilot installer. For Claude Code, Myelin prints the verified slash-command steps, but it cannot automate those in-session commands.

**What you gain:** Bash/command output compression, file re-read delta/skeleton compression, quality scoring, checkpoint/restore support across auto-compaction, a local session SQLite database, and zero-telemetry / zero-network helper behavior.

**What you lose:** Requires Python 3.9+ on PATH. Claude Code still needs a one-time manual `/token-optimizer` setup inside the session. Native Windows cannot be automated here — for Copilot CLI you must run the upstream installer from inside WSL.

> **License:** PolyForm Noncommercial License 1.0.0 (`https://polyformproject.org/licenses/noncommercial/1.0.0`). Free for personal, noncommercial, educational, and government use. Company/commercial use requires contacting the author for a separate license.

**Warning behavior:** Myelin will print this license notice again immediately before performing any install action, regardless of this config flag's value — enabling the flag is not implicit consent to skip the warning.

**When to enable:** Sessions where you want upstream token-efficiency hooks and diagnostics in addition to Myelin's own proxy/hook stack.

```bash
myelin config set observability.token_optimizer true
# macOS/Linux: re-run install to let Myelin clone + run the Copilot installer
myelin install
```

**Claude Code (manual, not automatable by Myelin):**

```text
/plugin marketplace add alexgreensh/token-optimizer
/plugin install token-optimizer@alexgreensh-token-optimizer
/token-optimizer
```

**GitHub Copilot CLI (automatable on macOS/Linux, manual on Windows/WSL):**

```bash
git clone --depth 1 https://github.com/alexgreensh/token-optimizer.git ~/.myelin/token-optimizer
cd ~/.myelin/token-optimizer
bash install.sh --copilot
TOKEN_OPTIMIZER_RUNTIME=copilot python3 skills/token-optimizer/scripts/measure.py copilot-doctor
```

On Windows, run the same Copilot commands from inside a **WSL shell**. Myelin will not try to invoke WSL for you automatically.

---

### `budget_routing`

| Key | Default | Description |
|-----|---------|-------------|
| `litellm` | `false` | Enable opt-in LiteLLM proxy config generation and package install with the Headroom pre-call guardrail. Re-run `myelin install` after enabling. |
| `litellm_port` | `4000` | Port for the LiteLLM proxy. |
| `cheap_model` | `claude-haiku-4-5` | Model used for low-complexity requests. |
| `complex_model` | `claude-sonnet-4-6` | Model used for high-complexity requests. |
| `cheap_threshold` | `0.3` | Complexity score below which the cheap model is used. Phase 1 stores the threshold only; routing policy enforcement comes later. |

**Enable LiteLLM routing:**
1. `myelin config set budget_routing.litellm true`
2. `myelin install` — installs `litellm[proxy]` into `~/.myelin/venv` and writes `~/.myelin/litellm-config.yaml`
3. Start LiteLLM manually: `~/.myelin/venv/bin/python -m litellm --config ~/.myelin/litellm-config.yaml --port 4000`
4. Set `ANTHROPIC_BASE_URL=http://127.0.0.1:4000` in your shell profile

The generated LiteLLM config wires the native `headroom` guardrail in `pre_call` mode to `http://127.0.0.1:<proxy.headroom.port>/v1/compress`, so the existing Headroom sidecar stays the compression contract while LiteLLM handles model routing. When this flag is enabled, Myelin also sets `MYELIN_COMPRESS=0` on the mitmproxy service leg to avoid double-compressing LiteLLM-forwarded requests.

---

### `copilot_hud.enabled`
**Type:** boolean | **Default:** `false` (opt-in)

**What it does:** Installs the `griches/copilot-hud` GitHub Copilot CLI status-line plugin. After its one-time in-session setup, Copilot shows your project path, git branch, live context usage bar, token breakdown, AIU cost, tool activity, and background agents at the bottom of the session.

**What you gain:** Real-time visibility into Copilot CLI context burn without leaving the terminal. This is the fastest way to see when a session is approaching context limits before performance degrades.

**What you lose:** Requires Copilot CLI v1.0.12+, Node.js 18+, `jq`, `copilot --experimental`, and one manual in-session `/copilot-hud:setup`. Myelin can install the plugin, but it cannot automate that interactive setup step.

**When to enable:** Long Copilot CLI sessions where you want live token/cost awareness as part of token-efficiency tuning.

```bash
myelin config set copilot_hud.enabled true
# re-run install/update, then:
copilot --experimental
# inside the session:
# /copilot-hud:setup
```

---

## 9. Environment Variables Reference

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
| `REQUESTS_CA_BUNDLE` | — | Extra CAs for Python-based tooling. Auto-set from HEADROOM_CA_BUNDLE |
| `SSL_CERT_FILE` | — | Alternative Python CA bundle path |
| `GIT_SSL_CAINFO` | — | CA bundle for git operations. Auto-set from HEADROOM_CA_BUNDLE |
| `MYELIN_PROFILE` | — | Override active profile: `proxy`, `mcp`, `minimal` |
| `MYELIN_INDEX_TIER` | `index_tier` | Override index tier for this session |

**Auto-propagation:** When `HEADROOM_CA_BUNDLE` is set (or auto-detected from your system's CA store), Myelin automatically sets `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, and `GIT_SSL_CAINFO` to the same path. You only need to set one.

---

## 10. Quick Recipes

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
```
Expected RAM: ~250-350MB for the full stack.

---

### "I'm on a corporate network with SSL inspection"
```bash
# Auto-detection should handle this, but if not:
export HEADROOM_CA_BUNDLE=/path/to/corporate-ca.pem
myelin config set proxy.headroom.corporate_proxy http://proxy.corp.com:8080
myelin restart   # restarts proxy with new SSL config
myelin verify    # confirms connectivity to Anthropic through the proxy
```

---

### "I want to use a different port (8787 is taken)"
```bash
myelin config set proxy.headroom.port 9090
# Myelin automatically:
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
output_sandboxing:
  context_mode: true
```

---

### "I'm doing a code review session only"
```bash
# Enable diff-heavy tooling, disable code indexing overhead
myelin config set index_tier light
myelin config set code_discovery.semble false
# Use: git_diff, git_show, git_blame heavily
# repomix --include "$(git diff --name-only origin/main)"  ← before session start
```

---

### "Copilot CLI only — no Claude Code"
```bash
myelin install --copilot-only
# Installs: Serena, Semble, ast-grep, mcp-git, RTK, headroom proxy
# Skips: context-mode, Claude Code hooks
# Sets: OPENAI_BASE_URL in ~/.copilot/env (or shell profile)
```

---

### "Reset to defaults and start over"
```bash
myelin config reset                # restores defaults (backs up current config)
myelin verify                      # confirms stack is healthy
myelin stats --last-session        # sanity check savings are working
```

---

## 11. Appendix: Planned / Not Yet Implemented

These ideas were researched or designed, but they are **not** valid config keys in the current schema and are not currently settable via `myelin config set`.

- `conversation_memory.mem0` — Would extract and reinject conversation facts between turns; rejected because mem0 silently calls OpenAI by default (not free), and a local SQLite + summarization approach was the recommended alternative instead.
- `observability.helicone` — Would add a request observability dashboard for token/cost tracing; rejected because the self-hosted Docker stack adds substantial operational overhead and roughly 750MB-1.3GB of RAM usage.
- `observability.ai_engineering_coach` — Would generate weekly prompt-quality and anti-pattern reports; not yet built because it depends on a VS Code extension with local file-access review/privacy considerations.
- `stacklit.enabled` — Would generate `stacklit.json` and `DEPENDENCIES.md` repo snapshots; `--with-stacklit` existed in the installer but was a stubbed no-op.
- `semgrep.enabled` — Would wire Semgrep into the toolchain for structural/security rules; no implementation or install path exists today.
- `learning.headroom_learn` — Would mine failed sessions for reusable rule proposals to append to `CLAUDE.md`; designed, but never built.
- `output_sandboxing.srt` — Would have wrapped tool execution in Anthropic's sandbox runtime with a claimed Windows skip-path; no implementation exists on any platform, and there is no corresponding npm dependency.

---

*Reference version: 1.0 · Spec: 2026-07-06-tokenstack-design.md*
