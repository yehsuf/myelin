import { readFileSync } from 'node:fs';
import { runGuard } from '../hooks/copilot-serena-guard.mjs';

/**
 * Entrypoint invoked directly by Copilot CLI's hook runner (`myelin
 * serena-guard --event=preToolUse` etc, wired up per-project by
 * `myelin init`). This wrapper's only job is the safety guarantee that
 * `runGuard` itself cannot provide from the outside: no matter what happens
 * (stdin read failure, an exception escaping runGuard's own try/catch,
 * whatever), this process must always print either nothing or a single
 * valid decision line and always exit 0. Copilot CLI's preToolUse hooks are
 * fail-CLOSED on crash/non-zero-exit, so letting anything throw past this
 * point would turn a "Serena isn't set up here" no-op into "every tool call
 * is denied" - the exact opposite of what this hook is for.
 */
export function runServenaGuardCli(event) {
  try {
    let stdinText = '';
    try {
      stdinText = readFileSync(0, 'utf8');
    } catch {
      stdinText = '';
    }
    const cwd = (() => {
      try {
        return JSON.parse(stdinText).cwd ?? process.cwd();
      } catch {
        return process.cwd();
      }
    })();
    const decision = runGuard({ event, cwd, stdinText });
    if (decision) process.stdout.write(JSON.stringify(decision));
  } catch {
    // Fall through to "print nothing" - never let an error propagate.
  }
  process.exit(0);
}
