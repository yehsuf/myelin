---
name: updating-services
description: Use when bumping a pinned managed component/service version in myelin — headroom-lite, headroom-ai, serena, semble, agentcairn, rtk, winsw, ast-grep, mitmproxy, codegraph, token-optimizer — editing src/update/component-manifest.mjs, tagging a headroom-lite release, or when `myelin update`/`myelin install` fails on a version or ref mismatch.
---

# updating-services — bump a managed component version

> **Developer-only skill.** This is internal tooling for people **developing myelin
> itself** — it is deliberately NOT wired into `installCopilotSkills`, so `myelin
> install` never ships it to end users. Developers get it via the one-time symlink
> in "Developer setup" below (see CLAUDE.md).

Myelin provisions external tools as **immutable pinned components** defined in
`src/update/component-manifest.mjs`. Updating one is never "just change a number":
the pin format, the paired git-ref, checksums, and the assertion tests all move
together, and every bump is validated on all 3 platforms before it ships.

## When to use
- Bumping any component in `component-manifest.mjs` to a new release.
- Publishing a new **headroom-lite** release (our own repo) and wiring myelin to it.
- `myelin update`/`install` errors: `version must be an exact pinned version`,
  `ref must be a valid git ref pin`, `require verified checksum`, or a component
  installs the wrong version.

## Developer setup (one-time, per dev machine)

This skill is NOT installed by `myelin install` (dev-only). Make it discoverable by
symlinking the git-tracked repo copy from your clean reference checkout into the
Copilot skills dir:

```bash
mkdir -p ~/.copilot/skills/updating-services
ln -sf ~/tokenstack/skills/updating-services/SKILL.md \
       ~/.copilot/skills/updating-services/SKILL.md
```

`~/tokenstack` stays on clean `main`, so `git pull` there refreshes the skill (and
its Learnings) in place. On Windows/Linux dev boxes, point the link at that machine's
myelin checkout instead.


## The manifest is the single source of truth

`src/update/component-manifest.mjs` → `RELEASED_COMPONENTS`. Each entry has a
`kind`; the validator (`validateComponentManifest`) enforces different rules per kind.
**Get the pin shape right or the manifest fails to load at all.**

| kind | Fields to bump | Pin rules (enforced by validator) |
|------|----------------|-----------------------------------|
| `npm-git` | `version` + `ref` | `version` = full semver (prerelease `-N` OK); `ref` must equal `` `v${version}` `` |
| `github-binary` | `version` + `ref` (+ `checksums`) | `version` = full semver; `ref` = `` `v${version}` ``; if `requireVerifiedChecksum`, regenerate every SHA256 |
| `npm` | `version` | `version` = full semver (no ref) |
| `uv-venv` | `version` | PyPI package; exact pinned version, no ref |
| `uv-git` | `version` + `ref` | `ref` MUST be a full 40-hex commit SHA (NO `v` prefix) |
| `git-checkout` | `version` + `ref` | `version` = short SHA (7–40 hex); `ref` = full 40-hex SHA; **`ref` must start with `version`** |

## Finding the latest version

| kind | Command |
|------|---------|
| `npm` / `npm-git` (npm pkg) | `rtk npm view <pkg> version` |
| `uv-venv` (PyPI) | `rtk curl -s https://pypi.org/pypi/<pkg>/json \| python3 -c "import sys,json;print(json.load(sys.stdin)['info']['version'])"` |
| `uv-git` / `git-checkout` | `rtk git ls-remote --tags <repo>` (newest tag) or `git ls-remote <repo> HEAD` (HEAD-tracking) |
| `github-binary` | `rtk gh api repos/<owner>/<repo>/releases/latest --jq .tag_name` |

## Update procedure

1. **Confirm the target version + ref** using the table above. For `uv-git`/`git-checkout`,
   resolve the FULL commit SHA (`git ls-remote <repo> refs/tags/<tag>` → 40-hex).
2. **Worktree, never main.** `git --git-dir=$HOME/myelin-agents/.bare/myelin.git worktree add ~/myelin-agents/<agent>/myelin -b chore/dep-<name>-<ver> origin/main`.
3. **Edit the manifest** entry — bump `version` (+ `ref`, + `checksums`) per the kind's rules.
4. **Update the assertion tests** that pin the exact value — search both:
   - `test/component-manifest.test.mjs` (`COMPONENTS.<name>.version` / `.ref` + the full `deepEqual`)
   - `test/component-installers.test.mjs` (the install-command path/URL for that component)
   Run: `rtk grep -rn "<old-version>" test/ src/` and fix every real assertion (skip unrelated fixtures & the separate `headroom-ai` Python pin).
