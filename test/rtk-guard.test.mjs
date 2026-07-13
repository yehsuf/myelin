import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { runRtkGuard, resolveRtkBinary, rtkBinaryCandidates } from '../src/cli/rtk-guard.mjs';
import {
  buildRtkGuardBashCommand,
  buildGuardedRtkCopilotHook,
  ensureSafeRtkCopilotHook,
  isRawUnsafeRtkHook,
  isGuardedRtkHook,
  copilotRtkHookPath,
  toPosixPath,
} from '../src/tools/rtk.mjs';

const CLI = fileURLToPath(new URL('../src/cli/index.mjs', import.meta.url));

function tmpHome(label) {
  return mkdtempSync(join(tmpdir(), `myelin-rtkguard-${label}-`));
}

// ── runRtkGuard: the fail-open core (spawn injected → deterministic, cross-platform) ──
describe('runRtkGuard (fail-open)', () => {
  const okExists = () => true;

  it('returns rtk stdout on success with a JSON decision', () => {
    const spawn = () => ({ status: 0, stdout: '{"hookSpecificOutput":{"permissionDecision":"ask"}}' });
    assert.equal(runRtkGuard({ stdin: '{}', spawn, exists: okExists }),
      '{"hookSpecificOutput":{"permissionDecision":"ask"}}');
  });

  it('returns empty string when rtk exits non-zero (crash → never deny)', () => {
    const spawn = () => ({ status: 1, stdout: 'panic', stderr: 'boom' });
    assert.equal(runRtkGuard({ stdin: '{}', spawn, exists: okExists }), '');
  });

  it('returns empty string when rtk binary is missing (spawn error / ENOENT)', () => {
    const spawn = () => ({ error: new Error('spawn rtk ENOENT') });
    assert.equal(runRtkGuard({ stdin: '{}', spawn, exists: () => false }), '');
  });

  it('returns empty string when rtk output is not a JSON decision', () => {
    const spawn = () => ({ status: 0, stdout: 'hello there' });
    assert.equal(runRtkGuard({ stdin: '{}', spawn, exists: okExists }), '');
  });

  it('never throws even if spawn itself throws', () => {
    const spawn = () => { throw new Error('kaboom'); };
    assert.equal(runRtkGuard({ stdin: '{}', spawn, exists: okExists }), '');
  });

  it('normalises an unknown target to copilot (no arbitrary arg injection)', () => {
    let seen;
    const spawn = (_bin, args) => { seen = args; return { status: 0, stdout: '{}' }; };
    runRtkGuard({ target: '; rm -rf /', stdin: '{}', spawn, exists: okExists });
    assert.deepEqual(seen, ['hook', 'copilot']);
  });
});

describe('resolveRtkBinary', () => {
  it('prefers the first existing candidate', () => {
    const home = '/home/x';
    const hit = join(home, '.myelin', 'bin', 'rtk');
    assert.equal(resolveRtkBinary({ home, plat: 'linux', env: {}, exists: (p) => p === hit }), hit);
  });
  it('falls back to bare rtk when nothing is found', () => {
    assert.equal(resolveRtkBinary({ home: '/home/x', plat: 'linux', env: {}, exists: () => false }), 'rtk');
  });
  it('honours RTK_BIN first and uses .exe on Windows', () => {
    const cands = rtkBinaryCandidates({ home: 'C:\\u', plat: 'win32', env: { RTK_BIN: 'D:\\rtk.exe' } });
    assert.equal(cands[0], 'D:\\rtk.exe');
    assert.ok(cands.some((c) => c.endsWith('rtk.exe')));
  });
});

// ── The guarded hook command / config ──
describe('buildRtkGuardBashCommand', () => {
  const cmd = buildRtkGuardBashCommand({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    repoRoot: 'C:\\Users\\yeh\\.myelin\\repo\\',
  });
  it('routes through the fail-open rtk-guard wrapper, not raw `rtk hook`', () => {
    assert.match(cmd, /rtk-guard copilot/);
    assert.ok(!/rtk\s+hook\s+copilot/.test(cmd), 'must not contain raw `rtk hook copilot`');
  });
  it('always exits 0 so a missing node/rtk can never deny the tool call', () => {
    assert.ok(cmd.trimEnd().endsWith('; exit 0'), cmd);
  });
  it('uses forward slashes so the path is valid under bash on every platform', () => {
    assert.ok(!cmd.includes('\\'), cmd);
    assert.match(cmd, /C:\/Users\/yeh\/\.myelin\/repo\/src\/cli\/index\.mjs/);
  });
});

describe('buildGuardedRtkCopilotHook', () => {
  const cfg = buildGuardedRtkCopilotHook({ nodePath: '/usr/bin/node', repoRoot: '/repo/' });
  it('uses the Copilot CLI camelCase preToolUse + bash-field shape', () => {
    assert.equal(cfg.version, 1);
    assert.ok(Array.isArray(cfg.hooks.preToolUse));
    const entry = cfg.hooks.preToolUse[0];
    assert.equal(entry.type, 'command');
    assert.equal(entry.matcher, 'bash');
    assert.match(entry.bash, /rtk-guard copilot/);
  });
  it('is classified guarded, not unsafe', () => {
    assert.equal(isGuardedRtkHook(cfg), true);
    assert.equal(isRawUnsafeRtkHook(cfg), false);
  });
});

