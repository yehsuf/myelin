
<!-- >>> myelin managed >>> -->

## Token efficiency
- **Read narrowly.** Use offset+limit on Read/view. Read only sections relevant to the task.
- **grep before reading.** Locate exact lines with grep/serena before opening a file.
- **No exploratory reads.** Don't read files "just for context" — work from what's already known.
- **No whole-file rewrites.** Always use Edit (diff-only) for existing files.
- **Targeted tests only.** Run only the spec/test that changed, not the full suite.
- **No end-of-response summaries.** The diff speaks for itself.
- **Agents only when necessary.** Spawn subagents only for genuinely parallel independent tasks.
- **No redundant verification.** Don't re-read a file after editing; don't run unaffected tests.

## Efficient Navigation (Myelin-powered)
- Prefer MCP tools: `serena.*` (structural), `semble.*` (semantic) over file reads.
- Shell commands are RTK-compressed — do NOT pipe through head/tail unnecessarily.
- For code review: call `mcp-git.*` tools instead of reading both file versions.
- For cross-file patterns: use ast-grep, not grep loops.
- Never use raw `cat`, `grep`, `find`, `head`, `tail` in the Bash tool — use Serena.

## Output Protocol
- Terse. No preamble. Patch format for file edits. No "I will now...".
- Bullet lists over prose.
<!-- <<< myelin managed <<< -->
