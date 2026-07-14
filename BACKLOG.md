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
| INSTALL-001 | P0 | ready | Replace Git-checkout runtime with a managed immutable runtime and release-aware `myelin self update`. | `feat/managed-runtime-installer`; no release store, pointer, or artifact updater exists in `main`. | Rebase, review, validate, and merge the managed-runtime installer slice. |
| STREAM-001 | P1 | ready | Prevent Copilot `/responses` stream EOF after a 418-to-SOCKS5 fallback. | `feat/mitm-async-offload` (`53ab946`, `12844c6`, `f98c940`); current logs show server-side closes after fallback. | Rebase, review, then run a real Copilot stream canary before merging. |
| ROUTING-001 | P1 | planned | Keep Claude routing per invocation only; installer must not reintroduce global Anthropic base URLs. | Current installer writes `ANTHROPIC_BASE_URL` to Claude settings; local stale values were manually removed. | Add installer migration and regression tests after INSTALL-001 establishes managed runtime. |
| DEPLOY-001 | P1 | blocked | Restore Windows and Linux hosts to managed deployment runtime. | Windows was left on `feat/mitm-async-offload`; Linux has missing services/tools. | Execute only after INSTALL-001 supplies a non-Git runtime path. |
| BRANCH-001 | P2 | ready | Reconcile remaining backend-selection and observability worktrees. | `feat/atomic-update-backend-selection` is far ahead/behind main; `feat/unified-observability` is dirty and diverged. | Rebase each independently, review, test, and open separate PRs. |

## Recently Completed

| ID | Status | Work | Evidence |
| --- | --- | --- | --- |
| STATS-001 | done | Added `myelin stats --wide`. | PR #9, `9e3829d` |
| COMPACT-001 | done | Reject oversized compact clipboard hints. | PR #10, `b0deb20` |
