# Agent Workspace Model — per-agent worktrees, bare canonical, scratch isolation

**Status:** Design (approved model, pending spec review)
**Date:** 2026-07-14
**Scope:** Local development workflow for the myelin / headroom-lite projects.
**Applies to:** every agent/session that develops these repos, plus the human dev.

---

## 1. Problem

Development sessions have been sharing and dirtying a single checkout:

- The root checkout `~/tokenstack` was repeatedly left on a **detached HEAD**, dirty
  with **100+ untracked scratch files** (test-*.mjs, *.diff, *.patch, throwaway dirs).
- Worktrees were scattered as siblings directly in `$HOME`
  (`~/tokenstack-wt-*`), 10+ at a time, with no container.
- There was **no rule** for where scratch/tmp/experiment files go, so they landed
  in the repo working tree and showed up as untracked noise.
- The documented helper `myelin worktree add` **does not exist** in the shipped
  CLI — agents improvised `git worktree add`, sometimes working in the root
  checkout itself.

Net effect: an unmanageable, error-prone workspace where agents step on each
other and on the source of truth.

## 2. Goals / Non-goals

**Goals**
- Each agent gets its **own isolated live-work directory** (its "computer").
- The **source of truth** for each repo cannot be clobbered by an agent's
  `git clean`, `reset`, or detached-HEAD experiments.
- **Scratch/tmp files physically cannot dirty any repo.**
- A single agent can work across **multiple repos** (myelin + headroom-lite).
- Serena indexing is reused as much as the (path-baked) cache allows.
- **Zero new code in the myelin library** — this is dev workflow, not a product
  feature. Any future helper belongs in a *separate dev-tools library*.

**Non-goals**
- Not building a `myelin worktree` CLI command (deferred to a separate tools lib).
- Not sharing Serena's on-disk symbol cache across differently-pathed worktrees
  (proven impossible — see §6).
- Not changing anything about how myelin compresses or proxies traffic.

## 3. The model

Each agent is treated like a developer with their own computer. Its workspace is
a directory containing **worktrees** of every repo it works on, plus a scratch
area. All worktrees for a project attach to a single **bare canonical repo** that
has **no working tree of its own** — so nothing works *in* the source of truth.

```
~/myelin-agents/
├── .bare/
│   ├── myelin.git/            # bare canonical mirror of yehsuf/myelin (no worktree)
│   └── headroom-lite.git/     # bare canonical mirror of yehsuf/headroom-lite
├── <agent>/                   # one directory per agent = its "computer"
│   ├── myelin/                # worktree of .bare/myelin.git   (stable path)
│   ├── headroom-lite/         # worktree of .bare/headroom-lite.git (added on demand)
│   └── scratch/               # this agent's scratch — SIBLING of the repos
└── <other-agent>/ …
```

Why this shape:

- **Bare canonical, no working tree** → the source of truth cannot be dirtied,
  `git clean -x`'d, reset, or left detached. All the failure modes we hit require
  a working tree; the canonical has none.
- **Per-agent worktrees at stable paths** → full working-tree isolation between
  agents, shared object store (lean disk — one copy of history per project),
  and a **stable path per repo per agent** so Serena's path-baked cache stays
  warm across branch switches within that agent (§6).
- **Scratch as a sibling of the repos** (not inside them) → physically outside
  every git working tree, so it can never appear as untracked repo noise.
- **Multi-repo is natural** → add one worktree per repo into the agent dir.

"The code location is one": there is exactly **one** canonical object store per
project (the bare repo); every agent's working tree is a view onto it.

## 4. Rules (to be added to the constitution + CLAUDE.md)

1. **Canonical repos are bare and untouched.** Never `cd` into `.bare/*.git` to
   do work. Its only jobs: hold objects/refs and spawn worktrees. Keep it synced
   with `git --git-dir=~/myelin-agents/.bare/<repo>.git fetch origin`.
2. **Every agent works only inside its own workspace** `~/myelin-agents/<agent>/`.
   Never work in another agent's directory or in the canonical.
3. **One worktree per branch per repo**, created off latest `origin/main`:
   ```
   git --git-dir=~/myelin-agents/.bare/myelin.git worktree add \
       ~/myelin-agents/<agent>/myelin -b <branch> origin/main
   ```
   Reuse the agent's stable worktree path across branches where practical (keeps
   Serena warm). Remove with `git worktree remove` + `git worktree prune` when done.
4. **Scratch/tmp/experiment files never go inside a repo working tree.** They go
   to the agent's `~/myelin-agents/<agent>/scratch/` (or the per-session
   `~/.copilot/session-state/<id>/files/`). Clean up when done.
5. **Parallel agents never share a worktree or workspace directory** (existing
   rule, reaffirmed).
6. **Never rewrite shared history** on the canonical (main/dev) — the object
   store is shared by all agents (existing rule, now higher-stakes).

## 5. Multiple repos, one agent

An agent that touches both projects simply holds two worktrees:

```
~/myelin-agents/<agent>/myelin/          # worktree of .bare/myelin.git
~/myelin-agents/<agent>/headroom-lite/   # worktree of .bare/headroom-lite.git
```

Each is an independent working tree on its own branch, pushed to its own origin,
PR'd independently. Cross-repo changes are coordinated by the agent but committed
per repo. Serena registers each worktree as its own project (one index each).

## 6. Serena indexing (verified constraints)

Empirically verified against `.serena/cache/<lang>/document_symbols.pkl`:

- The cache **bakes in absolute paths** — `file:///…/<worktree>/…` URIs plus full
  file contents (7,506 absolute-path occurrences in one sample). A cache built at
  path A is **invalid** at path B.
- There is **no per-file mtime/hash layer** visible; it behaves as a whole-project
  snapshot per language.

Consequences:
- **Cross-worktree cache sharing is unsafe** and is a non-goal.
- **Path stability is what preserves warmth.** Because each agent's worktree lives
  at a fixed path, its cache survives branch switches within that agent; only
  changed files get re-parsed. Reusing the agent's worktree path (rule §4.3) is
  therefore the primary indexing optimization.
- **Optional hygiene:** set `project_serena_folder_location` in
  `~/.serena/serena_config.yml` to e.g. `~/.cache/serena/$projectFolderName/.serena`
  so `.serena/` data lives outside the worktrees (leaner trees, one-folder cleanup).
  This does **not** dedupe indexing; it only relocates it.

## 6a. Agent ↔ code binding must be visible (statusline)

Because multiple agents run concurrently, at any moment it must be **obvious which
agent is bound to which code** — which workspace, repo, and branch the current
session is operating in. This is surfaced in the Copilot CLI **statusline** and is
delivered by the pending `statusbar-config` todo (this spec extends its scope).

Key design point: **the workspace path is the identity.** No marker file or extra
state is required. From the session's CWD the statusline derives:

- `agent`   = the path segment immediately under `~/myelin-agents/` (e.g. `architect`)
- `repo`    = the next segment (e.g. `myelin`, `headroom-lite`)
- `branch`  = `git rev-parse --abbrev-ref HEAD` in that worktree

producing a statusline fragment such as:

```
⬡ architect · myelin@docs/agent-workspace-model
```

alongside the myelin compression/health items the `statusbar-config` todo already
covers (myelin active/inactive, headroom-lite + mitm health, compression savings,
active backend/engine).

An optional `~/myelin-agents/<agent>/.agent-id` file may hold a friendlier display
name, but the path-derived value is the default and requires no bookkeeping.
Resolution is pure and path-based, so it works identically on Mac, Linux, and
Windows.

## 7. Enforcement

Documentation only — no library code:

- **`.github/copilot-instructions.md` (constitution):** add the §4 rules as
  standing invariants every agent reads at session start.
- **`CLAUDE.md`:** replace the stale `myelin worktree add` instructions and the
  old `~/tokenstack-wt-<name>` sibling convention with the workspace model, the
  bare-canonical setup, and the scratch rule. Note that a helper command, if ever
  built, belongs in a *separate dev-tools library*, not myelin.
- **`.gitignore`:** no change required — worktrees and scratch both live entirely
  outside every repo, so there is nothing new to ignore.

## 8. Setup (representative — exact commands go in the implementation plan)

Bootstrap a bare canonical + first agent worktree:

```bash
mkdir -p ~/myelin-agents/.bare
git clone --bare git@github.com:yehsuf/myelin.git ~/myelin-agents/.bare/myelin.git
git --git-dir=~/myelin-agents/.bare/myelin.git config remote.origin.fetch \
    '+refs/heads/*:refs/remotes/origin/*'
git --git-dir=~/myelin-agents/.bare/myelin.git fetch origin
# add an agent worktree off origin/main
git --git-dir=~/myelin-agents/.bare/myelin.git worktree add \
    ~/myelin-agents/<agent>/myelin -b <branch> origin/main
```

headroom-lite is set up the same way when an agent needs it.

## 9. Migration of the current mess (coordinated, NOT unilateral)

The current `~/tokenstack-wt-*` worktrees and detached root are being actively
used by parallel agents (commits within seconds observed). Migration constraints:

- **Do not delete or move any worktree with uncommitted work or a live agent.**
- Existing worktrees are drained naturally: each agent finishes → lands/abandons
  its PR → its worktree is removed with `git worktree remove` + `prune`.
- New work adopts the workspace model immediately; old worktrees are retired as
  they complete.
- The root checkout `~/tokenstack` is already restored to clean `main` and stays
  as the human's workspace (or is itself migrated to an agent dir later).
- The `~/tokenstack-scratch-backup-*` folder is deleted once its contents are
  confirmed unneeded.
- Retire the empty legacy `~/tokenstack-worktrees/` dir.

## 10. Validation

Because this is a workflow/doc change:

- **Constitution lint:** `myelin constitution` check must pass on the edited
  `.github/copilot-instructions.md`.
- **Bootstrap smoke test:** create `.bare/myelin.git` + one agent worktree in a
  throwaway location, confirm `git status` clean, `node --test` passes there, and
  Serena registers the worktree, then remove it.
- **No src/ changes** → no unit-test impact expected; run the full suite once to
  confirm nothing regressed.

## 11. Resolved decisions

- **Agent naming:** the `<agent>` directory name is a short human-readable role
  name chosen when the workspace is created (e.g. `architect`, `reviewer`,
  `task-runner`). The **path encodes the identity** — the statusline derives the
  agent from `~/myelin-agents/<agent>/…` (§6a), so no registry or id file is
  required (an optional `.agent-id` may override the display name).
- **Human checkouts:** `~/tokenstack` and `~/Work/headroom-lite` **stay as-is** as
  the human's workspace for now; they are not migrated into the bare model. Agents
  use `~/myelin-agents/`. Revisit only if the human wants the same isolation.
