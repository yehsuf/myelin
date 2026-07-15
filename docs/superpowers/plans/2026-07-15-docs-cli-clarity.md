# Documentation & CLI Help Clarity Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix factual inconsistencies and tighten wording in README.md, docs/settings-reference.md, docs/copilot-headroom-architecture.md, and the `myelin` CLI's own `.description()`/`.option()` help text, so every doc claim and every documented command actually matches current code behavior.

**Architecture:** No new code, no behavior changes — text-only edits verified by cross-referencing `src/config/schema.mjs`, `src/cli/index.mjs`, `src/cli/config-cmd.mjs`, and `src/service/{launchd,systemd,windows}.mjs` (the sources of truth), then running the existing test suite to confirm nothing else asserts on the changed text.

**Tech Stack:** Markdown docs, Commander.js CLI (`src/cli/index.mjs`, `src/cli/config-cmd.mjs`), Node.js test runner (`node --test`).

## Global Constraints
- Text-only changes: no CLI flag behavior, no config schema, no service logic may change.
- Do not touch AGENTS.md, CLAUDE.md, .github/copilot-instructions.md, or any file under docs/specs/, docs/plans/, docs/superpowers/ (other than this plan/spec pair) — out of scope per spec `docs/superpowers/specs/2026-07-15-docs-cli-clarity-design.md`.
- Do not implement `myelin worktree` — report it as a known inconsistency only.
- Every fix must be traceable to a concrete mismatch verified against source code (no stylistic-only rewrites of already-accurate content).

---

### Task 1: Fix CLI help text in `src/cli/index.mjs` and `src/cli/config-cmd.mjs`

**Files:**
- Modify: `src/cli/index.mjs:53-58` (restart command description)
- Test: none new — covered by existing `test/cli-index.test.mjs` if present, otherwise manual `--help` check in Task 5

**Interfaces:**
- Consumes: nothing (pure string edit)
- Produces: updated help text shown by `myelin --help` / `myelin restart --help`

**Finding:** `restart.mjs` restarts whichever engine is selected (`headroom` or `headroom-lite`, confirmed by `src/cli/restart.mjs` referencing `headroom-lite` state/process handling throughout), but its Commander description still says only "Restart headroom and mitmproxy services" — doesn't mention headroom-lite.

- [ ] **Step 1: Update the `restart` command description**

In `src/cli/index.mjs`, find:
```js
program.command('restart')
  .description('Restart headroom and mitmproxy services')
```
Replace with:
```js
program.command('restart')
  .description('Restart the selected engine (headroom or headroom-lite) and mitmproxy services')
```

- [ ] **Step 2: Verify the CLI still parses**

Run: `node src/cli/index.mjs restart --help`
Expected: prints the new description with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/index.mjs
git commit -m "docs(cli): clarify restart command covers selected engine, not just headroom"
```

---

### Task 2: Fix README.md — Verify and Uninstall sections

**Files:**
- Modify: `README.md` (Verify section, lines ~139-157; Uninstall section, lines ~277-312)

**Interfaces:**
- Consumes: nothing
- Produces: corrected README sections for Task 5's verification pass

**Finding A (Verify section):** The "Expected output" block shows `✓ enforcement hooks active` and `✓ shell profile configured` lines. `src/cli/verify.mjs` has no check that produces either of those two lines (confirmed via `grep -n "shell profile\|enforcement hook" src/cli/verify.mjs` returning no matches). The real output varies by config and includes rows like headroom/mitm service+health, Watchdog, RTK, RTK hooks, ast-grep, semble.

**Finding B (Uninstall section):** The section has separate blocks for "Python Headroom" vs "Headroom Lite" using different service/plist/task names (`com.myelin.headroom-lite.plist`, `myelin-headroom-lite.service`, `MyelinHeadroomLite`). This is stale: `src/service/launchd.mjs:10-31`, `src/service/systemd.mjs`, and `src/service/windows.mjs:13-23` all confirm the label/service-id/task-name is fixed **per role** (`primary` → `com.myelin.headroom` / `myelin-headroom.service` / `MyelinHeadroom`; `copilot` → `com.myelin.copilot-headroom` / `myelin-copilot-headroom.service`), regardless of which engine (`headroom` or `headroom_lite`) is currently selected. There is no `-lite`-suffixed service name anywhere in the codebase. The Uninstall section also never mentions removing the optional copilot-headroom role service.

- [ ] **Step 1: Fix the Verify section's expected output**

Find:
```
Expected output:
```
```
✓ headroom proxy    :8787  healthy    # or: headroom-lite :8790 if proxy.engine=headroom_lite
✓ mitmproxy         :8888  healthy
✓ serena            MCP    ready
✓ semble            MCP    ready
✓ rtk               shell  ready
✓ enforcement hooks        active
✓ shell profile            configured
```
```

