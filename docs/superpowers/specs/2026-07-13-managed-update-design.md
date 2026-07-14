# Managed Update Command Design

## Goal

Make `myelin update` the single managed self-update command. It must update the
selected Myelin runtime, re-apply managed integration, retain external tool
updates and service restart behavior, and never depend on a mutable deployment
checkout.

## Public Command Contract

`myelin update` performs this sequence:

1. Stage and validate the newest `main` runtime.
2. Atomically activate it through the managed current pointer.
3. Write the stable launcher.
4. Run the selected runtime's installer with `--yes` to refresh bridges,
   services, wrappers, hooks, shell configuration, and MCP configuration.
5. Report stale user configuration keys.
6. Run the existing external-tool upgrade and restart flow.

`myelin update --download-only` stages and validates the newest release but
does not modify the current pointer, stable launcher, aliases, services,
wrappers, hooks, MCP configuration, or external tools. The staged release is
retained for a later normal update.

`myelin update --self` and `myelin self update` are rejected with migration
messages directing the user to `myelin update`.

## Runtime Root

All managed-runtime consumers use one root:

1. `MYELIN_DIR` when it is set and non-empty.
2. Otherwise, `<home>/.myelin`.

This resolver is the sole source for every user-global Myelin path: release
directory, pointer, stable launcher, runtime bridges, configuration, RTK hook
target, service state, virtual environments, logs, CA bundle, memory, and
tool paths. Bootstrap scripts export the selected root so their staged runtime
and the Node installer use the same location. Generated Node and Python
bridges read the same environment override at invocation time.

The implementation uses one dependency-free shared ESM path module. It is the
only source allowed to construct a user-global Myelin path. Repository-local
project `.myelin` directories, shell-profile locations, `.serena` state, and
operating-system service labels remain unchanged.

## Staging and Activation Safety

Staging always clones and validates a candidate in a temporary directory.
Validation includes dependency installation and CLI validation. A candidate
does not replace an existing release directory until validation succeeds.

For normal updates, promotion replaces an existing incomplete target release
only after the candidate is valid, then atomically writes the current pointer.
For download-only updates, the validated candidate is stored as a release but
the current pointer is never written. A failed stage leaves the current
pointer and its currently selected runtime directory untouched, including
same-commit restages.

Bootstrap `--dry-run` and `--check` do not activate a release or write the
managed pointer. They may use a temporary candidate only to execute the
requested non-mutating installer behavior, and must clean it afterward.

## Integration and Error Handling

The normal managed update first promotes a validated release, then runs its
installer. If the installer fails, `myelin update` reports the failure and
returns nonzero; the selected runtime remains active because it was already
validated. Users can rerun `myelin install --yes` to retry integration.

External-tool update failures retain the existing per-tool warning behavior.
They do not roll back a successfully promoted Myelin runtime. The existing
restart behavior remains after tool processing.

## Documentation Migration

README installation, reconfiguration, profile, and update examples use the
managed launcher and installer commands. They must not instruct users to
clone, reset, or run a deployment checkout under `~/.myelin/repo`.

## Validation

Tests must cover:

- POSIX and Windows custom `MYELIN_DIR` resolution through the release store,
  launcher, Node bridge, Python bridges, installer, RTK hook, configuration,
  services, virtual environments, logs, CA bundle, memory, and tool paths.
- `myelin update --download-only` retaining a validated release without
  changing the current pointer or integration artifacts.
- Normal `myelin update` promoting the runtime, invoking managed integration,
  reporting stale configuration, retaining external upgrades, and restarting.
- Migration errors for `update --self` and `self update`.
- Bootstrap `--dry-run` and `--check` preserving the pointer.
- A same-commit incomplete current release surviving a failed restage.
- README examples containing no mutable deployment-checkout update path.

No new runtime dependencies, symlinks, or runtime Git checkout operations are
introduced. macOS, Windows, and Linux share the managed release layout.
