# Myelin Backlog

> **This file is the single source of truth for the backlog across all sessions, agents, and machines.**
> Agent SQL todos are session-local and ephemeral — they are NOT visible to other sessions.
> When you finish work or triage new items, update this file and commit to `main` so the next session picks it up.
> **⛔ DO NOT EDIT TASK ROWS MANUALLY. Use `myelin-claim`, `myelin-unclaim`, `myelin-done` scripts only.**

## Status Values

- `in-progress` -- approved work with an active implementation branch.
- `ready` -- implementation exists and needs rebase, review, or validation.
- `planned` -- approved priority, no implementation started.
- `blocked` -- cannot proceed until the stated dependency is resolved.
- `done` -- merged to `main`.

---

## Development Protocols (read before starting any work)

### Worktree protocol
1. **Never edit `main` directly** (except emergency one-liner hotfixes with explicit approval).
2. Create a worktree + feature branch before any implementation:
   ```bash
   myelin worktree add feat/<id>
   cd ~/tokenstack-wt-feat-<id>
   ```
3. Push branch to `origin` periodically during development.
4. Run full test suite on **all 3 machines** before opening a PR:
   - Mac: `npm test`
   - Linux: `ssh muc-lhvsuz 'cd ~/.myelin/repo && git fetch origin && git checkout feat/<branch> && npm test'`
   - Windows: `ssh -i ~/.ssh/myelin_windows_ed25519 -o IdentitiesOnly=yes yehsuf@yeh-legion.local "cd %USERPROFILE%\.myelin\repo && git fetch origin && git checkout feat/<branch> && npm test"`
5. Rebase onto latest `origin/main` immediately before pushing for PR.
6. **Open a PR — never merge directly.** Ask the user to approve the merge.
7. Clean up worktree after merge: `myelin worktree remove feat/<id>`.

### Code review protocol
- Every non-trivial change requires a 3-model code review (Opus + GPT + Gemini) before merge.
- Use the `multi-round-review` skill for high-stakes architectural changes.
- CR findings rated Critical or Important must be fixed before merge.

### Deploy protocol
- After merge to `main`, deploy to all 3 machines:
  - Mac: `myelin update --channel main`
  - Linux: `ssh muc-lhvsuz 'myelin update --channel main'`
  - Windows: `ssh -i ~/.ssh/myelin_windows_ed25519 -o IdentitiesOnly=yes yehsuf@yeh-legion.local "..."`
- Run `myelin verify` on each machine after deploy.
- **DO NOT declare the task done until `myelin verify` passes on all deployed machines.**

### Pre-merge testing protocol (runtime/pointer/update changes)
For any PR touching `src/update/update-orchestrator.mjs`, `src/runtime/release-store.mjs`,
`src/runtime/stage-main.mjs`, or `src/cli/update.mjs`:

**Unit tests alone are NOT sufficient.** These paths are heavily mocked in tests. Required before merge:

1. **Integration test** — the PR must include a test that:
   - Calls the REAL function (not a mock) with real fs + temp dirs
   - Asserts BOTH `current.json` AND `current` symlink match after the operation
   - Example: `syncReleasePair` tests in `test/update-orchestrator.test.mjs`

2. **Smoke test on a real machine** — in a temp `MYELIN_DIR`:
   ```bash
   export MYELIN_DIR=$(mktemp -d)
   # stage initial release manually, then:
   myelin update --channel main
   myelin verify 2>&1 | grep "Managed runtime"
   # Must show: ✓ Managed runtime ... healthy
   ```
   Or use the worktree checkout directly:
   ```bash
   node --test test/update-orchestrator.test.mjs  # must pass including new integration tests
   ```

3. **Never approve a pointer-sync PR based on unit tests alone** — the mock boundary
   for `applyReleasePair` is exactly where the `rootDir` bug hid across PRs #39, #40, #41.

