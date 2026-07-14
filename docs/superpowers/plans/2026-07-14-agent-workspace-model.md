# Agent Workspace Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a documented, enforced local-dev workflow where each agent works in its own isolated workspace (per-agent git worktrees off a bare canonical repo) and scratch/tmp files can never dirty a repo.

**Architecture:** Documentation-only change to two files (`.github/copilot-instructions.md`, `CLAUDE.md`) plus a validated bootstrap runbook. No myelin library (`src/`) code — per the standing constraint that non-token-saving tooling belongs in a separate dev-tools library. The bare-canonical + per-agent-worktree model is proven with a throwaway smoke test.

**Tech Stack:** git (worktrees, bare repos), Node.js ESM (only for running the existing constitution checker + test suite), Markdown.

## Global Constraints

- **No `src/` (library) changes.** This is dev workflow, not a product feature. Any helper command belongs in a *future separate dev-tools library*, not myelin.
- **Canonical repos are bare** (`~/myelin-agents/.bare/<repo>.git`) and never worked in directly.
- **Every agent works only inside `~/myelin-agents/<agent>/`**; one git worktree per repo, at a stable path.
- **Scratch/tmp NEVER inside a repo working tree** — use `~/myelin-agents/<agent>/scratch/` or `~/.copilot/session-state/<id>/files/`.
- **Never rewrite shared history** (main/dev) — the object store is shared by all agents.
- **Agent identity is path-derived** from `~/myelin-agents/<agent>/<repo>` (no registry/id file required).
- **Do NOT delete or move any existing `~/tokenstack-wt-*` worktree with uncommitted work or a live agent** — migration is coordinated, not unilateral.
- Spec: `docs/superpowers/specs/2026-07-14-agent-workspace-model-design.md`.

## Out of scope (follow-up)

- **Statusline binding** (spec §6a): showing `agent · repo@branch` in the Copilot CLI statusline. The `/statusline` custom-item contract is undocumented here and the broader myelin-health statusline items need their own design. Tracked by the **`statusbar-config`** todo, which already records the §6a requirement. It gets its own brainstorm → spec → plan.

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `.github/copilot-instructions.md` | Terse standing invariants every agent reads | Modify: add 2 workspace/scratch standing rules; add a short "Local development workspace" block |
| `CLAUDE.md` | Detailed dev workflow guide | Modify: replace the stale `myelin worktree`/`~/tokenstack-wt-*` section with the workspace model, bootstrap commands, scratch rule, and a coordinated legacy-retirement checklist |

---

### Task 1: Constitution — add workspace + scratch invariants

**Files:**
- Modify: `.github/copilot-instructions.md:24-28` (Standing rules) and insert a new block after it.

**Interfaces:**
- Consumes: nothing.
- Produces: the standing rules that Tasks 2–3 and all future agents reference (workspace path convention `~/myelin-agents/<agent>/`, bare canonical `~/myelin-agents/.bare/<repo>.git`, scratch locations).

- [ ] **Step 1: Edit the Standing rules list**

In `.github/copilot-instructions.md`, replace this line:

```
- Parallel agents MUST use separate git worktrees, never share a checkout directory.
```

with these three lines:

```
- Parallel agents MUST use separate workspaces/worktrees, never share a checkout directory.
- Each agent develops inside its own workspace `~/myelin-agents/<agent>/` (one git worktree per repo). The source of truth is a **bare** canonical repo at `~/myelin-agents/.bare/<repo>.git` that is never worked in directly.
- Scratch/tmp/experiment files NEVER go inside a repo working tree — put them in `~/myelin-agents/<agent>/scratch/` or `~/.copilot/session-state/<id>/files/`.
```

- [ ] **Step 2: Add a short "Local development workspace" section**

Immediately after the Standing rules list (before `## Technology`), insert:

```markdown
## Local development workspace
- Layout: `~/myelin-agents/.bare/<repo>.git` (bare canonical) + `~/myelin-agents/<agent>/<repo>/` (per-agent worktree) + `~/myelin-agents/<agent>/scratch/`.
- Create a worktree: `git --git-dir=~/myelin-agents/.bare/<repo>.git worktree add ~/myelin-agents/<agent>/<repo> -b <branch> origin/main`.
- Agent identity is the `<agent>` path segment (derived, no id file). See CLAUDE.md for full setup + the coordinated legacy-worktree retirement.
```

- [ ] **Step 3: Verify the constitution still passes its checker**

Run (from the worktree root):

```bash
node src/cli/index.mjs constitution check
```

Expected: exits 0 with a pass/OK message and **no** secret/format errors (the SHA-like `.bare/<repo>.git` paths are not flagged as secrets).

- [ ] **Step 4: Commit**

```bash
git add .github/copilot-instructions.md
git commit -m "docs(constitution): add per-agent workspace + scratch invariants"
```

---

### Task 2: CLAUDE.md — replace worktree workflow with the workspace model

**Files:**
- Modify: `CLAUDE.md:36-93` (the "Feature development workflow (worktrees)" section through "How session registration works").

**Interfaces:**
- Consumes: the workspace layout + rules from Task 1.
- Produces: the authoritative, copy-pasteable dev runbook (bootstrap, worktree add, scratch, retirement) that agents follow.

- [ ] **Step 1: Replace the stale worktree section**

