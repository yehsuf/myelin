import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { posix, win32 } from 'node:path';
import { ensureToolPath } from '../src/detect/tool-path.mjs';

describe('ensureToolPath', () => {
  it('adds ~/.myelin/bin and ~/.local/bin on Linux (the regression: was Windows-only)', () => {
    const env = { PATH: '/usr/bin:/bin' };
    ensureToolPath({ home: '/home/u', platform: 'linux', env });
    const parts = env.PATH.split(':');
    assert.ok(parts.includes(posix.join('/home/u', '.myelin', 'bin')), env.PATH);
    assert.ok(parts.includes(posix.join('/home/u', '.local', 'bin')), env.PATH);
    // original entries preserved
    assert.ok(parts.includes('/usr/bin') && parts.includes('/bin'));
  });

  it('adds them on macOS too, with the POSIX `:` delimiter', () => {
    const env = { PATH: '/usr/bin' };
    ensureToolPath({ home: '/Users/u', platform: 'darwin', env });
    assert.ok(env.PATH.split(':').includes(posix.join('/Users/u', '.myelin', 'bin')), env.PATH);
    assert.ok(!env.PATH.includes(';'), 'must not use the Windows separator');
  });

  it('uses the `;` delimiter and Windows dirs on win32', () => {
    const env = { PATH: 'C:\\Windows' };
    ensureToolPath({ home: 'C:\\Users\\u', platform: 'win32', env });
    const parts = env.PATH.split(';');
    assert.ok(parts.includes(win32.join('C:\\Users\\u', '.myelin', 'bin')), env.PATH);
    assert.ok(parts.some((p) => p.includes('uv')), 'includes uv bin on Windows');
    assert.ok(parts.includes('C:\\Windows'));
  });

  it('is idempotent — repeated calls do not duplicate entries', () => {
    const env = { PATH: '/usr/bin' };
    ensureToolPath({ home: '/home/u', platform: 'linux', env });
    const once = env.PATH;
    ensureToolPath({ home: '/home/u', platform: 'linux', env });
    assert.equal(env.PATH, once);
  });

  it('handles an empty/absent PATH', () => {
    const env = {};
    ensureToolPath({ home: '/home/u', platform: 'linux', env });
    assert.ok(env.PATH.split(':').includes(posix.join('/home/u', '.myelin', 'bin')));
  });

  it('picks up nvm4w node dir from env on Windows', () => {
    const env = { PATH: 'C:\\Windows', NVM4W_HOME: 'C:\\nvm4w' };
    ensureToolPath({ home: 'C:\\Users\\u', platform: 'win32', env });
    assert.ok(env.PATH.split(';').includes(win32.join('C:\\nvm4w', 'nodejs')), env.PATH);
  });
});

describe('ensureToolPath — managed root relocation (MYELIN_DIR)', () => {
  it('adds the MYELIN_DIR-derived bin dir and not the default managed bin', () => {
    const env = { PATH: '/usr/bin', MYELIN_DIR: '/custom/mroot' };
    ensureToolPath({ home: '/home/u', platform: 'linux', env });
    const parts = env.PATH.split(':');
    assert.ok(parts.includes('/custom/mroot/bin'), env.PATH);
    assert.ok(!parts.includes('/home/u/.myelin/bin'), 'default managed bin must not be added when MYELIN_DIR is set');
    // Non-managed user dirs are preserved untouched.
    assert.ok(parts.includes('/home/u/.local/bin'), env.PATH);
  });

  it('falls back to <home>/.myelin/bin when MYELIN_DIR is blank', () => {
    const env = { PATH: '/usr/bin', MYELIN_DIR: '   ' };
    ensureToolPath({ home: '/home/u', platform: 'linux', env });
    assert.ok(env.PATH.split(':').includes('/home/u/.myelin/bin'), env.PATH);
  });
});