describe('isRawUnsafeRtkHook / isGuardedRtkHook classification', () => {
  const raw = {
    hooks: {
      PreToolUse: [{ type: 'command', command: 'rtk hook copilot' }],
      preToolUse: [{ type: 'command', bash: 'rtk hook copilot', powershell: 'rtk hook copilot' }],
    },
  };
  it('flags the raw rtk-init-generated hook as unsafe', () => {
    assert.equal(isRawUnsafeRtkHook(raw), true);
    assert.equal(isGuardedRtkHook(raw), false);
  });
  it('does not flag the guarded wrapper as unsafe', () => {
    const guarded = buildGuardedRtkCopilotHook({ nodePath: '/n', repoRoot: '/r/' });
    assert.equal(isRawUnsafeRtkHook(guarded), false);
  });
  it('handles the nested {matcher, hooks:[...]} shape', () => {
    const nested = { hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'rtk hook copilot' }] }] } };
    assert.equal(isRawUnsafeRtkHook(nested), true);
  });
  it('is null/garbage-safe', () => {
    assert.equal(isRawUnsafeRtkHook(null), false);
    assert.equal(isGuardedRtkHook(undefined), false);
    assert.equal(isRawUnsafeRtkHook({ hooks: 'nope' }), false);
  });
});

// ── ensureSafeRtkCopilotHook: heal lifecycle on real temp dirs ──
describe('ensureSafeRtkCopilotHook', () => {
  const raw = JSON.stringify({
    version: 1,
    hooks: { preToolUse: [{ type: 'command', bash: 'rtk hook copilot' }] },
  });

  it('active: overwrites a raw hook with the fail-open guarded hook', () => {
    const home = tmpHome('active');
    try {
      const p = copilotRtkHookPath(home);
      mkdirSync(join(home, '.copilot', 'hooks'), { recursive: true });
      writeFileSync(p, raw);
      const res = ensureSafeRtkCopilotHook({ home, nodePath: '/usr/bin/node', repoRoot: '/repo/', mode: 'active' });
      assert.equal(res.action, 'wrote-guarded');
      const after = JSON.parse(readFileSync(p, 'utf8'));
      assert.equal(isGuardedRtkHook(after), true);
      assert.equal(isRawUnsafeRtkHook(after), false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('active: creates the guarded hook when none exists', () => {
    const home = tmpHome('create');
    try {
      const res = ensureSafeRtkCopilotHook({ home, nodePath: '/usr/bin/node', repoRoot: '/repo/', mode: 'active' });
      assert.equal(res.action, 'wrote-guarded');
      assert.ok(existsSync(copilotRtkHookPath(home)));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('inactive: removes a raw (bricking) hook to un-brick the machine', () => {
    const home = tmpHome('inactive');
    try {
      const p = copilotRtkHookPath(home);
      mkdirSync(join(home, '.copilot', 'hooks'), { recursive: true });
      writeFileSync(p, raw);
      const res = ensureSafeRtkCopilotHook({ home, mode: 'inactive' });
      assert.equal(res.action, 'removed-unsafe');
      assert.equal(existsSync(p), false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('inactive: leaves a foreign hand-written hook untouched', () => {
    const home = tmpHome('foreign');
    try {
      const p = copilotRtkHookPath(home);
      mkdirSync(join(home, '.copilot', 'hooks'), { recursive: true });
      const foreign = JSON.stringify({ hooks: { preToolUse: [{ type: 'command', bash: 'echo hi' }] } });
      writeFileSync(p, foreign);
      const res = ensureSafeRtkCopilotHook({ home, mode: 'inactive' });
      assert.equal(res.action, 'left-foreign');
      assert.equal(readFileSync(p, 'utf8'), foreign);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('heal-only: rewrites a raw hook but never creates or removes', () => {
    const home = tmpHome('heal');
    try {
      const p = copilotRtkHookPath(home);
      // no file yet → noop
      assert.equal(ensureSafeRtkCopilotHook({ home, mode: 'heal-only' }).action, 'noop');
      assert.equal(existsSync(p), false);
      // raw present → healed
      mkdirSync(join(home, '.copilot', 'hooks'), { recursive: true });
      writeFileSync(p, raw);
      const res = ensureSafeRtkCopilotHook({ home, nodePath: '/usr/bin/node', repoRoot: '/repo/', mode: 'heal-only' });
      assert.equal(res.action, 'healed-raw');
      assert.equal(isGuardedRtkHook(JSON.parse(readFileSync(p, 'utf8'))), true);
      // already guarded → noop
      assert.equal(ensureSafeRtkCopilotHook({ home, mode: 'heal-only' }).action, 'noop');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('toPosixPath', () => {
  it('converts backslashes to forward slashes', () => {
    assert.equal(toPosixPath('C:\\a\\b'), 'C:/a/b');
  });
});

// ── End-to-end: the real CLI process MUST always exit 0 (the anti-brick invariant) ──
describe('myelin rtk-guard (end-to-end process)', () => {
  it('exits 0 for a Bash payload regardless of rtk presence', () => {
    const r = spawnSync(process.execPath, [CLI, 'rtk-guard', 'copilot'], {
      input: '{"tool_name":"bash","tool_input":{"command":"ls"}}', encoding: 'utf8',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    if (r.stdout.trim()) JSON.parse(r.stdout.trim()); // if anything is emitted, it must be valid JSON
  });

  it('exits 0 on empty stdin (never denies a tool call)', () => {
    const r = spawnSync(process.execPath, [CLI, 'rtk-guard', 'copilot'], { input: '', encoding: 'utf8' });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  });
});
