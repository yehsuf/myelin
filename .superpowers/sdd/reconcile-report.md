# Reconcile Report — atomic-update/backend-selection onto origin/main

**Status:** ✅ COMPLETE — Option A reconciliation executed on latest `origin/main`.
All tests green under an isolated temporary HOME. Not pushed (parent will review/push).

**Worktree:** `/Users/ysufrin/tokenstack-wt-reconcile-atomic-update`
**Branch:** `reconcile/atomic-update-backend-selection`
**Base:** `origin/main` = `ef84eaa` (merge-base with HEAD = `ef84eaa`, i.e. 0 behind main)
**origin/feat/atomic-update-backend-selection:** `3c34c6d` — untouched (reviewed feature tip)
**Backup ref:** `reconcile-pre-A-backup` = `3c34c6d`
**Resulting HEAD:** `3ea4532` (code tip; this report is committed on top)
**Guardrails honored:** no push, no merge-to-main, no tag, no publish, no force-push,
no installer/service/live-HOME action. All tests used an isolated `HOME`/`USERPROFILE`
(`.superpowers/rec-testhome`, since cleaned).

---

## Decision executed: Option A

Per approval, main's `proxy.engine` / `proxy.compression` / `proxy.copilot_headroom`
model is canonical. The feature's Tasks 1–5 `compression.backend` schema/service/tests
were **retired** (never brought over — main already lacks them, so nothing to delete).
The feature's genuinely-unique Tasks 6–11 value was **preserved and adapted** onto the
canonical config model. The four orthogonal main commits (`e58235a` mitm streaming,
`446822a` Responses sidecar, `169ffb1` completion-endpoint, `3d3c51b` docs) are already
present because the work is based directly on `ef84eaa`.

### Execution mechanism
This was **not** a literal 67-commit rebase (the feature's Tasks 1–5 commits collide
head-on with main's `ef84eaa` on the same config/service/install files, with contradicting
tests on both sides — no hunk-level merge exists). Instead the branch was reset to
`origin/main` and the Tasks 6–11 deliverable was reconstructed on top as a coherent series,
faithfully preserving its behavior while binding it to main's canonical config model.

---

## What was brought over (Tasks 6–11)

**New, self-contained update subsystem** (verbatim from reviewed `3c34c6d`):
`src/update/` — `update-orchestrator.mjs`, `component-installers.mjs`,
`component-manifest.mjs`, `managed-service-binary.mjs`, `version-store.mjs`,
`release-store.mjs`, `release-channels.mjs`, `verify-stable-version.mjs`,
`update-lock-heartbeat.mjs`, `heartbeat-failure-budget.mjs`.
Workflows: `.github/workflows/release-publish.yml`, `release-validation.yml`
(read-only validation + trusted `workflow_run` publisher).
Tests: `component-installers`, `component-manifest`, `release-channels`,
`release-publish-workflow`, `release-store`, `release-validation-workflow`,
`verify-stable-version`, `version-store`, `task10-review-fixes`, `workflow-test-helpers`,
plus new sections of `update.test`.

**New adapter (the reconcile linchpin):** `src/update/engine-selection.mjs`.
Maps main's canonical config to the shapes the update subsystem expects, so the update
code needs no `compression.backend` awareness:
- `resolveCompressionConfig(config)` → `{ backend, copilotProxy:{enabled,port} }` where
  `backend` ∈ `headroom-lite | headroom-original | disabled` is derived from
  `proxy.engine` (`headroom_lite`→`headroom-lite`, `headroom`→`headroom-original`) and
  `proxy.compression.enabled:false`→`disabled`; `copilotProxy` from `proxy.copilot_headroom`.
- `selectedBackend`, `buildCompressionRuntimes`, `probeCompressionHealth` delegate to
  main's `normalizeCompressionEngine` / engine-runtime helpers.
- `migrateLegacyCompressionConfig` is a no-op (main owns config migration).

**Rewiring:** `update-orchestrator.mjs` and `cli/update.mjs` now import
`resolveCompressionConfig` from `./engine-selection.mjs`; `cli/index.mjs` gains the update
command wiring.

**Reverted to main** (feature's edits were only for an auxiliary drift-check path, not the
critical update path): `src/detect/tools.mjs`, `src/tools/rtk.mjs`, `src/tools/uv.mjs`,
`src/service/npmlink.mjs`, `src/service/token-optimizer.mjs`. The orchestrator detects
managed components via `component-installers.detectManagedComponent` directly, so main's
`detect/tools.mjs` is sufficient.

---

## Reconciliation decisions (conflicts resolved)

