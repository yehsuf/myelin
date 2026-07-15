import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildRtkGuardBashCommand, buildGuardedRtkCopilotHook } from '../src/tools/rtk.mjs';

// A POSIX `sh` is absent on Windows hosts (execFileSync sh -> ENOENT). Guard the
// behavioral test so full injection coverage runs on POSIX while the suite
// stays green on a real Windows host.
function hasPosixSh() {
  if (process.platform === 'win32') return false;
  try {
    const r = spawnSync('sh', ['-c', 'exit 0']);
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

// I2 (SECURITY): the RTK Copilot preToolUse hook interpolates a MYELIN_DIR-derived
// repoRoot (and the node path) into the `bash` command Copilot runs. A relocated
// managed root containing $(...), backticks, $VAR, or a quote must be emitted as an
// inert single-quoted literal — never executed or expanded when the hook fires.
describe('buildRtkGuardBashCommand — managed paths are inert single-quoted literals (I2)', () => {
  it('neutralizes $(...) command substitution in the repo root', () => {
    const bash = buildRtkGuardBashCommand({ nodePath: '/usr/bin/node', repoRoot: '/opt/$(printf INJECTED)/' });
    assert.ok(bash.includes("'/opt/$(printf INJECTED)/src/cli/index.mjs'"), bash);
    // No double-quoted interpolation (the old vulnerable form) anywhere — the
    // only quoting is the inert single quotes around each managed path.
    assert.ok(!bash.includes('"'), bash);
  });

  it('neutralizes backtick command substitution in the repo root', () => {
    const bash = buildRtkGuardBashCommand({ nodePath: '/usr/bin/node', repoRoot: '/opt/`id`/' });
    assert.ok(bash.includes("'/opt/`id`/src/cli/index.mjs'"), bash);
  });

  it('neutralizes $VAR expansion in the repo root', () => {
    const bash = buildRtkGuardBashCommand({ nodePath: '/usr/bin/node', repoRoot: '/opt/$HOME/' });
    assert.ok(bash.includes("'/opt/$HOME/src/cli/index.mjs'"), bash);
  });

  it('escapes an embedded single quote in the repo root', () => {
    const bash = buildRtkGuardBashCommand({ nodePath: '/usr/bin/node', repoRoot: "/opt/o'brien/" });
    assert.ok(bash.includes("'/opt/o'\\''brien/src/cli/index.mjs'"), bash);
  });

  it('single-quotes the node path too so an interpolated node path can not inject', () => {
    const bash = buildRtkGuardBashCommand({ nodePath: '/opt/$(id)/node', repoRoot: '/repo/' });
    assert.ok(bash.includes("'/opt/$(id)/node'"), bash);
  });

  it('keeps the guard invocation and fail-open shell operators intact', () => {
    const bash = buildRtkGuardBashCommand({ nodePath: '/usr/bin/node', repoRoot: '/repo/' });
    assert.equal(bash, "'/usr/bin/node' '/repo/src/cli/index.mjs' rtk-guard copilot 2>/dev/null; exit 0");
  });

  it('the generated Copilot hook carries the neutralized bash command', () => {
    const hook = buildGuardedRtkCopilotHook({ nodePath: '/usr/bin/node', repoRoot: '/opt/$(printf INJECTED)/' });
    const bash = hook.hooks.preToolUse[0].bash;
    assert.ok(bash.includes("'/opt/$(printf INJECTED)/src/cli/index.mjs'"), bash);
  });
});

describe('buildRtkGuardBashCommand — behavioral: injection never executes under sh (I2)', () => {
  const artifacts = join(process.cwd(), '.test-artifacts', `rtk-inject-${process.pid}-${randomBytes(4).toString('hex')}`);
  mkdirSync(artifacts, { recursive: true });
  after(() => rmSync(artifacts, { recursive: true, force: true }));

  it('a $(touch sentinel) in the repo root does not create the sentinel when the hook runs', { skip: !hasPosixSh() }, () => {
    const sentinel = join(artifacts, 'pwned');
    // process.execPath is a real node; the cli path is bogus, so node errors out
    // (swallowed by 2>/dev/null) and `; exit 0` keeps the hook fail-open. The
    // $(touch ...) inside single quotes must stay inert.
    const bash = buildRtkGuardBashCommand({
      nodePath: process.execPath,
      repoRoot: `/nonexistent/$(touch ${sentinel})/`,
    });
    execFileSync('sh', ['-c', bash], { stdio: 'ignore' });
    assert.equal(existsSync(sentinel), false, 'command substitution executed — injection!');
  });
});
