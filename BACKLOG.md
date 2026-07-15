# Myelin Backlog

This is the canonical cross-worktree backlog. Every implementation branch
starts from current `origin/main`, updates the applicable row in the same PR,
and rebases before push. Do not use a deployment host as a development
checkout.

## Status Values

- `in-progress` -- approved work with an active implementation branch.
- `ready` -- implementation exists and needs rebase, review, or validation.
- `planned` -- approved priority, no implementation started.
- `blocked` -- cannot proceed until the stated dependency is resolved.
- `done` -- merged to `main`.

## Active Work

| ID | Priority | Status | Work | Evidence / Branch | Next action |
| --- | --- | --- | --- | --- | --- |
| — | — | — | No active items. | — | Await direction. |

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
