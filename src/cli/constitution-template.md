<!-- CONSTITUTION v1 — Stable project context for GitHub Copilot CLI.
     Only stable facts belong here. Volatile state (blocked items, shipped work,
     current sprint) goes in the compact hint, not here. -->

# <PROJECT_NAME>

## Identity
- name: <PROJECT_NAME>
- repo: <OWNER/REPO>
- purpose: <one sentence purpose>

## Architecture invariants
- <!-- Add non-negotiable technical rules here -->

## Standing rules
- Never act without explicit per-action approval.
- **Multi-agent claim protocol — MANDATORY before starting any backlog task:**
  1. Register this session with your project's agent tracking system.
  2. Check for active claims from other sessions. If your target task is already claimed by a live session, STOP — pick a different task or ask the human.
  3. Claim the task BEFORE creating any branch or writing any code.
  4. Never force-override another session's active claim without explicit human approval.
- <!-- Add team process rules here -->

## Technology
- Language / runtime: <!-- e.g. Node.js >=20, ESM only -->
- Test command: <!-- e.g. node --test test/**/*.test.mjs -->
- Package registry: <!-- e.g. GitHub Packages -->

## Key file map
- <!-- path/to/file — purpose -->