1. **Config model collision (Tasks 1–5 retired).** Resolved toward main's `proxy.engine`
   throughout. Update-subsystem tests that fed the retired `compression.backend` shape were
   converted to the canonical shape:
   - `test/update-orchestrator.test.mjs`: 6 `config.compression.backend` inputs + the
     `rawConfig()` default + two assertions rewritten to `proxy.engine`. (29/29 pass.)
   - `test/task10-review-fixes.test.mjs`: 16 retired-shape occurrences converted
     (`compression.backend:'disabled'`→`proxy.compression.enabled:false`;
     `headroom-lite`→`proxy.engine:'headroom_lite'`). Finding-3 proxy-backbone assertion
     rewritten to canonical component-install gating.

2. **`--update-apply` staged-apply path integrated into canonical `install.mjs`.** The
   feature's transactional install region was implemented against the RETIRED feature
   install architecture (`buildInstallPlan`, `resolveCompressionServicePaths`,
   `buildInstallSslEnvs`, `removeLegacyCompressionServices`, `assertInstallMutationFence`).
   Under Option A this was re-implemented using main's canonical mechanisms, additively and
   gated so the default (non-`--update-apply`) install path is byte-for-byte unchanged:
   - New flags `--update-apply` / `--update-token` / `--staged-release`; single gate
     `const runGlobalComponentInstalls = !flags['update-apply'];`.
   - Global component installs (`[1/7]` uv, `[2/7]` code-discovery, `[3/7]` headroom, rtk,
     mitmproxy) suppressed under `--update-apply` (finding 3).
   - One-time `~/.tokenstack`→`~/.myelin` migration gated behind
     `!flags['dry-run'] && !flags['update-apply']` (finding 11).
   - `combinedCert = flags['update-apply'] ? null : await buildCombinedCaCert(...)`
     (finding 12-part1).
   - Managed pinned binaries resolved under `--update-apply` via
     `resolveManagedCompressionBinary` and `resolveManagedMitmBinary`
     (`updatePaths(home).componentsRoot`), threaded into the service plan; global
     `ensureMitmproxy` confined to the non-update-apply branch (findings 10, 14).
   - `ensureMitmproxy` promoted to an exported, injectable, WSL-aware helper.
   - `applyServiceEngineInstallPlan` gained additive `managedCompressionBin` (pinned binary
     override for both engines) and `skipObsoleteCleanup` (suppresses every owned-instance
     removal during a staged apply) parameters.

3. **Two source-regex assertions adapted (findings 12-part2, 15).** These asserted the
   retired feature helpers `buildInstallSslEnvs` (local/service SSL split) and
   `removeLegacyCompressionServices`. Main uses a single `sslEnv`
   (`buildCorporateSslEnv`) and performs obsolete-instance cleanup inside
   `applyServiceEngineInstallPlan` (`removeObsoleteOwnedInstances`). Faithfully satisfying
   the original regexes would require reintroducing the retired architecture — a direct
   Option A violation. The **requirements were preserved canonically** (staged apply does
   not regenerate/append CA bundles; obsolete cleanup is gated off), and only the two
   implementation-coupled regexes were re-pointed at the canonical structure:
   - finding 12-part2 → asserts an `else if (flags['update-apply'])` no-write CA-reuse
     branch (references the managed release bundle) preceding `} else if (mitmdumpBin) {`.
   - finding 15 → asserts `skipObsoleteCleanup: flags['update-apply']` is threaded into the
     service install plan.
   Both adaptations are annotated inline in the test with a "Reconcile note (Option A)".

---

## Tests (isolated HOME/USERPROFILE)

| Scope | Result |
|---|---|
| `test/task10-review-fixes.test.mjs` (17 findings, incl. install gate) | **55 pass / 0 fail** |
| Targeted: update-orchestrator, update, component-installers, version-store, release-store, install | **156 pass / 0 fail** |
| Full `node --test test/*.test.mjs` | **926 pass / 0 fail** |
| `node --check src/install.mjs` | OK |

Baseline reference: reviewed feature HEAD `3c34c6d` was 928/0. The reconciled branch is
926/0; the delta reflects retiring the feature's Tasks 1–5 `compression.backend` tests and
adopting main's canonical config tests (net different test set, all green).

---

## Concerns / follow-ups for the reviewer

1. **Findings 12-part2 & 15 are source-structure assertions that were adapted**, not
   behavior tests. The behavior (no CA mutation / no obsolete-instance removal during a
   staged apply) is enforced in `install.mjs`, but these two tests verify *how* it is
   written. If the team prefers a behavioral test (spawning `install.mjs --update-apply`
   against a fixture and asserting no CA/service mutation), that would be more robust than
   the regex form. Flagged for review.
2. **`--update-apply` staged-apply is exercised at the source/unit level** (task10 regexes
   + orchestrator tests with mocked spawn), not end-to-end on a live machine (per the
   no-installer/no-service guardrail). A full staged-apply integration run on each platform
   should be part of pre-merge validation.
