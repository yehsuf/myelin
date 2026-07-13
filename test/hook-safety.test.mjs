import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { makeFailOpen, hardenCopilotHookFile, FAIL_OPEN_MARKER } from '../src/tools/hook-safety.mjs';
import { hardenCopilotTokenOptimizerHook, copilotTokenOptimizerHookPath } from '../src/service/token-optimizer.mjs';

describe('makeFailOpen', () => {
  it('appends a preserve-deny fail-open guard', () => {
    const out = makeFailOpen('run-thing --x');
    assert.match(out, /^run-thing --x;/);
    assert.match(out, /exit 2/);
    assert.match(out, /exit 0$/);
    assert.match(out, new RegExp(FAIL_OPEN_MARKER));
  });
  it('is idempotent (never double-wraps)', () => {
    const once = makeFailOpen('cmd');
    assert.equal(makeFailOpen(once), once);
  });
  it('supports a simple always-exit-0 variant', () => {
    const out = makeFailOpen('cmd', { preserveDeny: false });
    assert.match(out, /exit 0$/);
    assert.ok(!/\[ "\$/.test(out));
  });
  it('leaves empty/non-string input untouched', () => {
    assert.equal(makeFailOpen(''), '');
    assert.equal(makeFailOpen(undefined), undefined);
  });
});

// Real bash semantics: crash → 0 (fail-open), intentional deny (exit 2) preserved.
describe('makeFailOpen — real bash exit codes', { skip: process.platform === 'win32' }, () => {
  const run = (innerExit) => {
    const cmd = makeFailOpen(`bash -c 'exit ${innerExit}'`);
    return spawnSync('bash', ['-c', cmd], { encoding: 'utf8' }).status;
  };
  it('exit 0 stays 0', () => assert.equal(run(0), 0));
  it('crash (exit 1) becomes 0 — fail-open', () => assert.equal(run(1), 0));
  it('exit 127 (missing binary) becomes 0 — fail-open', () => assert.equal(run(127), 0));
  it('intentional deny (exit 2) is preserved', () => assert.equal(run(2), 2));
});

describe('hardenCopilotHookFile', () => {
  const tmp = (label) => mkdtempSync(join(tmpdir(), `myelin-hooksafe-${label}-`));

  it('hardens the bash field of preToolUse and is idempotent', () => {
    const dir = tmp('harden');
    try {
      const p = join(dir, 'hook.json');
      writeFileSync(p, JSON.stringify({
        version: 1,
        hooks: { preToolUse: [{ type: 'command', bash: 'python bridge.py pre-tool-use', timeoutSec: 10 }] },
      }));
      const r1 = hardenCopilotHookFile({ path: p });
      assert.equal(r1.action, 'hardened');
      const after = JSON.parse(readFileSync(p, 'utf8'));
      assert.match(after.hooks.preToolUse[0].bash, /exit 0$/);
      // idempotent second run
      assert.equal(hardenCopilotHookFile({ path: p }).action, 'already-safe');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not touch non-preToolUse events (they are fail-open already)', () => {
    const dir = tmp('other-events');
    try {
      const p = join(dir, 'hook.json');
      const original = { version: 1, hooks: { postToolUse: [{ type: 'command', bash: 'python bridge.py post' }] } };
      writeFileSync(p, JSON.stringify(original));
      const r = hardenCopilotHookFile({ path: p });
      assert.equal(r.action, 'already-safe');
      assert.equal(JSON.parse(readFileSync(p, 'utf8')).hooks.postToolUse[0].bash, 'python bridge.py post');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is absent/garbage-safe', () => {
    const dir = tmp('safe');
    try {
      assert.equal(hardenCopilotHookFile({ path: join(dir, 'nope.json') }).action, 'absent');
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{ not json');
      assert.equal(hardenCopilotHookFile({ path: bad }).action, 'unparseable');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('hardenCopilotTokenOptimizerHook (real token-optimizer.json shape)', () => {
  const writeTokenOptimizerHook = (home) => {
    const p = copilotTokenOptimizerHookPath(home);
    mkdirSync(join(home, '.copilot', 'hooks'), { recursive: true });
    writeFileSync(p, JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [{ type: 'command', bash: "python bridge.py session-start", timeoutSec: 10 }],
        preToolUse: [{ type: 'command', bash: "TOKEN_OPTIMIZER_RUNTIME=copilot 'py.exe' 'bridge.py' pre-tool-use", timeoutSec: 10, matcher: { toolName: 'bash' } }],
      },
    }, null, 2));
    return p;
  };

  it('makes the python-bridge preToolUse hook fail-open', () => {
    const home = mkdtempSync(join(tmpdir(), 'myelin-to-'));
    try {
      const p = writeTokenOptimizerHook(home);
      const res = hardenCopilotTokenOptimizerHook({ home });
      assert.equal(res.action, 'hardened');
      const after = JSON.parse(readFileSync(p, 'utf8'));
      assert.match(after.hooks.preToolUse[0].bash, /exit 0$/);
      // sessionStart (fail-open event) left alone
      assert.equal(after.hooks.sessionStart[0].bash, 'python bridge.py session-start');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('fails open when the hardened python bridge crashes', { skip: process.platform === 'win32' }, () => {
    const home = mkdtempSync(join(tmpdir(), 'myelin-to-'));
    try {
      const p = writeTokenOptimizerHook(home);
      hardenCopilotTokenOptimizerHook({ home });
      const after = JSON.parse(readFileSync(p, 'utf8'));
      const status = spawnSync('bash', ['-c', after.hooks.preToolUse[0].bash.replace(/TOKEN_OPTIMIZER_RUNTIME=copilot 'py.exe' 'bridge.py' pre-tool-use/, "bash -c 'exit 3'")], { encoding: 'utf8' }).status;
      assert.equal(status, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