Replace with:
```
Expected output (rows vary by config — this is the default `proxy.engine: headroom` profile):
```
```
✓ headroom service   :8787  running    # or headroom-lite :8790 if proxy.engine=headroom_lite
✓ headroom health    :8787  healthy
✓ mitmproxy service  :8888  running
✓ rtk                       ready
✓ ast-grep                  ready
✓ semble                    ready
```
```

- [ ] **Step 2: Collapse the Uninstall section to one engine-agnostic block per OS, plus the optional copilot role**

Find the entire block from `## Uninstall` through the closing triple-backtick (the block shown above spanning the macOS/Linux/Windows Python-Headroom-vs-Lite pairs).

Replace with:
```
## Uninstall

The service name is the same regardless of which engine (`headroom` or `headroom_lite`) is selected — only one primary service and one optional copilot-role service ever exist.

```bash
# macOS
launchctl bootout gui/$(id -u)/com.myelin.mitmproxy 2>/dev/null
launchctl bootout gui/$(id -u)/com.myelin.headroom 2>/dev/null
launchctl bootout gui/$(id -u)/com.myelin.copilot-headroom 2>/dev/null   # only if proxy.copilot_headroom.enabled was true
rm ~/Library/LaunchAgents/com.myelin.mitmproxy.plist
rm ~/Library/LaunchAgents/com.myelin.headroom.plist
rm -f ~/Library/LaunchAgents/com.myelin.copilot-headroom.plist

# Linux
systemctl --user disable --now myelin-mitmproxy.service myelin-headroom.service myelin-copilot-headroom.service 2>/dev/null
rm -f ~/.config/systemd/user/myelin-mitmproxy.service ~/.config/systemd/user/myelin-headroom.service ~/.config/systemd/user/myelin-copilot-headroom.service
systemctl --user daemon-reload

# Windows
Unregister-ScheduledTask -TaskName "MyelinMitmproxy" -Confirm:$false
Unregister-ScheduledTask -TaskName "MyelinHeadroom" -Confirm:$false

# Edit ~/.zshrc (macOS) or ~/.bashrc (Linux) and remove the
# '# >>> myelin managed >>>' ... '# <<< myelin managed <<<' block
rm -rf ~/.myelin
```
```

- [ ] **Step 3: Verify the README renders sensibly**

Run: `rtk grep -n "headroom-lite.plist\|headroom-lite.service\|MyelinHeadroomLite" README.md`
Expected: no matches (all engine-specific duplicate names removed).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): fix stale Verify/Uninstall sections to match unified selected-engine service naming"
```

---

### Task 3: Fix docs/settings-reference.md — fabricated CLI commands

**Files:**
- Modify: `docs/settings-reference.md` (Index Tier section ~line 329; Rust LSP section ~lines 386-390; hooks section ~line 600; Quick Recipes ~line 800)

**Interfaces:**
- Consumes: nothing
- Produces: corrected settings-reference.md examples

**Findings (all verified against `src/cli/index.mjs`, `src/cli/init.mjs`, `src/cli/stats.mjs` — none of these commands/flags exist):**
- `myelin status` (line 329) — no `status` command is registered anywhere; the real command for RAM/usage info is `myelin stats`.
- `myelin init --enable-lsp rust` (line 389) — `src/cli/init.mjs` and its Commander registration in `index.mjs` only support `-y/--yes`, `-r/--recursive`, `-d/--depth <n>`; there is no `--enable-lsp` flag and no per-project config override mechanism exists in this codebase (config.yaml is global-only, confirmed via `grep -rn "per-repo config override" src/config`).
- `myelin hooks disable --for-session` (line 600) — no `hooks` command exists in `src/cli/index.mjs` at all.
- `myelin stats --last-session` (line 800) — `src/cli/index.mjs` only registers `--wide` for the `stats` command; `--last-session` does not exist.

- [ ] **Step 1: Fix the `myelin status` reference**

Find:
```
**Tip:** Use `myelin status` to see current RAM usage per LSP. Use `full` for your primary project, `light` for quick scripts or unfamiliar repos.
```
Replace with:
```
**Tip:** Use `myelin stats` to see current compression/usage stats. Use `full` for your primary project, `light` for quick scripts or unfamiliar repos.
```

- [ ] **Step 2: Fix the fabricated `--enable-lsp` per-project example**

Find:
```
**How to enable only for Rust projects:**
```bash
cd my-rust-project
myelin init --enable-lsp rust   # enables rust only for this repo
```

```yaml
code_discovery:
  serena:
    lsp:
      rust: true   # enable globally (requires 16GB+ free RAM)
```
```
Replace with:
```
**How to enable it:** `code_discovery.serena.lsp.rust` is a single global setting in `~/.myelin/config.yaml` — there is currently no per-project override.

