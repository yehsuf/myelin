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
| ROUTING-001 | P1 | planned | Keep Claude routing per invocation only; installer must not reintroduce global Anthropic base URLs. | Current installer writes `ANTHROPIC_BASE_URL` to Claude settings; local stale values were manually removed. | Add installer migration and regression tests. |
| BRANCH-001b | P2 | ready | Reconcile `feat/unified-observability` (50 commits ahead of main). | `feat/unified-observability` — service lifecycle, observability endpoints, engine routing fixes. | Rebase on current main, review, test on all 3 envs, open PR. |

## Recently Completed

| ID | Status | Work | Evidence |
| --- | --- | --- | --- |
| INSTALL-001 | done | Managed immutable runtime: `~/.myelin/releases/`, `current.json` pointer, `myelin update`, `MYELIN_DIR` end-to-end. | PR #24, `5eb9e3b` |
| DEPLOY-001 | done | Bootstrapped all 3 machines (Mac/Linux/Windows) onto managed runtime. Fixed `install.ps1` pipeline-capture bug (PR #31). | PRs #29–31, session 2026-07-15 |
| STREAM-001 | done | Prevent Copilot `/responses` stream EOF after a 418-to-SOCKS5 fallback. | Merged: async offload, responses-input handler, relay streaming fix (PR #20). |
| BRANCH-001a | done | Atomic updates, versioned stores, trusted releases, `compression.backend` canonical config. | `9e38d85`, v1.1.0 (`6b3860e`) |
| STATS-001 | done | Added `myelin stats --wide`. | PR #9, `9e3829d` |
| COMPACT-001 | done | Reject oversized compact clipboard hints. | PR #10, `b0deb20` |