5. **Targeted tests first:** `node --test test/component-manifest.test.mjs test/component-installers.test.mjs test/install.test.mjs test/update-orchestrator.test.mjs`.
6. **3 platforms.** Full suite on Linux (`muc-lhvsuz`) or Windows (`yeh-legion`); on the Mac run ONLY targeted files — NEVER `npm test` / `test/service*.test.mjs` on the live-proxy Mac.
7. **3-model CR** (Opus + GPT + Gemini). Embed the diff in the prompt (subagents can't read parent-session files).
8. **PR → ask for merge approval.** Never merge without explicit approval.
9. **Deploy + verify.** After merge, `myelin update` each machine, then `myelin verify` must pass. For MCP components (serena, semble, cairn) confirm the server still starts.
10. **Append a Learning** below if anything surprised you.

## headroom-lite is OUR repo — extra steps

headroom-lite (`github:yehsuf/headroom-lite`, kind `npm-git`) is developed in-house.
To ship a change:
1. Merge the headroom-lite PR to its `main`.
2. **Create + push the git tag** `` git tag -a v<version> <sha> -m "…" && git push origin v<version> `` — the manifest `ref` installs the **tag**, so the branch merge alone is invisible to myelin.
3. **Versioning convention:** headroom-lite tracks upstream **headroom** versions. Between upstream releases, use a prerelease suffix: `0.31.0-1`, `0.31.0-2`, … (NOT `0.32.0` — that would claim an upstream headroom version that may not exist). Bump `package.json`, `CHANGELOG.md`, and `test/package-release.test.mjs` together.
4. THEN bump the myelin manifest `version` + `ref` to `v<version>` in a separate myelin PR.

## Common mistakes

- **Editing `version` but not `ref`** on `npm-git`/`github-binary`/`uv-git`/`git-checkout` → manifest load throws.
- **Putting a `v` prefix on a `uv-git` ref** — those take a bare 40-hex SHA.
- **`git-checkout` version/ref mismatch** — the validator requires `ref.startsWith(version)`; set `version` to the short prefix of the full-SHA `ref`.
- **Forgetting winsw checksums** — a `github-binary` with `requireVerifiedChecksum` needs fresh SHA256 for every listed asset or install fails closed.
- **Bumping `headroomOriginal` when you meant `headroomLite`** — `headroomOriginal` is the Python `headroom-ai` PyPI pin; `headroomLite` is the Node.js sidecar. They share version numbers but are different components.
- **Only updating the manifest, not the tests** — `component-manifest.test.mjs` `deepEqual`s the WHOLE manifest; a stale expected value fails.
- **Running the full suite on the Mac** — clobbers the live proxy. Targeted files only.

## Learnings (append-only — update at runtime)

> When a bump teaches you something the steps above didn't cover, append a dated
> bullet here (in your worktree) and include it in that bump's PR. This section is
> the living memory of service updates across sessions.

- **2026-07-17 · headroom-lite 0.31.0 → 0.31.0-1 (B4):** First use of the prerelease `-N` convention. `package.json` version, `CHANGELOG.md` heading, AND `test/package-release.test.mjs` (`assert.equal(pkg.version, …)` + the test title) all hardcode the version — a Windows-only failure surfaced because only the first two were changed. Bump all three together.
- **2026-07-17 · manifest bump 0.31.0 → 0.31.0-1:** Two test files assert the real `COMPONENTS.headroomLite` pin: `component-manifest.test.mjs` (version + ref + full `deepEqual`) and `component-installers.test.mjs` (the `npm install … github:yehsuf/headroom-lite#v0.31.0-1` command + `/components/headroomLite/<version>` prefix). Both must move with the manifest; other `0.31.0` matches were unrelated fixtures or the `headroom-ai` Python pin.
- **2026-07-17 · component audit:** Latest-version lookups that worked: `npm view <pkg> version`; PyPI `/json` → `info.version`; `git ls-remote --tags`; `gh api repos/<o>/<r>/releases/latest --jq .tag_name`. winsw's newest *release* was an `-alpha` pre-release (already pinned) while the newest *stable* tag was older — read release channels carefully before deciding "current".
