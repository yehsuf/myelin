# Compact Overflow Rejection Design

## Goal

Prevent an oversized compact hint from being copied to the clipboard or printed
as a truncated `/compact` command.

## Scope

This change affects only `compact-prepare.mjs clipboard <hint-file>`. It does
not change hint composition, session discovery, or the 4,000-character Copilot
CLI limit.

## Behavior

1. Read and normalize the hint file as today.
2. If the normalized hint length is at most 4,000 characters, retain the
   current successful behavior: copy `/compact <hint>` and print it.
3. If the normalized hint length exceeds 4,000 characters:
   - Do not call the clipboard helper.
   - Do not print any `/compact` command or hint body.
   - Preserve the source hint file unchanged.
   - Print a concise error to stderr with the actual length, the 4,000
     character limit, and the file path to edit.
   - Exit with status 2.

## Rationale

The prior truncation path could copy and display a misleading command derived
from placeholder or oversized data. Failing closed makes the agent or user
shorten the authored hint before a command is offered.

## Tests

`test/compact-prepare.test.mjs` will verify:

- A 4,000-character hint succeeds and does not report truncation.
- A 4,001-character hint exits 2, reports the file and limit, emits no
  `/compact` command, and leaves the file unchanged.
- The existing 4,500-character fixture likewise exits 2 and is neither copied
  nor printed as a command.