In `CLAUDE.md`, delete the entire block from the line `## Feature development workflow (worktrees)` (line 36) through the line `Starting Copilot/Claude Code from the worktree directory = session is registered to that worktree.` (line 93), and replace it with:

````markdown
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
ssh yeh-legion "cd %USERPROFILE%\\.myelin\\repo && git fetch origin && git checkout <branch> && npm test"
ssh muc-lhvsuz 'cd ~/.myelin/repo && git fetch origin && git checkout <branch> && npm test'
```

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

> Note: `myelin worktree …` is NOT a real command — use the `git worktree` commands above. A helper may exist one day in a *separate dev-tools library*, not in myelin.
````

- [ ] **Step 2: Validate the bootstrap commands with a throwaway smoke test**

Prove the documented commands actually work end-to-end, in a disposable location that touches nothing real:

```bash
SMOKE=$(mktemp -d)/wsmoke && mkdir -p "$SMOKE/.bare"
git clone --bare "file:///Users/ysufrin/tokenstack/.git" "$SMOKE/.bare/myelin.git"
git -C "$SMOKE/.bare/myelin.git" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git -C "$SMOKE/.bare/myelin.git" worktree add "$SMOKE/agentX/myelin" -b smoke/test HEAD
# verify: clean tree + tests run in the worktree
git -C "$SMOKE/agentX/myelin" status --porcelain    # expect: empty
( cd "$SMOKE/agentX/myelin" && node --test test/detect.test.mjs )   # expect: pass
# teardown
git -C "$SMOKE/.bare/myelin.git" worktree remove "$SMOKE/agentX/myelin"
rm -rf "$(dirname "$SMOKE")"
```

Expected: `status --porcelain` prints nothing; the single test file passes. If any command needs correction, fix it in the CLAUDE.md block above before committing.

- [ ] **Step 3: Verify the stale references are gone**

```bash
grep -n "myelin worktree\|tokenstack-wt" CLAUDE.md          # expect: no matches
grep -n "~/myelin-agents" CLAUDE.md                         # expect: matches present
```

Expected: first grep prints nothing (exit 1); second prints the new lines.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): replace stale worktree workflow with per-agent workspace model"
```

---

### Task 3: CLAUDE.md — coordinated legacy-worktree retirement checklist

**Files:**
- Modify: `CLAUDE.md` — append a short "Retiring the legacy `~/tokenstack-wt-*` worktrees" subsection at the end of the workspace workflow section.

**Interfaces:**
- Consumes: the workspace model from Task 2.
- Produces: an agent-safe, one-time migration checklist (no code); executed over time as live agents finish.

- [ ] **Step 1: Append the retirement checklist**

After the "Remove a worktree when done" block from Task 2, add:

````markdown
### Retiring the legacy `~/tokenstack-wt-*` worktrees (coordinated — NOT unilateral)

The old scattered worktrees are being actively used by other agents. Retire them safely:

1. **Never** remove a worktree with uncommitted work or a live agent. Check first:
   ```bash
   for w in ~/tokenstack-wt-*; do
     printf '%s  dirty=%s  last=%s\n' "$w" \
       "$(git -C "$w" status --porcelain 2>/dev/null | wc -l | tr -d ' ')" \
       "$(git -C "$w" log -1 --format=%cr 2>/dev/null)"
   done
   ```
2. For each worktree whose agent has finished AND `dirty=0` AND its PR is landed/abandoned:
   ```bash
   git -C /Users/ysufrin/tokenstack worktree remove <path>
   git -C /Users/ysufrin/tokenstack worktree prune
   ```
3. New work uses `~/myelin-agents/` immediately; the human's `~/tokenstack` + `~/Work/headroom-lite` stay as-is.
4. Safe-anytime cleanups (with the human's OK): delete `~/tokenstack-scratch-backup-*` once confirmed unneeded, and remove the empty legacy `~/tokenstack-worktrees/` dir.
````

- [ ] **Step 2: Verify markdown renders (no broken fences)**

```bash
grep -c '```' CLAUDE.md          # expect: an EVEN number (all fences closed)
```

Expected: an even count.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): add coordinated legacy-worktree retirement checklist"
```

---

### Task 4: Final verification + PR

**Files:** none (verification + PR only).

**Interfaces:**
- Consumes: Tasks 1–3 commits on branch `docs/agent-workspace-model`.
- Produces: a rebased branch + PR awaiting human merge approval.

- [ ] **Step 1: Confirm no `src/` changes and full suite is green**

```bash
git diff --name-only origin/main...HEAD          # expect: only docs/, .github/copilot-instructions.md, CLAUDE.md
npm test                                          # expect: pass (docs-only → no regression)
```

Expected: no files under `src/`; test suite passes (pre-existing unrelated failures, if any, unchanged).

- [ ] **Step 2: 3-model code review**

Run a 3-model review (multi-round-review / dispatch) on the diff. Address any high-confidence findings, re-commit.

- [ ] **Step 3: Rebase on latest origin/main, push, open PR**

```bash
git fetch origin && git rebase origin/main
git push -u origin docs/agent-workspace-model
gh pr create --base main --head docs/agent-workspace-model \
  --title "docs: per-agent workspace model + scratch isolation" \
  --body "Implements docs/superpowers/specs/2026-07-14-agent-workspace-model-design.md. Docs-only; no src/ changes."
```

- [ ] **Step 4: ASK the human to approve the merge**

Do not merge without explicit approval.