```yaml
code_discovery:
  serena:
    lsp:
      rust: true   # enable globally (requires 16GB+ free RAM)
```
```

- [ ] **Step 3: Fix the fabricated `myelin hooks` command**

Find:
```
**What you lose:** Occasional friction when you explicitly WANT raw output. Override with `myelin hooks disable --for-session` to disable enforcement for one session without changing config permanently.
```
Replace with:
```
**What you lose:** Occasional friction when you explicitly WANT raw output. There is currently no per-session override command — disable a specific `output_style.*` key in `~/.myelin/config.yaml` and re-run `myelin install` to change enforcement persistently.
```

- [ ] **Step 4: Fix the fabricated `myelin stats --last-session` flag**

Find:
```
### "Reset to defaults and start over"
```bash
myelin config reset                # restores defaults (backs up current config)
myelin verify                      # confirms stack is healthy
myelin stats --last-session        # sanity check savings are working
```
```
Replace with:
```
### "Reset to defaults and start over"
```bash
myelin config reset                # restores defaults (backs up current config)
myelin verify                      # confirms stack is healthy
myelin stats                       # sanity check savings are working
```
```

- [ ] **Step 5: Verify no fabricated commands remain**

Run: `rtk grep -n "myelin status\|--enable-lsp\|myelin hooks\|--last-session" docs/settings-reference.md`
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add docs/settings-reference.md
git commit -m "docs(settings-reference): remove fabricated CLI commands/flags not present in source"
```

---

### Task 4: Consistency pass on docs/copilot-headroom-architecture.md

**Files:**
- Modify: `docs/copilot-headroom-architecture.md` (only if a mismatch is found; this file already matches `src/config/schema.mjs` closely)

**Interfaces:**
- Consumes: nothing
- Produces: confirmed-accurate architecture doc, or a small fix if found

- [ ] **Step 1: Re-verify every config key/default in the file against `src/config/schema.mjs`**

Run: `rtk grep -n "proxy\.\(engine\|headroom\.port\|headroom_lite\.port\|copilot_headroom\.\(enabled\|port\)\|mitm\.\(port\|egress_port\)\)" docs/copilot-headroom-architecture.md src/config/schema.mjs`
Expected: every key/default pair in the doc's "Configuration" table (lines 51-61) matches `src/config/schema.mjs` exactly (`engine: headroom`, `headroom.port: 8787`, `headroom_lite.port: 8790`, `copilot_headroom.enabled: false`, `copilot_headroom.port: 8788`, `mitm.port: 8888`, `mitm.egress_port: 8889`).

- [ ] **Step 2: If Step 1 shows a mismatch, fix it inline; if not, no edit needed — record "no changes required, verified accurate" for the final report.**

- [ ] **Step 3: Commit (only if Step 2 produced a change)**

```bash
git add docs/copilot-headroom-architecture.md
git commit -m "docs(architecture): fix config key/default mismatch vs schema.mjs"
```
(Skip this commit entirely if no changes were made.)

---

### Task 5: Full verification, push, PR, and inconsistency report

**Files:** none (verification only)

**Interfaces:**
- Consumes: all changes from Tasks 1-4
- Produces: pushed branch, open PR, chat-delivered inconsistency report

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: same pass/fail counts as the pre-existing baseline on `origin/main` (no new failures introduced by text-only changes). If any failure references a file touched in Tasks 1-4, investigate before proceeding; if it's unrelated pre-existing baseline noise, do not modify its test/code — just note it.

- [ ] **Step 2: Manual `--help` spot check**

Run: `node src/cli/index.mjs --help && node src/cli/index.mjs restart --help && node src/cli/index.mjs config --help`
Expected: clean help output, no Commander errors, restart description shows the new "selected engine" wording.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/docs-cli-clarity
```

- [ ] **Step 4: Open a PR to main**

```bash
gh pr create --base main --head feat/docs-cli-clarity \
  --title "docs: fix stale CLI/service references in README, settings-reference, CLI help text" \
  --body "Audit-and-refine pass. Fixes: unified selected-engine service naming in README Uninstall/Verify sections, fabricated CLI commands in settings-reference.md (myelin status, --enable-lsp, myelin hooks, stats --last-session), restart command help text. No behavior changes — text only. See docs/superpowers/specs/2026-07-15-docs-cli-clarity-design.md for full scope."
```

- [ ] **Step 5: Ask the user to approve the merge** (do not merge without explicit approval, per standing repo workflow rule)

- [ ] **Step 6: Deliver the inconsistency report in chat** (not committed to the repo), covering every finding from Tasks 1-4 plus the known-but-out-of-scope `myelin worktree` gap in CLAUDE.md.
