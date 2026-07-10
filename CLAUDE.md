# Myelin — CLAUDE.md

Cross-platform token-efficiency CLI for Claude Code + GitHub Copilot workspaces.
Node.js ESM, Commander.js, TDD (`node --test`), direct-to-main git workflow.

---

## Test machines

### Mac (primary dev — this machine)
```
~/tokenstack/          # repo
myelin verify          # health check
npm test               # 272 tests
```

### Windows (`yeh-legion.local`)
```bash
ssh -i ~/.ssh/myelin_windows_ed25519 -o IdentitiesOnly=yes yehsuf@yeh-legion.local
# Repo on Windows:      C:\Users\yehsuf\.myelin\repo
# myelin bin resolves to: ~/.myelin/repo (npm-linked)
# Verify: ssh then: myelin verify
# Pull latest: myelin update --self
```

### Linux (`muc-lhvsuz`)
```bash
ssh muc-lhvsuz          # uses ~/.ssh/config entry (ysufrin, internal key)
# Full host: muc-lhvsuz.munich.corp.akamai.com
# Repo: ~/.myelin/repo
# Pull latest: myelin update --self
```

---

## Feature development workflow (worktrees)

**Every feature must use a git worktree + feature branch. Never edit `main` directly.**

### Start a feature

```bash
# 1. Create worktree + branch + register with Copilot/Serena in one command:
myelin worktree add feat/my-feature

# This does:
#   git worktree add ~/tokenstack-wt-feat-my-feature -b feat/my-feature
#   myelin init --yes   (creates .serena/project.yml + writes .claude/settings.local.json hooks)

# 2. Enter the worktree — start Copilot/Claude Code session FROM this directory
cd ~/tokenstack-wt-feat-my-feature
# The serena-mcp wrapper auto-detects this worktree as the active project
```

### Test on all 3 platforms before merging

```bash
# Mac (local)
npm test

# Windows — checkout branch + test
ssh yeh-legion "cd %USERPROFILE%\\.myelin\\repo && git fetch origin && git checkout feat/my-feature && npm test"

# Linux — checkout branch + test
ssh muc-lhvsuz 'cd ~/.myelin/repo && git fetch origin && git checkout feat/my-feature && npm test'
```

### Merge + cleanup

```bash
# From main repo (not the worktree)
cd ~/tokenstack
git merge --squash feat/my-feature   # or: git merge --ff-only
git commit -m "feat: ..."
git push origin main

# Remove worktree + delete branch
myelin worktree remove feat/my-feature
```

### Other worktree commands
```bash
myelin worktree list                          # list all active worktrees
myelin worktree remove feat/x --keep-branch  # remove worktree but keep the branch
```

### How session registration works
`myelin init` in the worktree calls `serena project create --index <worktree-path>` which:
1. Creates `.serena/project.yml` in the worktree (gitignored — machine-local)
2. Registers the path in `~/.serena/serena_config.yml`

The `serena-mcp.sh` wrapper detects the project by walking up from CWD at spawn time.
Starting Copilot/Claude Code from the worktree directory = session is registered to that worktree.

---



## Git workflow (agents / hotfixes only)
- Direct-to-main is only for agents doing concurrent work or emergency hotfixes.
- **All other work uses worktrees** (see above).
- Always `git fetch origin && git pull --rebase origin main` before committing when working concurrently.
- If push is rejected: `git pull --rebase origin main && git push origin main`.
```bash
npm test                                        # full suite (node --test)
node --test test/specific.test.mjs             # single file
node src/install.mjs --yes                     # install/update all services
myelin verify                                   # health check all services
myelin config show                              # current config
myelin update                                   # upgrade tools (uv, headroom, serena, semble…)
myelin update --self [--force]                  # self-update from origin/main
```

---

## Architecture

```
Copilot CLI / Claude Code
    │  HTTPS_PROXY=http://127.0.0.1:8888
    ▼
mitmproxy :8888  (src/mitm/copilot_addon.py)
    │  POST /v1/compress  →  headroom :8787
    │  Tool filter, RAG inject, thrash cache
    ▼
Headroom proxy :8787  (headroom-ai PyPI)
    │  Compression pipeline (cache-mode, TOIN)
    ▼
Real API (api.githubcopilot.com / api.anthropic.com)
```

Optional: LiteLLM :4000 in front of the chain (budget routing + model fallback).

---

## Key source files

| File | Purpose |
|------|---------|
| `src/install.mjs` | Main installer — all service setup |
| `src/cli/*.mjs` | CLI commands (update, config, verify, restart…) |
| `src/config/schema.mjs` | `DEFAULT_CONFIG` + `pruneUnknownKeys` |
| `src/mitm/copilot_addon.py` | mitmproxy addon (compression, thrash cache, block-bypass) |
| `src/detect/os.mjs` | OS detection (WSL → 'windows') |
| `src/detect/wsl.mjs` | WSL detection (5-tier, no deps) |
| `src/service/windows.mjs` | Windows service management (WinSW / registry Run key) |
| `src/service/litellm-service.mjs` | LiteLLM config generator (opt-in) |
| `src/mcp/git-extra.py` | Custom MCP: `git_blame` + `git_log_rich` |
| `src/hooks/serena-hook-bridge.mjs` | Serena → Copilot/Claude hook adapter |

---

## Config keys (important)
```yaml
proxy.headroom.port: 8787
proxy.mitm.port: 8888
proxy.copilot_headroom.enabled: false   # dedicated Copilot-Headroom instance
code_discovery.serena.enabled: true
code_discovery.mcp_git_extra: true      # our custom git MCP
budget_routing.litellm: false           # opt-in LiteLLM proxy on :4000
observability.token_optimizer: false    # opt-in (PolyForm NC license)
```

Edit: `myelin config set <key> <value>` → then `myelin install` to apply.

---

## Windows-specific notes
- Services run via registry Run key (default) or WinSW (opt-in).
- `myelin update` stops `headroom` / `serena-agent` / `semble` processes before uv upgrades to avoid file-lock errors (os error 32/5).
- SSH key must be specified explicitly: `-i ~/.ssh/myelin_windows_ed25519 -o IdentitiesOnly=yes` (1Password agent tries many keys → "too many auth failures").
- `.gitattributes` enforces LF line endings on all source files — prevents CRLF phantom diffs.

## WSL notes
- `detectOS()` returns `'windows'` inside WSL (bridges to Windows service management).
- `isWsl()` in `src/detect/wsl.mjs` — 5-tier detection, container guard prevents Docker false positives.
- `resolveWslWindowsHome()` — 3-tier: PowerShell registry → filesystem scan → null.

---

## Hard constraints
- ❌ No `--subscription` / BYOK mode for Copilot
- ❌ No vaporware config keys (run `myelin config prune` after schema changes)
- ❌ No version bumps on dev/feature branches (version bumps only on master publish)
- ✅ All changes tested before push (`npm test` must pass)
- ✅ Pure functions with injected deps for all testable logic
