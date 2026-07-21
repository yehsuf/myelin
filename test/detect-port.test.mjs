import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPortHolder, isHolderMyelinManaged } from '../src/detect/port.mjs';

describe('getPortHolder', () => {
  it('returns null when the port is free (probe finds nothing)', () => {
    // Inject an execFileSync that throws ENOENT (lsof not available) — should fail-open
    const result = getPortHolder(59999, {
      platform: 'linux',
      execFileSyncImpl: () => { throw new Error('ENOENT'); },
    });
    assert.equal(result, null);
  });

  it('returns null for invalid port', () => {
    assert.equal(getPortHolder(0), null);
    assert.equal(getPortHolder(-1), null);
    assert.equal(getPortHolder(null), null);
  });

  it('parses lsof -F pc output correctly on POSIX', () => {
    // lsof -F pc emits: p<pid>\nc<cmd> per process block
    const lsofOutput = 'p12345\ncheadroom\n';
    const result = getPortHolder(8787, {
      platform: 'darwin',
      execFileSyncImpl: () => Buffer.from(lsofOutput),
    });
    assert.deepEqual(result, { pid: 12345, cmd: 'headroom' });
  });

  it('returns first holder when multiple pids share the port (lsof multi-block)', () => {
    const lsofOutput = 'p11111\ncforeignd\np22222\ncheadroom\n';
    const result = getPortHolder(8787, {
      platform: 'linux',
      execFileSyncImpl: () => Buffer.from(lsofOutput),
    });
    // Returns first valid holder (11111, foreignd)
    assert.deepEqual(result, { pid: 11111, cmd: 'foreignd' });
  });

  it('parses netstat output correctly on Windows (CRLF lines)', () => {
    const netstatOutput = [
      'Proto  Local Address      Foreign Address  State        PID',
      'TCP    0.0.0.0:8788       0.0.0.0:0        LISTENING    9999',
    ].join('\r\n') + '\r\n';
    const result = getPortHolder(8788, {
      platform: 'win32',
      execFileSyncImpl: (cmd) => {
        if (cmd.includes('netstat')) return Buffer.from(netstatOutput);
        // PowerShell stub — return full command line with .myelin path
        return Buffer.from('C:\\Users\\yehsuf\\.myelin\\releases\\main-abc\\node.exe src/cli/index.mjs');
      },
    });
    assert.equal(result?.pid, 9999);
    // cmd should contain the full command line from PowerShell
    assert.ok(result?.cmd.includes('.myelin'), 'cmd should contain full path from PowerShell');
  });

  it('on WSL (platform=win32 but process.platform=linux) uses netstat.exe path', () => {
    const calls = [];
    getPortHolder(8788, {
      platform: 'win32',
      execFileSyncImpl: (cmd, args, opts) => {
        calls.push(cmd);
        // Return empty so it falls through gracefully
        return Buffer.from('');
      },
    });
    // On Linux (WSL), should call the .exe path
    if (process.platform === 'linux') {
      assert.ok(calls[0]?.includes('netstat.exe'), `expected netstat.exe, got: ${calls[0]}`);
    }
  });

  it('returns null when netstat has no LISTENING entry for the port', () => {
    const netstatOutput = 'TCP    0.0.0.0:9999   0.0.0.0:0   LISTENING   1234\n';
    const result = getPortHolder(8787, {
      platform: 'win32',
      execFileSyncImpl: () => Buffer.from(netstatOutput),
    });
    assert.equal(result, null);
  });

  it('does not throw when lsof output has no pid line', () => {
    const result = getPortHolder(8787, {
      platform: 'linux',
      execFileSyncImpl: () => Buffer.from(''),
    });
    assert.equal(result, null);
  });

  it('enriches generic interpreter (node) with full cmdline via ps on POSIX', () => {
    // lsof returns short name 'node'; ps supplements with full argv incl. myelin path
    const lsofOutput = 'p83995\ncnode\n';
    const fullCmdLine = '/usr/local/bin/node /Users/ysufrin/.myelin/releases/main-abc/src/headroom-lite/index.mjs --port 8787';
    const calls = [];
    const result = getPortHolder(8787, {
      platform: 'darwin',
      execFileSyncImpl: (bin, args) => {
        calls.push(bin);
        if (bin === 'lsof') return Buffer.from(lsofOutput);
        if (bin === 'ps') return Buffer.from(fullCmdLine);
        return Buffer.from('');
      },
    });
    assert.equal(calls.includes('ps'), true, 'ps was called for generic interpreter');
    assert.deepEqual(result, { pid: 83995, cmd: fullCmdLine });
  });

  it('does not call ps for non-generic interpreters (headroom, mitmdump)', () => {
    const lsofOutput = 'p12345\ncheadroom\n';
    const calls = [];
    getPortHolder(8787, {
      platform: 'linux',
      execFileSyncImpl: (bin) => {
        calls.push(bin);
        return Buffer.from(lsofOutput);
      },
    });
    assert.ok(!calls.includes('ps'), 'ps must not be called for non-generic cmd');
  });

  it('falls back to short name when ps fails for generic interpreter', () => {
    const lsofOutput = 'p99\ncnode\n';
    const result = getPortHolder(8787, {
      platform: 'linux',
      execFileSyncImpl: (bin) => {
        if (bin === 'lsof') return Buffer.from(lsofOutput);
        throw new Error('ps not available');
      },
    });
    assert.deepEqual(result, { pid: 99, cmd: 'node' }); // falls back to short name
  });
});

describe('isHolderMyelinManaged', () => {
  it('returns false for null holder', () => {
    assert.equal(isHolderMyelinManaged(null, '/home/u/.myelin'), false);
  });

  it('returns true when cmd includes .myelin path', () => {
    assert.equal(
      isHolderMyelinManaged({ pid: 1, cmd: '/home/u/.myelin/components/headroom/bin/headroom' }, '/home/u/.myelin'),
      true,
    );
  });

  it('returns true when cmd includes mitmdump (managed mitmproxy)', () => {
    assert.equal(
      isHolderMyelinManaged({ pid: 2, cmd: 'mitmdump --mode regular' }, '/home/u/.myelin'),
      true,
    );
  });

  it('returns false for a foreign Python headroom not under .myelin', () => {
    // Python running headroom as a package module — headroom is an arg, not executable name
    assert.equal(
      isHolderMyelinManaged({ pid: 3, cmd: '/home/u/venv/bin/python /home/u/venv/lib/python3.12/site-packages/headroom/__main__.py proxy' }, '/home/u/.myelin'),
      false,
    );
  });

  it('returns false for a completely unrelated process', () => {
    assert.equal(
      isHolderMyelinManaged({ pid: 4, cmd: 'node /home/u/myproject/server.js' }, '/home/u/.myelin'),
      false,
    );
  });

  it('returns true when cmd is a managed mitmdump binary', () => {
    assert.equal(
      isHolderMyelinManaged({ pid: 5, cmd: '/usr/local/bin/mitmdump --mode regular' }, '/home/u/.myelin'),
      true,
    );
  });
});
