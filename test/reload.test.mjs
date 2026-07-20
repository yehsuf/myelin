import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReload } from '../src/cli/reload.mjs';

test('macOS terminal reload force-kills a blocked osascript (SIGKILL) instead of hanging', async () => {
  const calls = [];
  const execSyncFn = (cmd, opts) => {
    calls.push({ cmd, opts });
    return '';
  };
  const writes = [];
  await runReload({
    silent: true,
    os: 'darwin',
    shell: '/bin/zsh',
    home: '/tmp/reload-home',
    execSyncFn,
    writeFileSyncFn: (p, c) => writes.push({ p, c }),
  });

  const osascriptCalls = calls.filter(c => c.cmd.includes('osascript'));
  assert.ok(osascriptCalls.length >= 1, 'expected at least one osascript invocation');
  for (const c of osascriptCalls) {
    // A blocked osascript ignores SIGTERM; without SIGKILL execSync hangs forever
    // despite `timeout`. This is the exact installer-hang root cause.
    assert.equal(c.opts.killSignal, 'SIGKILL', 'osascript must be force-killed on timeout');
    assert.ok(Number(c.opts.timeout) > 0, 'osascript must have a positive timeout');
    // `tell application "X"` auto-launches the app; must be guarded by `is running`
    // so reload never OPENS a terminal when none is running.
    assert.match(c.cmd, /is running then/, 'reload must guard with `is running` and never launch a terminal');
    assert.doesNotMatch(c.cmd, /\bactivate\b/, 'reload must never activate/launch a terminal app');
  }
  const joined = osascriptCalls.map(c => c.cmd).join('\n');
  assert.match(joined, /application "Terminal" is running/, 'Terminal.app block must be guarded');
  assert.match(joined, /application "iTerm2" is running/, 'iTerm2 block must be guarded');
});

test('runReload never throws when osascript times out / is killed (best-effort)', async () => {
  const execSyncFn = () => {
    const e = new Error('spawnSync osascript ETIMEDOUT');
    e.code = 'ETIMEDOUT';
    e.signal = 'SIGKILL';
    throw e;
  };
  const writes = [];
  const reloaded = await runReload({
    silent: true,
    os: 'darwin',
    shell: '/bin/zsh',
    home: '/tmp/reload-home',
    execSyncFn,
    writeFileSyncFn: (p, c) => writes.push({ p, c }),
  });

  // Reload is best-effort: a hung/killed osascript must not abort the installer.
  assert.equal(reloaded, false);
  // The reload marker must still be written so hook-based shells can pick it up.
  assert.ok(writes.some(w => String(w.p).endsWith('.myelin-reload')), 'marker file must be written');
});

test('non-darwin reload writes the marker and does not invoke osascript', async () => {
  const calls = [];
  const writes = [];
  await runReload({
    silent: true,
    os: 'linux',
    shell: '/bin/bash',
    home: '/tmp/reload-home',
    execSyncFn: (cmd, opts) => { calls.push(cmd); return ''; },
    writeFileSyncFn: (p, c) => writes.push({ p, c }),
  });
  assert.equal(calls.filter(c => c.includes('osascript')).length, 0);
  assert.ok(writes.some(w => String(w.p).endsWith('.myelin-reload')));
});

test('Terminal.app: skips tabs with node in process list (AI session guard)', async () => {
  const scripts = [];
  await runReload({
    silent: true,
    os: 'darwin',
    shell: '/bin/zsh',
    home: '/tmp/reload-home',
    execSyncFn: (cmd) => { scripts.push(cmd); return ''; },
    writeFileSyncFn: () => {},
  });
  const termScript = scripts.find(s => s.includes('application "Terminal"')) ?? '';
  assert.match(termScript, /hasNode/, 'Terminal.app script must check for node process');
  assert.match(termScript, /not hasNode/, 'Terminal.app script must skip tabs with node running');
});

test('iTerm2: skips session matching TERM_SESSION_ID (installer terminal guard)', async () => {
  const scripts = [];
  const origEnv = process.env.TERM_SESSION_ID;
  process.env.TERM_SESSION_ID = 'test-session-abc123';
  try {
    await runReload({
      silent: true,
      os: 'darwin',
      shell: '/bin/zsh',
      home: '/tmp/reload-home',
      execSyncFn: (cmd) => { scripts.push(cmd); return ''; },
      writeFileSyncFn: () => {},
    });
  } finally {
    if (origEnv === undefined) delete process.env.TERM_SESSION_ID;
    else process.env.TERM_SESSION_ID = origEnv;
  }
  const iterm2Script = scripts.find(s => s.includes('application "iTerm2"')) ?? '';
  assert.match(iterm2Script, /test-session-abc123/, 'iTerm2 script must embed the current session ID');
  assert.match(iterm2Script, /unique id of s is equal to/, 'iTerm2 script must compare session unique id');
});
