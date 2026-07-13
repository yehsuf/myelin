
<!-- >>> myelin managed >>> -->
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