### Backlog hygiene
- Add new items to **Active Work** below when triaged.
- Move to **Recently Completed** when merged; include PR number and commit SHA.
- Update this file in the same PR as the implementation (not a separate cleanup PR).
- Session SQL todos are a scratchpad only — always sync final state back here.
- **Before adding any new item:** propose it first (ID, description, which repo, priority, why it's new — not a duplicate/extension of an existing item). Get explicit user approval. Do not add without approval.

### Task claiming protocol (multi-agent)
> Tools live in `~/.myelin/bin/` (local only, not in repo). Agent identity stored in `~/.myelin/agents/<session-id>.json`.

**⛔ BACKLOG.md IS SCRIPT-MANAGED — DO NOT EDIT MANUALLY.**
All status changes MUST go through the claiming scripts. Direct edits break cross-session state.

**Rules — non-negotiable:**
- **Never start work on a task you have not claimed.** Always `myelin-claim <task-id>` first.
- **One active claim per agent at a time.** Claim blocks until you `myelin-unclaim`.
- **Always unclaim when done, blocked, or handing off.** Don't leave ghost claims.
- **Never edit BACKLOG.md task rows directly** — use `myelin-claim`, `myelin-unclaim`, `myelin-done`.
- Expired claims (heartbeat > TTL 120m) may be force-reclaimed: `myelin-claim <id> --force`.
- On new session: `myelin-claims` to see what's already in flight before picking up work.

**Quick reference:**
```bash
# At the start of each new session:
myelin-agent init <name>          # register THIS session (session-scoped, not machine-scoped)
myelin-agent whoami               # show this session's name
myelin-agent list                 # list all known sessions

# Before starting any work:
myelin-claims                     # check what's already in flight
myelin-claim <task-id>            # claim a task (updates BACKLOG.md → in-progress)

# When done or blocked:
myelin-unclaim [task-id]          # release (restores → planned); default = your only task
myelin-unclaim --all              # release all this session's claims (on exit)
myelin-claims --expire            # clean up expired/dead-session claims
```

**Closing a task as done:**
```bash
myelin-done <task-id> "<pr-evidence>"   # moves row to Recently Completed, removes claim, commits+pushes
# e.g. myelin-done UPDATE-SYNC-001 "PR #39, abc1234"
```

**First-aid — known problems:**

| Problem | Fix |
|---------|-----|
| Forgot to claim before starting | `myelin-claim <id>` now — better late than never; add note in PR |
| Claim file exists but scripts missing (new machine) | Copy scripts from another machine: `scp muc-lhvsuz:~/.myelin/bin/myelin-* ~/.myelin/bin/ && chmod +x ~/.myelin/bin/myelin-*` |
| `myelin-claim` fails: "session not registered" | `myelin-agent init <your-name>` first |
| `COPILOT_AGENT_SESSION_ID` not set | Check `echo $COPILOT_AGENT_SESSION_ID`; if empty, set manually: `export COPILOT_AGENT_SESSION_ID=$(uuidgen)` (session-local only) |
| Stale claim from dead session blocking you | `myelin-claims` to confirm it's expired (>120m), then `myelin-claim <id> --force` |
| Accidentally bypassed scripts (edited BACKLOG directly) | Remove claim file manually: `rm ~/.myelin/claims/<id>.json`; document what you did in next commit message |
| Claim on wrong task | `myelin-unclaim <wrong-id>` then `myelin-claim <right-id>` |

> **Note:** Agent = Copilot/Claude session (`COPILOT_AGENT_SESSION_ID`). A new session is a
> new agent. Expired claims (no heartbeat > 120m) indicate a dead session —
> `myelin-claims --expire` to clean up.

---

## Active Work

| ID | Priority | Status | Work | Evidence / Branch | Next action |
| --- | --- | --- | --- | --- | --- |
| DEPLOY-ZDT-WIN-001 | P2 | done | **Zero-downtime service swap — Windows** — `src/service/windows.mjs` was excluded from PR #38 (skip-if-unchanged). Add `isPortResponding()` + registry/WinSW config unchanged check; skip restart when config is byte-identical and port responds. Same pattern as launchd/systemd. | PR #45 `ea688c0` |
| COMPACT-CLIP-001 | P3 | planned | **osc52d clipboard daemon for myelin compact** — OSC 52 sequences captured by Copilot/Claude subprocess context never reach iTerm2. Fix: tiny Python Unix-socket daemon (osc52d) started from real shell before AI session; holds real /dev/tty fd; client sends content via socket → daemon writes OSC 52. Auto-start in _copilot()/_claude() wrappers. Files: src/detect/clipboard.mjs (add socket candidate), compact-prepare.mjs (inherit stdout for osc52d), src/bin/osc52d.py (new daemon). Ref: issue #42. | — | Implement daemon + wire into clipboard detection |
| STATUSBAR-001 | P4 | planned | **Myelin statusline config** — opt-in statusline showing proxy health, compression savings, active engine, and agent↔code binding (`~/myelin-agents/<agent>/<repo>` CWD → agent name + repo + branch). See `docs/superpowers/specs/2026-07-14-agent-workspace-model-design.md §6a`. | — | Start after MITM-MODEL-001 |
| VERIFY-VER-001 | P5 | planned | **Show headroom-lite version in `myelin verify`** — health endpoint (`/health`) has no version field. Two approaches: (a) add `version` to headroom-lite `/health` response (headroom-lite repo change), or (b) read from installed package.json. Show as e.g. `running — headroom-lite 0.31.0, mode: deterministic`. | — | Check headroom-lite health schema first; prefer approach (a) |
| VERIFY-E2E-001 | P5 | planned | **End-to-end API health probes in `myelin verify`** — currently verify only checks service is running and headroom responds locally. Missing: (a) probe Claude API reachability through MITM→headroom chain (send a minimal test request, check it returns 200), (b) probe Copilot API reachability via the same chain. Surfaces real ECONNREFUSED / cert / 502 failures that the service check misses. Add as opt-in check (`--e2e` flag or config toggle) since it makes real API calls. | — | Design the minimal probe request; add to `buildVerifyResults` as opt-in |
| DEP-UPDATE-HEADROOM-001 | P3 | planned | **Bump managed `headroomOriginal` (Python headroom-ai) 0.31.0 → 0.32.0** — PyPI has 0.32.0 (minor jump, treat as potentially breaking). Update `src/update/component-manifest.mjs` `headroomOriginal.version`. `uv-venv` kind: no ref needed. Also `git -C ~/Work/headroom fetch --tags` (local checkout 2 releases behind). Validate full suite on all 3 platforms. Use the `updating-services` skill. | — | One release, own PR + 3-model CR |
| DEP-UPDATE-SEMBLE-001 | P4 | planned | **Bump managed `semble` 0.4.2 → 0.5.1** — PyPI minor jump (0.x, potentially breaking semantic-search API). `uv-venv` kind: version only. Validate semble MCP search still works + `myelin verify`. Use the `updating-services` skill. | — | One release, own PR + 3-model CR |
| DEP-UPDATE-AGENTCAIRN-001 | P4 | planned | **Bump managed `agentcairn` 0.23.0 → 0.25.0** — PyPI minor jump (skips 0.24.x). `uv-venv` kind: version only. Validate cairn MCP + `myelin verify`. Use the `updating-services` skill. | — | One release, own PR + 3-model CR |
| DEP-UPDATE-TOKENOPT-001 | P5 | planned | **Bump optional `tokenOptimizer` c8f8609 → f5a0eef** — HEAD-tracking git-checkout, optional component (PolyForm NC license, opt-in). Latest HEAD `f5a0eef08894bb585231708f5cd28977dfcaa4f6`. `git-checkout` kind: update `version` (short SHA `f5a0eef`) AND `ref` (full SHA); validator requires `ref.startsWith(version)`. Low priority (optional, off by default). Use the `updating-services` skill. | — | One release, own PR |

## Recently Completed

| ID | Status | Work | Evidence |
| --- | --- | --- | --- |
| DEP-UPDATE-SERENA-001 | done | **Bump managed `serena` 1.5.4.dev0 → v1.6.0** — latest tag `v1.6.0` = SHA `93b9544ea9def8e93cb6a90f8ea67befe3c8fee4`. `uv-git` kind: update `version` AND `ref` together; ref MUST be full 40-hex SHA (no `v` prefix). Serena is code-discovery MCP — validate MCP still starts + `myelin verify` passes on all 3 platforms. Use the `updating-services` skill. | PR #64, eb5f89f |
| INSTALL-BIN-002 | done | **Installer overwrites the repo's committed `bin/myelin` with a machine-specific launcher** — on the Linux install checkout (`~/.myelin/repo`), `git status` shows `M bin/myelin`: the committed ESM wrapper (`#!/usr/bin/env node; import('../src/cli/index.mjs')`) is replaced on disk by a generated `#!/bin/sh … exec '<abs-node>' '<abs>/myelin-launcher.mjs'`. Consequence: `node bin/myelin …` throws `SyntaxError: Unexpected string` (it's a shell script), so `test/stats.test.mjs` ("advertises --wide in `myelin stats --help`" + `renderLocalStatsRows`) fails on any install-checkout that ran `myelin install` (1 pre-existing failure on Linux; passes on Mac worktrees). The real `myelin` command is unaffected (it uses `~/.myelin/bin/myelin` → `current`). Root cause: the npm-link / managed-command-path step writes the launcher into the package `bin/` which is the git-tracked `bin/myelin`. Fix: never write the generated launcher over the repo's committed `bin/myelin` — emit it only to `~/.myelin/bin/` (and let npm link point there), keeping the checkout clean. | PR #62, 98d6f00 |
| CLAUDE-CMD-001 | done | **Claude is missing myelin skill commands (only `/myelin:init`)** — install writes the full myelin skill set for Copilot (`~/.copilot/skills/myelin-compact`, `myelin-constitution`, plus `myelin-init`) but for Claude Code it only writes `~/.claude/commands/myelin/init.md`. So Claude has `/myelin:init` but not `/myelin:compact` or `/myelin:constitution` (observed on Linux; affects all platforms). Fix: in `src/install.mjs` (~line 3220, alongside the `init.md` writer) also write `compact.md` + `constitution.md` into `~/.claude/commands/myelin/`, mirroring the Copilot skill set, so command parity holds across Copilot + Claude. | PR #59, ac60219 |
| HLITE-B4-001 | done | **headroom-lite B4 proxy request-path ports** — H/2 reset handling, favicon 204, `MIN_TOKENS=0`, SSE passthrough, stream-lock release. Deferred to avoid `server.mjs` conflicts. SKIP TOIN/CCR (ML, out of scope). | headroom-lite PR #22 (3403988), tag v0.31.0-1, myelin manifest PR #52 |
| MITM-MODEL-001 | done | **MITM model tracking** — `myelin stats` only shows `gpt-5.4-nano`/`gpt-4o-mini`. Check `~/.myelin/mitmproxy.log` for actual model distribution; improve headroom-lite stats to show model breakdown from `/v1/messages` `model` field. | PR #49, a7db5a0 |
| UPDATE-SYNC-001 | done | **Fix `myelin update` current.json sync** — after `myelin update`, `activateRelease()` updates `~/.myelin/current` symlink but `current.json` points to a different release dir. Result: `myelin verify` shows `✗ Managed runtime` after every update; requires manual fix. | PR #39+#40, bab4bb1 |
| DEPLOY-ZDT-001 | done | **Zero-downtime service swap** — skip-if-unchanged gate in `launchd.mjs` + `systemd.mjs`; `isPortResponding`, `isPlistUnchanged`/`isUnitUnchanged`, `forceRestart` option; `mitmPlistPath(home)` bug fix; `myelin verify` managed-runtime check added. | PR #38, `a5d0386` |
| DOCS-CLI-001 | done | **CLI clarity docs** — improved CLI command documentation and help text. | `feat/docs-cli-clarity`, squash-merged |
| INSTALL-001 | done | Managed immutable runtime: `~/.myelin/releases/`, `current.json` pointer, `myelin update`, `MYELIN_DIR` end-to-end. | PR #24, `5eb9e3b` |
| DEPLOY-001 | done | Bootstrapped all 3 machines (Mac/Linux/Windows) onto managed runtime. Fixed `install.ps1` pipeline-capture bug. | PRs #29–31, 2026-07-15 |
| STREAM-001 | done | Prevent Copilot `/responses` stream EOF after a 418-to-SOCKS5 fallback. | PR #20 — async offload, responses-input handler, relay streaming fix. |
| BRANCH-001a | done | Atomic updates, versioned stores, trusted releases, `compression.backend` canonical config. | `9e38d85`, v1.1.0 (`6b3860e`) |
| ROUTING-001 | done | Installer never writes global `ANTHROPIC_BASE_URL`; actively cleans up stale values from Windows registry. | Already in main — `src/install.mjs` CRITICAL guard + cleanup block. |
| BRANCH-001b | closed | `feat/unified-observability` (50 post-PR#19 commits): all Bug A fixes absorbed by PR#24 / `9e38d85`. Main's `engine-runtime.mjs`, `verify.mjs`, `windows.mjs` are more evolved. No unique code to recover. | Branch deleted 2026-07-15. |
| STATS-001 | done | Added `myelin stats --wide`. | PR #9, `9e3829d` |
| COMPACT-001 | done | Reject oversized compact clipboard hints. | PR #10, `b0deb20` |

## B5 Candidates (from B4 upstream scan, 2026-07-17)

These are additional portability candidates from scanning upstream headroom commits since 2026-06-01.
All are portable within headroom-lite's deterministic/zero-dep/lossless constraints.

| ID | P | Description |
|----|---|-------------|
| HLITE-B5-CACHE-001 | P3 | **done** | Cache key collision fix — headroom-lite PR #24 (`d887229`), v0.31.0-3, myelin manifest PR #66 (`bfbc767`). `extractSystemText()` now collects all system messages joined with `\u0000`. Mac/Linux/Win: 491/491/490 ✅ | | |
| HLITE-B5-JSON-001 | P3 | **done** | **Space-separated JSON minification** — headroom-lite PR #23 (`69f4981`), v0.31.0-2, myelin manifest bump PR #63. Phase 1 minifyJson now handles `{"a":1} {"b":2}` sequences; 7-23% byte savings on real SerpAPI/Tavily tool results. Mac/Linux/Win: 488/488/487 ✅ | |
| HLITE-B5-PARAM-001 | P4 | **OpenAI max_tokens → max_completion_tokens translation** — GPT-5/o-series reject legacy param. Upstream: fix(proxy/openai) GH #1774. Files: normalize/openai-params.mjs (new) |
| HLITE-B5-COST-001 | P4 | **Cache write premium accounting** — subtract write premiums from net savings. Upstream: fix(proxy) GH #1800. Files: observability/ledger.mjs |
| HLITE-B6-CACHE-001 | P5 | **Provider-agnostic cache delta + prefix** — cross-provider cache consistency metrics. Large effort. Upstream: feat(cache) GH #1868 |
| INSTALL-SSH-WIN-001 | P3 | **done** | **Windows SSH `myelin install` fails with SSL cert error** — Fixed in PR #60 (`86618cc`). Root cause: `installMitmproxyCA()` had no Windows CA extraction path, so ca-bundle got only the mitmproxy CA (1 cert); `SSL_CERT_FILE` pointing to it broke all TLS. Fix: PowerShell script extracts 102 system CAs from `Cert:\LocalMachine\Root` + `Cert:\CurrentUser\Root`. Windows: 14/14 ✅ | | |
