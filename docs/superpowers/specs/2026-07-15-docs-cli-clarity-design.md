# Documentation & CLI Help Clarity Pass — Design

## Goal
Bring README.md, docs/settings-reference.md, and docs/copilot-headroom-architecture.md
up to date with actual code behavior, and align the wording/style of `myelin` CLI
help text (`.description()` / `.option()` strings in `src/cli/*.mjs`).

## Scope
**In scope (docs):**
- `README.md`
- `docs/settings-reference.md`
- `docs/copilot-headroom-architecture.md`

**In scope (CLI help text only, not behavior):**
- `src/cli/index.mjs` (top-level command descriptions/options)
- `src/cli/config-cmd.mjs` (config subcommand descriptions/options)

**Out of scope:**
- Implementing `myelin worktree` (documented in CLAUDE.md, does not exist in code) —
  reported as an inconsistency, not fixed, since CLAUDE.md itself is out of scope.
- `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md` — agent-instruction
  files, different audience/purpose than user-facing docs.
- Historical spec/plan docs under `docs/specs/`, `docs/plans/`, `docs/superpowers/`.
- Any CLI *behavior* change (flags, defaults, exit codes) — text only.

## Approach
Audit-and-refine, not a ground-up rewrite. The three target docs are already
well-structured and recently maintained. Work is:
1. Cross-check every factual claim (config keys, defaults, ports, CLI commands,
   flags) against the source of truth: `src/config/schema.mjs`, `src/cli/index.mjs`,
   `src/cli/config-cmd.mjs`, `src/install.mjs`.
2. Fix mismatches found (stale defaults, renamed flags, missing/extra config keys,
   references to non-existent features).
3. Tighten unclear or redundant prose without changing accurate content.
4. Normalize CLI help text style: consistent capitalization, consistent verb-first
   phrasing, consistent flag description format across all commands/options.

## Verification
- `npm test` (full suite) — help text changes are low-risk but must not break
  CLI argument parsing or any test that asserts on `--help` output.
- Manual `myelin --help` / `myelin <cmd> --help` spot-check after edits.

## Deliverable
- Code changes committed to `feat/docs-cli-clarity`, PR opened to `main` (merge
  requires explicit user approval).
- A plain-text inconsistency report delivered in chat at the end (not committed
  to the repo) listing every mismatch found between docs and code, including the
  `myelin worktree` non-existent-command issue.
