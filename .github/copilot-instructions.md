<!-- CONSTITUTION v1 — Stable project context for GitHub Copilot CLI.
     Only stable facts belong here. Volatile state goes in the compact hint. -->

# myelin (tokenstack)

## Identity
- name: myelin / tokenstack
- repo: yehsuf/myelin
- purpose: Token-efficiency stack for AI coding agents — compression proxy, RTK wiring, deterministic transforms, and developer tooling.

## Architecture invariants
- Zero external runtime dependencies in **headroom-lite's core compression backend**.
- All Node.js source uses ESM (.mjs extensions).
- **headroom-lite's core compression transforms** are deterministic and lossless — same input always produces same output.
- **No ML models in headroom-lite's core compression backend.** (This purity rule is scoped to the headroom-lite core — see "LLMLingua / llmsecurity" below.)
- Windows support is a first-class concern (WinSW, KeepAlive, path handling).

## LLMLingua / llmsecurity (approved ML compression layer)
- LLMLingua ("llmsecurity") is an **approved** lossy compression capability. Approved because it is peer-reviewed and runs **local-inference only** (127.0.0.1 microservice — no data egress).
- It MUST be a **separate, self-standing, backend-agnostic myelin component** — never embedded in headroom-lite's core pipeline. It must work regardless of which headroom backend is active (toggled independently, e.g. via a headroom env var).
- The "no ML / deterministic / lossless / zero-dep" invariants above do **not** apply to this separate layer; they apply only to the headroom-lite core.


## Standing rules
- Never take a repo-changing, service-changing, or live-machine action without explicit unambiguous approval each time.
- Every non-trivial change: implement → test → code review (3-model) → fix → merge.
- ALL development — even a solo agent, even a one-line doc or config edit — happens inside a `~/myelin-agents/<agent>/` worktree. Parallel agents MUST use separate workspaces/worktrees, never share a checkout directory.
- The canonical `~/tokenstack` checkout is a **reference clone that stays on clean `main`**. Never edit files, run experiments, or drop scratch in it — it must show a clean `git status` at all times.
- Each agent develops inside its own workspace `~/myelin-agents/<agent>/` (one git worktree per repo). The source of truth is a **bare** canonical repo at `~/myelin-agents/.bare/<repo>.git` that is never worked in directly.
- Scratch/tmp/experiment files NEVER go inside a repo working tree (including `~/tokenstack`) — put them in `~/myelin-agents/<agent>/scratch/` or `~/.copilot/session-state/<id>/files/`.
- Never rewrite git history on shared branches (main, dev).

## Local development workspace
- Layout: `~/myelin-agents/.bare/<repo>.git` (bare canonical) + `~/myelin-agents/<agent>/<repo>/` (per-agent worktree) + `~/myelin-agents/<agent>/scratch/`.
- Create a worktree: `git --git-dir="$HOME/myelin-agents/.bare/<repo>.git" worktree add ~/myelin-agents/<agent>/<repo> -b <branch> origin/main`.
- Agent identity is the `<agent>` path segment (derived, no id file). See CLAUDE.md for full setup + the coordinated legacy-worktree retirement.

## Technology
- Language / runtime: Node.js >=20, ESM only (.mjs extensions)
- Test command: node --test test/**/*.test.mjs
- Package manager: npm
- Linter: eslint (if configured)

## Key file map
- src/cli/index.mjs — CLI entrypoint (myelin command)
- src/mitm/copilot_addon.py — mitmproxy addon for Copilot CLI compression
- src/compress/ — deterministic compression transforms (lossless-compaction, cross-turn-dedup, adaptive-sizer)
- src/tools/ — external tool wrappers (RTK, WinSW, headroom)
- src/service/ — Windows service management
- src/hooks/ — bash-ban-raw and other hook implementations
