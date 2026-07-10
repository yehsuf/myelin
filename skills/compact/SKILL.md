---
name: compact
description: Prepare a dense /compact hint from the current session's live state (git, todos, plan.md, config) and re-orient after /compact. Works in any repo.
argument-hint: "[prepare|resume]"
---

# compact — generic /compact pipeline

Generates a ready-to-paste `/compact` hint from live session state. No project-specific hardcoding — works in any repo.

## When to use
- Context is getting long and `/compact` is imminent → invoke with `prepare`
- Immediately after `/compact` completes → invoke with `resume`

## Instructions for the agent

Let `$MODE` = first token of `$ARGUMENTS`, default `prepare`. Must be `prepare` or `resume`.

### Mode: prepare

1. Export current todos to a file so the script can read them:
   ```sql
   SELECT id, title, COALESCE(description,'') AS description, status, updated_at
   FROM todos
   WHERE status IN ('in_progress','pending','blocked')
   ORDER BY CASE status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, updated_at DESC
   ```
   Write the JSON result to `~/.copilot/session-state/$COPILOT_AGENT_SESSION_ID/files/todos.json` as:
   ```json
   {"version":1,"generatedAt":"<ISO>","source":"copilot-sql-tool","todos":[...]}
   ```

2. Run:
   ```bash
   node ~/.copilot/skills/compact/compact-prepare.mjs prepare
   ```

3. Print the full script output verbatim. The `<<<SESSION_STATE_BRIEF>>>` block
   is a factual summary (todos, git, checkpoints, plan.md, rules) — it is NOT
   the compact hint itself.

4. **YOU (the agent) now compose the actual compact hint.** Do NOT ask the
   script to guess it. Use:
   - The `<<<SESSION_STATE_BRIEF>>>` block as source of truth for facts.
   - Your memory of THIS session for narrative: what was accomplished,
     decisions made, in-progress work, next priority, unresolved blockers.

   Constraints (hard):
   - **Maximum 4000 characters total** (Copilot CLI `customInstructions` cap
     — exceeding it aborts `/compact` with the error you may have hit before).
   - Reference `checkpoints/NNN-*.md` by filename rather than dumping them.
   - Preserve any user-directive rules from the constitution / brief.

   Suggested structure (keep it dense):
   ```
   SESSION SUMMARY: <1-2 line what-we-did>
   NEXT: <top-priority next action>
   IN PROGRESS: <if any>
   BLOCKED: <count + one-liner per item, or reference todos.json>
   RULES: <critical user directives, one per line>
   CHECKPOINTS: 001-*.md ... 00N-*.md
   PLAN: <one-line summary or "see files/plan.md">
   ```

5. Print the hint you composed between these sentinels (real newlines, not
   the literal text):
   ```
   >>> COMPACT HINT >>>
   <your composed hint here, <=4000 chars>
   <<< END COMPACT HINT <<<
   ```

6. Tell the user: "Copy the block between the `>>> COMPACT HINT >>>` and
   `<<< END COMPACT HINT <<<` lines (not including the sentinels themselves)
   and paste it after `/compact ` in your next message."

7. Do NOT run `/compact` yourself.

### Mode: resume

1. Run:
   ```bash
   node ~/.copilot/skills/compact/compact-prepare.mjs resume
   ```

2. Print the output verbatim.

3. In ≤3 lines, state the top priority: first in-progress todo or first line of the NEXT section.

4. Tell the user: "You can now dismiss or collapse the compact hint message — it will stay in the transcript otherwise."

## Error handling
- Exit 2: tell user "Run this inside an active Copilot CLI session, or set COPILOT_AGENT_SESSION_ID."
- Exit 3/4: tell user "Session directory problem — check stderr output."
- `sqlite3` missing: warn "todos may be incomplete — install sqlite3 for full accuracy."

## Optional configuration

**Per-session** `~/.copilot/session-state/$COPILOT_AGENT_SESSION_ID/compact.yaml`:
```yaml
repos:
  - path: ~/Work/headroom-lite
    label: yehsuf/headroom-lite
rules:
  - Never act without explicit per-action approval
next: "Implement feature X"
notes: "Blocked on Y — waiting for approval"
```

**Global** `~/.copilot/compact.defaults.yaml`:
```yaml
rules:
  - Auth headers always opaque
  - Tests must pass before merge
```
