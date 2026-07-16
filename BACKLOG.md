# Myelin Backlog

> **This file is the single source of truth for the backlog across all sessions, agents, and machines.**
> Agent SQL todos are session-local and ephemeral — they are NOT visible to other sessions.
> When you finish work or triage new items, update this file and commit to `main` so the next session picks it up.

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

### Backlog hygiene
- Add new items to **Active Work** below when triaged.
- Move to **Recently Completed** when merged; include PR number and commit SHA.
- Update this file in the same PR as the implementation (not a separate cleanup PR).
- Session SQL todos are a scratchpad only — always sync final state back here.

### Task claiming protocol (multi-agent)
> Tools live in `~/.myelin/bin/` (local only, not in repo). Agent identity stored in `~/.myelin/agent-name`.

**Rules — non-negotiable:**
- **Never start work on a task you have not claimed.** Always `myelin-claim <task-id>` first.
- **One active claim per agent at a time.** Claim blocks until you `myelin-unclaim`.
- **Always unclaim when done, blocked, or handing off.** Don't leave ghost claims.
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

> **Note:** Agent = Copilot/Claude session (`COPILOT_AGENT_SESSION_ID`). A new session is a
> new agent. Expired claims (no heartbeat > 120m) indicate a dead session —
> `myelin-claims --expire` to clean up.

---

## Active Work

| ID | Priority | Status | Work | Evidence / Branch | Next action |
| --- | --- | --- | --- | --- | --- |
| TASK-PROTO-001 | P2 | planned | **Task claiming protocol — make it really work** — current bash scripts in `~/.myelin/bin/` are broken: (1) no `myelin-done` command (unclaim only goes back to `planned`, never `done`), (2) scripts don't commit BACKLOG.md changes — other sessions never see claim state, (3) local-only — Linux/Windows have nothing, (4) no heartbeat daemon — claims silently expire on live sessions, (5) session ID env var unreliable. Fix: implement `myelin task claim/unclaim/done/list` as proper CLI subcommands in `src/cli/task.mjs`; track state in `~/.myelin/tasks/<id>.json` (not parsed markdown); `done` auto-commits+pushes BACKLOG.md; ship to all 3 machines via `myelin update`. | — | Design state schema first; TDD → implement → cross-env |
| MITM-MODEL-001 | P2 | planned | **MITM model tracking** — `myelin stats` only shows `gpt-5.4-nano`/`gpt-4o-mini`. Check `~/.myelin/mitmproxy.log` for actual model distribution; improve headroom-lite stats to show model breakdown from `/v1/messages` `model` field. | — | Investigate log first, then implement |
| HLITE-B4-001 | P3 | planned | **headroom-lite B4 proxy request-path ports** — H/2 reset handling, favicon 204, `MIN_TOKENS=0`, SSE passthrough, stream-lock release. Deferred to avoid `server.mjs` conflicts. SKIP TOIN/CCR (ML, out of scope). | — | Ready to start (DEPLOY-ZDT-001 done) |
| STATUSBAR-001 | P4 | planned | **Myelin statusline config** — opt-in statusline showing proxy health, compression savings, active engine, and agent↔code binding (`~/myelin-agents/<agent>/<repo>` CWD → agent name + repo + branch). See `docs/superpowers/specs/2026-07-14-agent-workspace-model-design.md §6a`. | — | Start after MITM-MODEL-001 |
| VERIFY-VER-001 | P5 | planned | **Show headroom-lite version in `myelin verify`** — health endpoint (`/health`) has no version field. Two approaches: (a) add `version` to headroom-lite `/health` response (headroom-lite repo change), or (b) read from installed package.json. Show as e.g. `running — headroom-lite 0.31.0, mode: deterministic`. | — | Check headroom-lite health schema first; prefer approach (a) |
| VERIFY-E2E-001 | P5 | planned | **End-to-end API health probes in `myelin verify`** — currently verify only checks service is running and headroom responds locally. Missing: (a) probe Claude API reachability through MITM→headroom chain (send a minimal test request, check it returns 200), (b) probe Copilot API reachability via the same chain. Surfaces real ECONNREFUSED / cert / 502 failures that the service check misses. Add as opt-in check (`--e2e` flag or config toggle) since it makes real API calls. | — | Design the minimal probe request; add to `buildVerifyResults` as opt-in |

## Recently Completed

| ID | Status | Work | Evidence |
| --- | --- | --- | --- |
| DEPLOY-ZDT-001 | done | **Zero-downtime service swap** — skip-if-unchanged gate in `launchd.mjs` + `systemd.mjs`; `isPortResponding`, `isPlistUnchanged`/`isUnitUnchanged`, `forceRestart` option; `mitmPlistPath(home)` bug fix; `myelin verify` managed-runtime check added. | PR #38, `a5d0386` |
| INSTALL-001 | done | Managed immutable runtime: `~/.myelin/releases/`, `current.json` pointer, `myelin update`, `MYELIN_DIR` end-to-end. | PR #24, `5eb9e3b` |
| DEPLOY-001 | done | Bootstrapped all 3 machines (Mac/Linux/Windows) onto managed runtime. Fixed `install.ps1` pipeline-capture bug. | PRs #29–31, 2026-07-15 |
| STREAM-001 | done | Prevent Copilot `/responses` stream EOF after a 418-to-SOCKS5 fallback. | PR #20 — async offload, responses-input handler, relay streaming fix. |
| BRANCH-001a | done | Atomic updates, versioned stores, trusted releases, `compression.backend` canonical config. | `9e38d85`, v1.1.0 (`6b3860e`) |
| ROUTING-001 | done | Installer never writes global `ANTHROPIC_BASE_URL`; actively cleans up stale values from Windows registry. | Already in main — `src/install.mjs` CRITICAL guard + cleanup block. |
| BRANCH-001b | closed | `feat/unified-observability` (50 post-PR#19 commits): all Bug A fixes absorbed by PR#24 / `9e38d85`. Main's `engine-runtime.mjs`, `verify.mjs`, `windows.mjs` are more evolved. No unique code to recover. | Branch deleted 2026-07-15. |
| STATS-001 | done | Added `myelin stats --wide`. | PR #9, `9e3829d` |
| COMPACT-001 | done | Reject oversized compact clipboard hints. | PR #10, `b0deb20` |
