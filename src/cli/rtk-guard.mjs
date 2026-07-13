import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Fail-open bridge for RTK's shell-compression preToolUse hook on Copilot CLI.
 *
 * Copilot CLI preToolUse command hooks are the ONE hook event that is
 * fail-CLOSED on a crash or non-zero exit — a broken hook denies the tool call
 * with "Denied by preToolUse hook (hook errored)"
 * (docs.github.com/en/copilot/reference/hooks-reference, "Exit codes"). RTK's
 * own `rtk init --copilot` wires the raw command `rtk hook copilot`, so the
 * moment `rtk` isn't on the hook-runner's PATH (the Windows case — rtk lives in
 * ~/.myelin/bin or ~/.cargo/bin, not the minimal PATH Copilot spawns hooks
 * with) that hook exits 127 and every single tool call in every session is
 * denied. This wrapper's entire job is the guarantee RTK cannot make from the
 * outside: locate rtk robustly, run it, pass through a valid decision on
 * success, and — no matter what — print nothing and exit 0 on any failure.
 */

/** rtk binary locations to probe, in priority order, since Copilot's hook PATH
 *  frequently omits the dirs rtk actually installs to. */
export function rtkBinaryCandidates({ home = homedir(), plat = platform(), env = process.env } = {}) {
  const exe = plat === 'win32' ? 'rtk.exe' : 'rtk';
  const list = [];
  if (env.RTK_BIN) list.push(env.RTK_BIN);
  list.push(
    join(home, '.myelin', 'bin', exe),
    join(home, '.cargo', 'bin', exe),
    '/opt/homebrew/bin/rtk',
    '/usr/local/bin/rtk',
    '/home/linuxbrew/.linuxbrew/bin/rtk',
  );
  return list;
}

/** First existing rtk candidate, else bare 'rtk' (let PATH try — a miss there
 *  becomes a spawn error the guard swallows). Never throws. */
export function resolveRtkBinary(opts = {}) {
  const exists = opts.exists ?? existsSync;
  try {
    for (const c of rtkBinaryCandidates(opts)) {
      try { if (exists(c)) return c; } catch { /* probe next */ }
    }
  } catch { /* fall through to PATH */ }
  return 'rtk';
}

const VALID_TARGETS = new Set(['copilot', 'claude', 'cursor', 'gemini']);

/**
 * Run `rtk hook <target>` and return the text to emit on the hook's stdout.
 * ANY failure (missing binary, spawn error, non-zero exit, timeout, output
 * that isn't a JSON decision) yields '' so nothing is emitted and the tool call
 * proceeds through Copilot's normal permission flow. Never throws.
 */
export function runRtkGuard({ target = 'copilot', stdin = '', spawn = spawnSync, timeoutMs = 4000, ...rest } = {}) {
  try {
    const t = VALID_TARGETS.has(target) ? target : 'copilot';
    const bin = resolveRtkBinary(rest);
    const res = spawn(bin, ['hook', t], { input: stdin, encoding: 'utf8', timeout: timeoutMs });
    if (!res || res.error || res.status !== 0) return '';
    const out = (res.stdout ?? '').trim();
    if (!out || out[0] !== '{') return '';
    return out;
  } catch {
    return '';
  }
}

/**
 * CLI entrypoint (`myelin rtk-guard [target]`). Reads the hook payload from
 * stdin, prints rtk's decision if any, and ALWAYS exits 0 — never let anything
 * throw past here, or the preToolUse fail-closed contract turns a no-op into a
 * denied tool call.
 */
export function runRtkGuardCli(target = 'copilot') {
  let stdin = '';
  try { stdin = readFileSync(0, 'utf8'); } catch { stdin = ''; }
  let out = '';
  try { out = runRtkGuard({ target, stdin }); } catch { out = ''; }
  if (out) { try { process.stdout.write(out); } catch { /* ignore */ } }
  process.exit(0);
}
