# Managed Runtime Installer Design

## Goal

Make deployed Myelin machines run a managed runtime rather than a mutable Git
checkout. A normal update must never depend on the current branch, worktree,
or uncommitted files.

## P0 Scope

The first slice implements a main-channel managed runtime:

1. Store a staged runtime at `~/.myelin/releases/main-<commit>`.
2. Point `~/.myelin/current` at the selected staged runtime.
3. Make the stable launcher at `~/.myelin/bin/myelin` resolve
   `~/.myelin/current/src/cli/index.mjs`, never a caller checkout.
4. Make the update path stage `origin/main` into a new release directory,
   install its declared Node dependencies, validate its CLI entrypoint, and
   atomically switch `current` only after validation succeeds.
5. Retain the previous runtime directory until a later cleanup policy is
   introduced.
6. Deprecate `myelin update --self`: it must direct users to managed update
   behavior rather than execute Git commands in the active runtime.

## Non-Goals

P0 does not add GitHub releases, tags, signed manifests, component version
stores, stable/beta channels, automatic rollback, or deletion of old
releases. Those require a release publication contract and are separate
backlog work.

## Safety Rules

- The launcher must never resolve `process.cwd()` or a development repository.
- A failed stage must not modify `current`.
- The old current runtime remains runnable after a failed update.
- Runtime update logic must not run `git status`, `git pull`, or switch a
  deployment host branch.
- Development worktrees remain separate and are not used by runtime commands.

## Platform Requirements

- macOS, Windows, and Linux use the same release-directory layout.
- Pointer resolution must use platform-safe filesystem APIs; no shell
  symlink assumption on Windows.
- Existing services and wrappers resolve the managed current runtime through
  the stable launcher or an explicit runtime root, never a development path.
- Persistent bridge files under `~/.myelin` (CLI bridge, mitm addon bridge,
  git-extra bridge, RTK hook target) must re-read `current.json` on each run
  and reject any pointer that does not match `~/.myelin/releases/<releaseId>`.

## Validation

Tests must prove:

- staging a candidate runtime does not change `current` before validation;
- successful staging switches `current` to the candidate;
- a failed stage preserves the old current runtime;
- the stable launcher resolves only the managed current runtime;
- first-run checkout installs bootstrap a managed current runtime before
  writing aliases, services, or hooks;
- `update --self` no longer performs Git-based update commands;
- the behavior is path-safe for Windows and POSIX paths.
