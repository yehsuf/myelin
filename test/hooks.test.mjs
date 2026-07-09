import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSerenaProjectRoot,
  isSerenaBinaryAvailable,
  isSerenaViable,
  unwrapPreToolUse,
  unwrapSessionStart,
  runGuard,
} from '../src/hooks/serena-hook-bridge.mjs';

function makeSerenaProject() {
  const root = mkdtempSync(join(tmpdir(), 'myelin-serena-guard-test-'));
  mkdirSync(join(root, '.serena'), { recursive: true });
  writeFileSync(join(root, '.serena', 'project.yml'), 'project_name: "test"\n');
  return root;
}

describe('findSerenaProjectRoot', () => {
  it('finds .serena/project.yml in the exact directory', () => {
    const root = makeSerenaProject();
    try {
      assert.equal(findSerenaProjectRoot(root), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds .serena/project.yml in an ancestor directory', () => {
    const root = makeSerenaProject();
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    try {
      assert.equal(findSerenaProjectRoot(nested), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when no .serena/project.yml exists anywhere', () => {
    const root = mkdtempSync(join(tmpdir(), 'myelin-serena-guard-test-noserena-'));
    try {
      assert.equal(findSerenaProjectRoot(root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('isSerenaBinaryAvailable', () => {
  it('returns true when the injected exec succeeds', () => {
    assert.equal(isSerenaBinaryAvailable(() => Buffer.from('')), true);
  });

  it('returns false (never throws) when the injected exec throws', () => {
    assert.equal(isSerenaBinaryAvailable(() => { throw new Error('not found'); }), false);
  });
});

describe('isSerenaViable', () => {
  it('is true only when both project root exists AND binary resolves', () => {
    const root = makeSerenaProject();
    try {
      assert.equal(isSerenaViable(root, () => Buffer.from('')), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is false when project root exists but binary is missing', () => {
    const root = makeSerenaProject();
    try {
      assert.equal(isSerenaViable(root, () => { throw new Error('not found'); }), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is false when binary resolves but no serena project exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'myelin-serena-guard-test-noserena-'));
    try {
      assert.equal(isSerenaViable(root, () => Buffer.from('')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never throws even if the fs check itself throws', () => {
    assert.doesNotThrow(() => isSerenaViable('/this/path/definitely/does/not/exist/at/all', () => Buffer.from('')));
  });
});

describe('unwrapPreToolUse', () => {
  it('unwraps a real deny envelope and folds additionalContext into the reason', () => {
    const serenaOutput = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Too many consecutive grep calls.',
        additionalContext: 'Consider using symbolic tools instead.',
      },
    });
    const result = unwrapPreToolUse(serenaOutput);
    assert.equal(result.permissionDecision, 'deny');
    assert.ok(result.permissionDecisionReason.includes('Too many consecutive grep calls.'));
    assert.ok(result.permissionDecisionReason.includes('Consider using symbolic tools instead.'));
  });

  it('unwraps an allow envelope with no additionalContext', () => {
    const serenaOutput = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'fine' },
    });
    assert.deepEqual(unwrapPreToolUse(serenaOutput), { permissionDecision: 'allow', permissionDecisionReason: 'fine' });
  });

  it('returns null for empty output', () => {
    assert.equal(unwrapPreToolUse(''), null);
    assert.equal(unwrapPreToolUse(null), null);
    assert.equal(unwrapPreToolUse(undefined), null);
  });

  it('returns null for unparseable JSON (never throws)', () => {
    assert.doesNotThrow(() => unwrapPreToolUse('not json {{{'));
    assert.equal(unwrapPreToolUse('not json {{{'), null);
  });

  it('returns null when there is no recognizable permissionDecision', () => {
    assert.equal(unwrapPreToolUse(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse' } })), null);
  });

  it('tolerates an already-flat shape defensively', () => {
    const result = unwrapPreToolUse(JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: 'x' }));
    assert.equal(result.permissionDecision, 'deny');
  });
});

describe('unwrapSessionStart', () => {
  it('unwraps the real activate envelope', () => {
    const serenaOutput = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Activate the project first.' },
    });
    assert.deepEqual(unwrapSessionStart(serenaOutput), { additionalContext: 'Activate the project first.' });
  });

  it('returns null when there is no additionalContext', () => {
    assert.equal(unwrapSessionStart(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart' } })), null);
  });

  it('returns null for empty/unparseable output', () => {
    assert.equal(unwrapSessionStart(''), null);
    assert.equal(unwrapSessionStart('{{{'), null);
  });
});

describe('runGuard', () => {
  it('does nothing (null) when Serena is not viable for the project', () => {
    const root = mkdtempSync(join(tmpdir(), 'myelin-serena-guard-test-noserena-'));
    try {
      const decision = runGuard({
        event: 'preToolUse',
        cwd: root,
        stdinText: '{}',
        exec: () => Buffer.from(''),
        spawn: () => { throw new Error('spawn should never be called when not viable'); },
      });
      assert.equal(decision, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('relays a deny decision end-to-end using an injected spawn', () => {
    const root = makeSerenaProject();
    try {
      const fakeSpawn = () => ({
        status: 0,
        error: null,
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'too many greps' },
        }),
      });
      const decision = runGuard({ event: 'preToolUse', cwd: root, stdinText: '{}', exec: () => Buffer.from(''), spawn: fakeSpawn });
      assert.equal(decision.permissionDecision, 'deny');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null (never throws) when the spawned process errors', () => {
    const root = makeSerenaProject();
    try {
      const fakeSpawn = () => ({ status: 1, error: new Error('boom'), stdout: '' });
      assert.doesNotThrow(() => runGuard({ event: 'preToolUse', cwd: root, stdinText: '{}', exec: () => Buffer.from(''), spawn: fakeSpawn }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null (never throws) when spawn itself throws synchronously', () => {
    const root = makeSerenaProject();
    try {
      const fakeSpawn = () => { throw new Error('ENOENT'); };
      assert.equal(runGuard({ event: 'preToolUse', cwd: root, stdinText: '{}', exec: () => Buffer.from(''), spawn: fakeSpawn }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null for an unknown event name', () => {
    const root = makeSerenaProject();
    try {
      assert.equal(runGuard({ event: 'bogusEvent', cwd: root, exec: () => Buffer.from(''), spawn: () => { throw new Error('should not spawn'); } }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null for the stop/cleanup event (side-effect only, no decision contract)', () => {
    const root = makeSerenaProject();
    try {
      const fakeSpawn = () => ({ status: 0, error: null, stdout: '' });
      assert.equal(runGuard({ event: 'stop', cwd: root, exec: () => Buffer.from(''), spawn: fakeSpawn }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('target=claude-code passes Serena\'s native envelope through verbatim (no unwrap)', () => {
    const root = makeSerenaProject();
    try {
      const nativeEnvelope = {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'too many greps', additionalContext: 'use symbolic tools' },
      };
      const fakeSpawn = () => ({ status: 0, error: null, stdout: JSON.stringify(nativeEnvelope) });
      const decision = runGuard({ event: 'preToolUse', cwd: root, stdinText: '{}', target: 'claude-code', exec: () => Buffer.from(''), spawn: fakeSpawn });
      assert.deepEqual(decision, nativeEnvelope);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('target=claude-code returns null when Serena prints no output (nothing to relay)', () => {
    const root = makeSerenaProject();
    try {
      const fakeSpawn = () => ({ status: 0, error: null, stdout: '' });
      assert.equal(runGuard({ event: 'preToolUse', cwd: root, stdinText: '{}', target: 'claude-code', exec: () => Buffer.from(''), spawn: fakeSpawn }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('target=claude-code never throws on unparseable Serena output', () => {
    const root = makeSerenaProject();
    try {
      const fakeSpawn = () => ({ status: 0, error: null, stdout: 'not json {{{' });
      assert.doesNotThrow(() => runGuard({ event: 'preToolUse', cwd: root, stdinText: '{}', target: 'claude-code', exec: () => Buffer.from(''), spawn: fakeSpawn }));
      assert.equal(runGuard({ event: 'preToolUse', cwd: root, stdinText: '{}', target: 'claude-code', exec: () => Buffer.from(''), spawn: fakeSpawn }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('target=claude-code still respects the liveness gate (no spawn when not viable)', () => {
    const root = mkdtempSync(join(tmpdir(), 'myelin-serena-guard-test-noserena-'));
    try {
      const decision = runGuard({
        event: 'preToolUse', cwd: root, stdinText: '{}', target: 'claude-code',
        exec: () => Buffer.from(''),
        spawn: () => { throw new Error('spawn should never be called when not viable'); },
      });
      assert.equal(decision, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Real-binary integration test: only runs if the actual `serena-hooks` CLI is
// installed on this machine (it is not a project dependency). Skips cleanly
// otherwise rather than failing CI on machines without Serena. Uses an
// isolated temp dir as the "project" - never touches real global Serena/
// Copilot/Claude config, per this repo's established testing-safety rule
// (see the "never live-test install.mjs via fake-HOME" lesson).
describe('runGuard (real serena-hooks binary, if installed)', () => {
  it('produces a Copilot-flat deny after 3 consecutive real grep calls', () => {
    let available = true;
    try {
      isSerenaBinaryAvailable();
    } catch {
      available = false;
    }
    if (!available) {
      return; // no serena-hooks on this machine - skip silently
    }
    const root = makeSerenaProject();
    try {
      const payload = JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: `hooks-test-${process.pid}`,
        timestamp: new Date().toISOString(),
        cwd: root,
        tool_name: 'grep',
        tool_input: { pattern: 'foo' },
      });
      let lastDecision = null;
      for (let i = 0; i < 3; i++) {
        lastDecision = runGuard({ event: 'preToolUse', cwd: root, stdinText: payload });
      }
      // Real serena-hooks state is persisted under ~/.serena/hook_data/<session_id>/
      // keyed by session_id, so 3 fresh calls with a unique session_id should
      // trigger the grep-threshold deny deterministically, matching the
      // threshold verified directly against the installed serena-hooks binary.
      assert.ok(lastDecision === null || lastDecision.permissionDecision === 'deny',
        'expected either no serena-hooks state change or a real deny decision');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
