'use strict';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectClipboardCandidates } from '../src/detect/clipboard.mjs';

describe('detectClipboardCandidates', () => {
  it('darwin → pbcopy only', () => {
    const c = detectClipboardCandidates({ platform: 'darwin', env: {} });
    assert.equal(c.length, 1);
    assert.equal(c[0].cmd, 'pbcopy');
  });

  it('win32 → clip first, powershell fallback', () => {
    const c = detectClipboardCandidates({ platform: 'win32', env: {} });
    assert.equal(c[0].cmd, 'clip');
    assert.equal(c[1].cmd, 'powershell');
    assert.ok(c[1].args.join(' ').includes('[Console]::In.ReadToEnd()'),
      'PowerShell must use [Console]::In, not $input');
  });

  it('win32 powershell args have -NonInteractive and -NoProfile', () => {
    const c = detectClipboardCandidates({ platform: 'win32', env: {} });
    const ps = c.find(x => x.cmd === 'powershell');
    assert.ok(ps.args.includes('-NonInteractive'));
    assert.ok(ps.args.includes('-NoProfile'));
  });

  it('linux WSL → clip.exe first', () => {
    const c = detectClipboardCandidates({
      platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' },
    });
    assert.equal(c[0].cmd, 'clip.exe');
    assert.ok(c.some(x => x.cmd === 'xclip'), 'should fall back to xclip');
  });

  it('linux WSL detected via WSLENV', () => {
    const c = detectClipboardCandidates({
      platform: 'linux', env: { WSLENV: 'PATH/l' },
    });
    assert.equal(c[0].cmd, 'clip.exe');
  });

  it('linux WSL detected via WSL_INTEROP', () => {
    const c = detectClipboardCandidates({
      platform: 'linux', env: { WSL_INTEROP: '/run/WSL/5' },
    });
    assert.equal(c[0].cmd, 'clip.exe');
  });

  it('linux Wayland → wl-copy first, xclip fallback', () => {
    const c = detectClipboardCandidates({
      platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' },
    });
    assert.equal(c[0].cmd, 'wl-copy');
    assert.equal(c[1].cmd, 'xclip');
  });

  it('linux X11 → xclip first, wl-copy fallback', () => {
    const c = detectClipboardCandidates({
      platform: 'linux', env: { DISPLAY: ':0' },
    });
    assert.equal(c[0].cmd, 'xclip');
    assert.equal(c[1].cmd, 'wl-copy');
  });

  it('linux headless (no display vars) → xclip first', () => {
    const c = detectClipboardCandidates({ platform: 'linux', env: {} });
    assert.equal(c[0].cmd, 'xclip');
  });

  it('xclip always uses -selection clipboard', () => {
    const c = detectClipboardCandidates({ platform: 'linux', env: {} });
    const xclip = c.find(x => x.cmd === 'xclip');
    assert.ok(xclip.args.includes('-selection'));
    assert.ok(xclip.args.includes('clipboard'));
  });

  it('WSL env vars do not trigger Wayland branch', () => {
    // WAYLAND_DISPLAY may be set in WSL — WSL check takes priority
    const c = detectClipboardCandidates({
      platform: 'linux',
      env: { WSL_DISTRO_NAME: 'Ubuntu', WAYLAND_DISPLAY: 'wayland-0' },
    });
    assert.equal(c[0].cmd, 'clip.exe', 'WSL should take priority over Wayland');
  });

  it('all cmds are non-empty strings', () => {
    const platforms = [
      { platform: 'darwin', env: {} },
      { platform: 'win32', env: {} },
      { platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' } },
      { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } },
      { platform: 'linux', env: { DISPLAY: ':0' } },
      { platform: 'linux', env: {} },
    ];
    for (const opts of platforms) {
      const c = detectClipboardCandidates(opts);
      assert.ok(c.length > 0, `no candidates for ${JSON.stringify(opts)}`);
      for (const { cmd, args } of c) {
        assert.ok(typeof cmd === 'string' && cmd.length > 0);
        assert.ok(Array.isArray(args));
      }
    }
  });
});

import { buildOsc52Candidate } from '../src/detect/clipboard.mjs';

describe('buildOsc52Candidate (COMPACT-CLIP-001)', () => {
  it('returns null when OSC52_SOCKET is absent', () => {
    assert.equal(buildOsc52Candidate({}), null);
    assert.equal(buildOsc52Candidate({ OTHER: 'val' }), null);
  });

  it('returns python3 socket-client candidate when OSC52_SOCKET is set', () => {
    const c = buildOsc52Candidate({ OSC52_SOCKET: '/tmp/osc52d-501.sock' });
    assert.ok(c !== null, 'should return a candidate');
    assert.equal(c.cmd, 'python3');
    assert.ok(Array.isArray(c.args));
    assert.equal(c.args[0], '-c');
    assert.ok(c.args[1].includes('/tmp/osc52d-501.sock'), 'script should embed socket path');
    assert.ok(c.args[1].includes('socket.AF_UNIX'), 'script should use Unix socket');
    assert.ok(c.args[1].includes('sys.stdin.buffer.read()'), 'script should read stdin');
  });

  it('candidate script sends stdin content to socket (structure check)', () => {
    const c = buildOsc52Candidate({ OSC52_SOCKET: '/tmp/test.sock' });
    const script = c.args[1];
    // Must import socket and sys, connect, sendall, close
    assert.ok(script.includes('import socket'), 'must import socket');
    assert.ok(script.includes('connect('), 'must connect to socket');
    assert.ok(script.includes('sendall('), 'must sendall');
    assert.ok(script.includes('close()'), 'must close');
  });

  it('rejects socket paths containing single quotes (injection guard)', () => {
    const c = buildOsc52Candidate({ OSC52_SOCKET: "/tmp/osc52d-it's.sock" });
    assert.equal(c, null, 'path with single quote should be rejected');
  });

  it('osc52 candidate comes first on darwin when OSC52_SOCKET is set', () => {
    const candidates = detectClipboardCandidates({
      platform: 'darwin',
      env: { OSC52_SOCKET: '/tmp/osc52d-501.sock' },
    });
    assert.equal(candidates[0].cmd, 'python3', 'osc52 candidate should be first');
    assert.equal(candidates[1].cmd, 'pbcopy', 'pbcopy should be second');
  });

  it('osc52 candidate comes first on linux when OSC52_SOCKET is set', () => {
    const candidates = detectClipboardCandidates({
      platform: 'linux',
      env: { OSC52_SOCKET: '/tmp/osc52d-501.sock' },
    });
    assert.equal(candidates[0].cmd, 'python3', 'osc52 candidate should be first');
  });

  it('darwin without OSC52_SOCKET still returns only pbcopy', () => {
    const candidates = detectClipboardCandidates({ platform: 'darwin', env: {} });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].cmd, 'pbcopy');
  });
});
