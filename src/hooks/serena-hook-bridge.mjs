import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Copilot CLI / Claude Code <-> Serena hook bridge.
 *
 * Both clients need the same liveness gate before ever nudging toward
 * Serena's tools - Serena's own `serena-hooks` CLI has no awareness of
 * whether Serena is actually usable for the current project (see
 * `isSerenaViable` below), it only counts tool-call patterns. Routing both
 * clients through one shared module means that gate is implemented and
 * tested exactly once.
 *
 * Where the two clients genuinely differ is output shape:
 *
 * - Claude Code wants Serena's own native output verbatim. Serena's
 *   `--client=vscode` and `--client=claude-code` both emit an *identical*
 *   wrapped envelope (only `--client=codex` differs, by omitting
 *   `additionalContext`) - e.g. for PreToolUse:
 *     {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": ...}}
 *   So for Claude Code we pass this straight through unmodified.
 *
 * - Copilot CLI's documented hook contract
 *   (docs.github.com/en/copilot/reference/hooks-reference) only recognizes a
 *   FLAT shape instead: {"permissionDecision": ..., "permissionDecisionReason": ...}
 *   for preToolUse, and {"additionalContext": ...} for sessionStart. Verified
 *   live: piping a real Serena deny through `--client=vscode` prints the
 *   wrapped shape, which Copilot's docs do not list as a recognized format
 *   anywhere. Un-recognized/unparseable hook output "falls through to
 *   default behavior" per those docs, so a raw passthrough wouldn't break
 *   anything, but it would also silently never nudge the agent toward
 *   Serena - for this target we unwrap the envelope so it actually works.
 *
 * Critical safety constraint (verified in docs.github.com/en/copilot/reference/hooks-reference,
 * "Exit codes for command hooks"): Copilot CLI's preToolUse command hooks
 * are the ONE event that is fail-CLOSED on a crash or non-zero exit (a
 * broken hook denies the tool call with "Denied by preToolUse hook (hook
 * errored)"). Claude Code hooks are documented as fail-open on error
 * (see code.claude.com/docs/en/hooks). Every function here must therefore
 * be defensive regardless of target: any unexpected error must resolve to
 * "print nothing" rather than throwing out to the CLI entrypoint, which is
 * responsible for guaranteeing exit 0 regardless.
 */

const EVENT_TO_SERENA_COMMAND = {
  preToolUse: 'remind',
  sessionStart: 'activate',
  stop: 'cleanup',
};

/**
 * Walk upward from `startDir` looking for a Serena-initialized project
 * (i.e. `.serena/project.yml`, written by `myelin init` / `serena project add`
 * once Serena's LSP indexing has actually been set up for this repo).
 * This is the first half of the liveness check: it tells us whether nudging
 * the agent toward Serena's tools has any chance of paying off here, as
 * opposed to nudging blindly in every repo regardless of whether Serena was
 * ever configured for it.
 * Bounded to 25 levels so a pathological cwd (or a symlink loop) can't hang
 * the hook - this runs on every single tool call and must stay fast.
 */
export function findSerenaProjectRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 25; i++) {
    if (existsSync(join(dir, '.serena', 'project.yml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Second half of the liveness check: is the `serena` binary actually
 * resolvable right now? A project can have `.serena/project.yml` from a
 * previous setup while the binary itself is missing/broken (e.g. a fresh
 * machine, a botched uv tool upgrade, PATH not yet configured in a new
 * shell) - nudging the agent to use tools that don't exist would be a
 * dead-end, not a soft nudge.
 * Accepts an injectable `exec` for unit testing without depending on the
 * real `serena` binary being installed on the test machine.
 */
export function isSerenaBinaryAvailable(exec = execFileSync) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    exec(cmd, ['serena'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Combined liveness check. Returns false (never throws) whenever nudging
 * toward Serena would not actually help - the caller is expected to treat
 * `false` as "do nothing", never as "deny".
 */
export function isSerenaViable(cwd, exec = execFileSync) {
  try {
    return findSerenaProjectRoot(cwd) !== null && isSerenaBinaryAvailable(exec);
  } catch {
    return false;
  }
}

/** Shared unwrap: pull the inner payload out of Serena's Claude/VSCode
 * envelope, tolerating both the wrapped shape and an already-flat shape
 * (defensive in case a future Serena release changes its output format). */
function unwrapEnvelope(serenaStdout) {
  const text = (serenaStdout ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed?.hookSpecificOutput ?? parsed;
  } catch {
    return null;
  }
}

/**
 * Convert Serena's `remind` (preToolUse) output into Copilot CLI's flat
 * decision schema. Copilot's preToolUse schema has no `additionalContext`
 * field, so we fold it into `permissionDecisionReason` instead of silently
 * dropping the reminder text Serena worked out.
 * Returns null for anything empty/unparseable/without a recognizable
 * decision - callers must print nothing in that case.
 */
export function unwrapPreToolUse(serenaStdout) {
  const inner = unwrapEnvelope(serenaStdout);
  const permissionDecision = inner?.permissionDecision;
  if (permissionDecision !== 'allow' && permissionDecision !== 'deny') return null;
  const reasonParts = [inner.permissionDecisionReason, inner.additionalContext].filter(Boolean);
  return {
    permissionDecision,
    permissionDecisionReason: reasonParts.join(' ') || 'Serena hook decision',
  };
}

/**
 * Convert Serena's `activate` (sessionStart) output into Copilot CLI's flat
 * sessionStart schema: `{"additionalContext"?: string}`.
 */
export function unwrapSessionStart(serenaStdout) {
  const inner = unwrapEnvelope(serenaStdout);
  if (!inner?.additionalContext) return null;
  return { additionalContext: inner.additionalContext };
}

/**
 * Full orchestration for one hook invocation. Never throws - any failure
 * anywhere in this pipeline resolves to `null` (print nothing), matching
 * the fail-open posture required for a hook that must never become a hard
 * blocker when Serena isn't a real option for this project.
 *
 * `target` selects the output shape: `'copilot-cli'` (default) unwraps
 * Serena's envelope into Copilot's flat decision schema; `'claude-code'`
 * passes Serena's own native output straight through, since Claude Code
 * already expects exactly the shape Serena produces.
 *
 * `exec`/`spawn` are injectable so unit tests can exercise the full
 * pipeline without actually invoking the real `serena-hooks` binary.
 */
export function runGuard({ event, cwd, stdinText, target = 'copilot-cli', exec = execFileSync, spawn = spawnSync }) {
  try {
    const serenaCommand = EVENT_TO_SERENA_COMMAND[event];
    if (!serenaCommand) return null;
    if (!isSerenaViable(cwd, exec)) return null;

    const result = spawn('serena-hooks', [serenaCommand, '--client=vscode'], {
      input: stdinText ?? '',
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (result.error || result.status !== 0) return null;

    if (target === 'claude-code') {
      const text = (result.stdout ?? '').trim();
      if (!text) return null;
      try {
        return JSON.parse(text); // Serena's own shape - passed through verbatim
      } catch {
        return null;
      }
    }

    if (serenaCommand === 'remind') return unwrapPreToolUse(result.stdout);
    if (serenaCommand === 'activate') return unwrapSessionStart(result.stdout);
    return null; // cleanup (stop) has no output contract - side effect only
  } catch {
    return null;
  }
}
