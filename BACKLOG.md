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
myelin-agent init <name>          # one-time: register this machine as <name>
myelin-agent whoami               # show current agent name
myelin-claim <task-id>            # claim a task (updates BACKLOG.md status)
myelin-unclaim [task-id]          # release your claim (defaults to your only task)
myelin-claims                     # list all claims + flag stale ones
myelin-claims --expire            # interactively remove expired claims
myelin-heartbeat                  # refresh your heartbeat (auto-called by claim scripts)
```

---

## Active Work

| ID | Priority | Status | Work | Evidence / Branch | Next action |
| --- | --- | --- | --- | --- | --- |
| DEPLOY-ZDT-001 | P1 | in-progress | **Zero-downtime service swap** — fix ~5s mitmproxy gap during `myelin install`/`myelin update` that causes Copilot CLI ECONNREFUSED. Fix: write new plist + bootstrap new service, verify `/health`, then bootout old. | — | Start worktree, implement in `src/service/launchd.mjs` + systemd + windows equivalents |
| MITM-MODEL-001 | P2 | planned | **MITM model tracking** — `myelin stats` only shows `gpt-5.4-nano`/`gpt-4o-mini`. Check `~/.myelin/mitmproxy.log` for actual model distribution; improve headroom-lite stats to show model breakdown from `/v1/messages` `model` field. | — | Investigate log first, then implement |
| HLITE-B4-001 | P3 | planned | **headroom-lite B4 proxy request-path ports** — H/2 reset handling, favicon 204, `MIN_TOKENS=0`, SSE passthrough, stream-lock release. Deferred to avoid `server.mjs` conflicts. SKIP TOIN/CCR (ML, out of scope). | — | Start after DEPLOY-ZDT-001 |
| STATUSBAR-001 | P4 | planned | **Myelin statusline config** — opt-in statusline showing proxy health, compression savings, active engine, and agent↔code binding (`~/myelin-agents/<agent>/<repo>` CWD → agent name + repo + branch). See `docs/superpowers/specs/2026-07-14-agent-workspace-model-design.md §6a`. | — | Start after MITM-MODEL-001 |

## Recently Completed

| ID | Status | Work | Evidence |
| --- | --- | --- | --- |
| INSTALL-001 | done | Managed immutable runtime: `~/.myelin/releases/`, `current.json` pointer, `myelin update`, `MYELIN_DIR` end-to-end. | PR #24, `5eb9e3b` |
| DEPLOY-001 | done | Bootstrapped all 3 machines (Mac/Linux/Windows) onto managed runtime. Fixed `install.ps1` pipeline-capture bug. | PRs #29–31, 2026-07-15 |
| STREAM-001 | done | Prevent Copilot `/responses` stream EOF after a 418-to-SOCKS5 fallback. | PR #20 — async offload, responses-input handler, relay streaming fix. |
| BRANCH-001a | done | Atomic updates, versioned stores, trusted releases, `compression.backend` canonical config. | `9e38d85`, v1.1.0 (`6b3860e`) |
| ROUTING-001 | done | Installer never writes global `ANTHROPIC_BASE_URL`; actively cleans up stale values from Windows registry. | Already in main — `src/install.mjs` CRITICAL guard + cleanup block. |
| BRANCH-001b | closed | `feat/unified-observability` (50 post-PR#19 commits): all Bug A fixes absorbed by PR#24 / `9e38d85`. Main's `engine-runtime.mjs`, `verify.mjs`, `windows.mjs` are more evolved. No unique code to recover. | Branch deleted 2026-07-15. |
| STATS-001 | done | Added `myelin stats --wide`. | PR #9, `9e3829d` |
| COMPACT-001 | done | Reject oversized compact clipboard hints. | PR #10, `b0deb20` |