3. **`managedCompressionBin` threading for `headroom_lite`** now bypasses the global
   `detectTool('headroom-lite')` when a pinned binary is supplied. This is only active under
   `--update-apply`; the default path is unchanged. Worth a focused review of the Windows
   service-executable resolution for the pinned-binary case.
4. **"Do not drop commits" tension:** the feature's Tasks 1–5 commits are intentionally not
   represented as commits (their design is retired under Option A). This is the approved
   consequence of choosing main's canonical config model, but it is a deviation from a
   literal reading of that guardrail and is called out explicitly here.
5. **`git rerere`** was left enabled (local config only) from the earlier rebase attempt.

## Not done (per guardrails)
No push, no merge to main, no tag, no publish, no installer/service/live-HOME action.
Parent will review and push.

---

## Review-fix pass (8-finding code review of the reconcile branch)

**Status:** ✅ COMPLETE — all 8 confirmed findings fixed RED→GREEN. Full suite
`node --test test/*.test.mjs` = **955 pass / 0 fail** under isolated
`HOME`/`USERPROFILE`. `node --check src/install.mjs` OK. Not pushed / not merged /
no tag / no publish / no installer/service/live-HOME action. `proxy.engine` model
and all existing feature guarantees preserved.

New test suite: `test/reconcile-review-fixes.test.mjs` (27 tests, one describe
block per finding).

### Findings & fixes

| # | Sev | Area | Fix | Tests |
|---|-----|------|-----|-------|
| 1 | High | install.mjs mutation fence | Restored the staged-apply authorization + global-install-lock mutation fence dropped during Option A. `assertStagedApplyAuthorization` validates the exported transaction env (token / staged-release dir / config path) and re-asserts the orchestrator's nested lock; ordinary installs acquire the global update lock (+heartbeat, released on exit). `createInstallMutationFence` re-asserts the held lock before **every** numbered phase `[1/7]…[5/7]`. Fails closed with no held lock. | 7 |
| 2 | High | install.mjs compression-disabled | `resolveStagedCompressionBinary` gates on `selectedBackend(cfg)`; when `proxy.compression.enabled === false` the backend is `disabled` and **no** compression binary is resolved/staged. Replaces the buggy `enginePlan.engine ? 'headroom-original' : 'headroom-lite'` resolution that always staged a backend and `.binPath`-dereferenced a possibly-null result. | 4 |
| 3 | High | install.mjs global-install suppression | Verified/locked `runGlobalComponentInstalls = !flags['update-apply']` gates package-manager, code-discovery, headroom and rtk installs, threads `installIfMissing` into mitmproxy, and skips the one-time legacy migration; each mutation phase is fenced. | 5 |
| 4 | High | staged-child identity | Pre-spawn `unresolvedChild` marker + `onChildSpawn` pid-fill + post-completion resolved-mark in `activateUpdate`; recovery defers while a recorded child is alive. | 2 |
| 5 | High | WSL POSIX storage | `resolveStoragePlatform` maps windows-bridged WSL → `linux` for component/release/lock/journal storage while service management stays on `windows`; threaded through 19 storage sites. | 3 |
| 6 | High | ownership-preserving lock release | `release()` rewritten to rename-verify-restore-unlink; never unlinks a concurrently-reclaimed lock. | 2 |
| 7 | High | WinSW fail-closed checksum | `stageGithubBinary` resolves a reviewer-pinned checksum first and gates with `ERR_COMPONENT_CHECKSUM_MISSING`; manifest `winsw` entry gained `requireVerifiedChecksum:true` + pinned SHA256s (x64/x86/net461). | 4 |
| 8 | High | workflow SHA pinning | `release-publish.yml` pins `actions/checkout@11bd719…` (v4.2.2) and `actions/setup-node@49933ea…` (v4.4.0) to immutable commit SHAs. | 2 |

### Reconcile note (test drift caught by full-suite run)
`test/release-publish-workflow.test.mjs` located the checkout step via the literal
`actions/checkout@v4`; finding-8 SHA pinning made that finder miss. Updated the
finder to `step.uses?.startsWith('actions/checkout@')` — preserves the test's real
intent (`with.ref === '${{ github.event.workflow_run.head_sha }}'`) independent of
the pinned SHA.

### Concerns / follow-ups
1. Findings 1–3 are exercised at unit/source level (injected-dependency fence
   functions + install.mjs source-structure assertions), not via an end-to-end
   `install.mjs --update-apply` spawn against a fixture. A behavioral e2e apply
   test would be more robust but requires a full staged-release fixture.
2. Ordinary `myelin install` now acquires the shared update lock for its whole
   run (matching the feature's design). Concurrent `install` + `update` now
   mutually exclude — intended, but a behavior change vs. the reconcile tip.
