# Myelin — CLAUDE.md

Cross-platform token-efficiency CLI for Claude Code + GitHub Copilot workspaces.
Node.js ESM, Commander.js, TDD (`node --test`), feature-branch → PR git workflow.

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

## Feature development workflow (per-agent workspaces)

**Every agent works inside its OWN workspace `~/myelin-agents/<agent>/`. Never edit `main` directly, never work in the bare canonical, never work in another agent's directory.**

Layout (see `docs/superpowers/specs/2026-07-14-agent-workspace-model-design.md`):

```
~/myelin-agents/
├── .bare/myelin.git/          # bare canonical (no working tree — cannot be clobbered)
├── .bare/headroom-lite.git/
├── <agent>/                   # e.g. architect, reviewer, task-runner
│   ├── myelin/                # git worktree of .bare/myelin.git
│   ├── headroom-lite/         # git worktree of .bare/headroom-lite.git (on demand)
│   └── scratch/               # scratch/tmp — SIBLING of the repos, never inside them
```

### One-time: create a bare canonical (per repo)

```bash
mkdir -p ~/myelin-agents/.bare
git clone --bare git@github.com:yehsuf/myelin.git ~/myelin-agents/.bare/myelin.git
git --git-dir=~/myelin-agents/.bare/myelin.git config remote.origin.fetch \
    '+refs/heads/*:refs/remotes/origin/*'
git --git-dir=~/myelin-agents/.bare/myelin.git fetch origin
```

### Start a feature (per agent)

```bash
git --git-dir=~/myelin-agents/.bare/myelin.git fetch origin
git --git-dir=~/myelin-agents/.bare/myelin.git worktree add \
    ~/myelin-agents/<agent>/myelin -b <branch> origin/main
cd ~/myelin-agents/<agent>/myelin          # start the Copilot/Claude session FROM here
```

Reuse the same worktree path across branches where practical (keeps Serena's path-baked cache warm). Put ALL scratch in `~/myelin-agents/<agent>/scratch/` — never in the worktree.

### Test on all 3 platforms before merging

```bash
npm test                                   # Mac (local)
ssh yeh-legion "cd %USERPROFILE%\.myelin\repo && git fetch origin && git checkout <branch> && npm test"
ssh muc-lhvsuz 'cd ~/.myelin/repo && git fetch origin && git checkout <branch> && npm test'
```

> **⚠️ MANDATORY — always reset the install machines back to `main` when done (test pass OR fail).**
> The Windows/Linux `~/.myelin/repo` are **install targets, never dev checkouts** — leaving them on a
> feature branch makes `myelin`/services run unmerged code and produces the recurring "why is this
> machine on a branch?" drift. Reset each regardless of the test result:
>
> ```bash
> ssh yeh-legion "cd %USERPROFILE%\\.myelin\\repo && git checkout -B main origin/main"
> ssh muc-lhvsuz 'cd ~/.myelin/repo && git checkout -B main origin/main'
> ```
>
> If a machine's repo was cloned single-branch (fetch refspec pinned to a feature branch, no `main`),
> first repair it:
> `git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' && git fetch origin`.

### Finish (rebase → PR → ask before merge)

```bash
git -C ~/myelin-agents/<agent>/myelin fetch origin
git -C ~/myelin-agents/<agent>/myelin rebase origin/main
git -C ~/myelin-agents/<agent>/myelin push -u origin <branch>
gh pr create --base main --head <branch>   # then ASK the human to approve the merge
```

### Remove a worktree when done

```bash
git --git-dir=~/myelin-agents/.bare/myelin.git worktree remove ~/myelin-agents/<agent>/myelin
git --git-dir=~/myelin-agents/.bare/myelin.git worktree prune
```

> Note: the old helper command is NOT real — use the `git worktree` commands above. A helper may exist one day in a *separate dev-tools library*, not in myelin.

---



## Git workflow

**Default (all normal work):** clean worktree from latest `origin/main` → feature-specific
branch → push branch to origin periodically → run all tests on **all 3 environments**
(Mac + Windows + Linux) → code review per rules → **open a PR to main** (after confirming
the branch is rebased on latest `origin/main`) → **ask the human to approve the PR merge**.
The branch is never the final destination, and never merge without explicit approval.

**Exception — direct-to-main:** ONLY for agents doing concurrent work or emergency hotfixes.
- **All other work uses worktrees + a PR** (see "Feature development workflow" above).
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
