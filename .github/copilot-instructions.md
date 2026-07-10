<!-- CONSTITUTION v1 — Stable project context for GitHub Copilot CLI.
     Only stable facts belong here. Volatile state goes in the compact hint. -->

# myelin (tokenstack)

## Identity
- name: myelin / tokenstack
- repo: yehsuf/myelin
- purpose: Token-efficiency stack for AI coding agents — compression proxy, RTK wiring, deterministic transforms, and developer tooling.

## Architecture invariants
- Zero external runtime dependencies in the proxy/compression path.
- All Node.js source uses ESM (.mjs extensions).
- Compression transforms are deterministic and lossless — same input always produces same output.
- No ML models in the compression pipeline.
- Windows support is a first-class concern (WinSW, KeepAlive, path handling).

## Standing rules
- Never take a repo-changing, service-changing, or live-machine action without explicit unambiguous approval each time.
- Every non-trivial change: implement → test → code review (3-model) → fix → merge.
- Parallel agents MUST use separate git worktrees, never share a checkout directory.
- Never rewrite git history on shared branches (main, dev).

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
