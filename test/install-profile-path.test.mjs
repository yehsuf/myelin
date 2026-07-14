import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { managedProfilePathBlock } from '../src/install.mjs';

describe('managedProfilePathBlock — managed bin root in shell profile', () => {
  it('posix default keeps shell-portable $HOME/.myelin/bin', () => {
    const { posixExport, windowsPathDirs } = managedProfilePathBlock({
      os: 'darwin',
      home: '/home/alice',
      env: {},
    });
    assert.equal(posixExport, '\nexport PATH="$HOME/.local/bin:$HOME/.myelin/bin:$PATH"');
    assert.deepEqual(windowsPathDirs, []);
  });

  it('posix honors MYELIN_DIR — profile PATH points at the relocated managed bin root', () => {
    const { posixExport } = managedProfilePathBlock({
      os: 'linux',
      home: '/home/alice',
      env: { MYELIN_DIR: '/custom/mroot' },
    });
    const expectedBin = join('/custom/mroot', 'bin');
    assert.ok(posixExport.includes(`:${expectedBin}:$PATH`), posixExport);
    assert.ok(!posixExport.includes('.myelin/bin'), posixExport);
  });

  it('posix default does not export MYELIN_DIR', () => {
    const { posixMyelinDirExport } = managedProfilePathBlock({
      os: 'darwin',
      home: '/home/alice',
      env: {},
    });
    assert.equal(posixMyelinDirExport, '');
  });

  it('posix exports the relocated MYELIN_DIR so a new shell resolves the same root as PATH', () => {
    const { posixExport, posixMyelinDirExport } = managedProfilePathBlock({
      os: 'linux',
      home: '/home/alice',
      env: { MYELIN_DIR: '/custom/mroot' },
    });
    assert.equal(posixMyelinDirExport, "\nexport MYELIN_DIR='/custom/mroot'");
    assert.ok(posixExport.includes(':/custom/mroot/bin:$PATH'), posixExport);
  });

  it('posix single-quotes a relocated MYELIN_DIR containing spaces and metacharacters', () => {
    const { posixMyelinDirExport } = managedProfilePathBlock({
      os: 'darwin',
      home: '/home/alice',
      env: { MYELIN_DIR: '/opt/my roots/$weird' },
    });
    assert.equal(posixMyelinDirExport, "\nexport MYELIN_DIR='/opt/my roots/$weird'");
  });

  it('posix escapes an embedded single quote in a relocated MYELIN_DIR', () => {
    const { posixMyelinDirExport } = managedProfilePathBlock({
      os: 'linux',
      home: '/home/alice',
      env: { MYELIN_DIR: "/opt/o'brien/myelin" },
    });
    assert.equal(posixMyelinDirExport, "\nexport MYELIN_DIR='/opt/o'\\''brien/myelin'");
  });

  it('windows never emits a POSIX MYELIN_DIR export even when relocated', () => {
    const { posixMyelinDirExport } = managedProfilePathBlock({
      os: 'windows',
      home: 'C:\\Users\\alice',
      env: { MYELIN_DIR: 'D:\\managed' },
    });
    assert.equal(posixMyelinDirExport, '');
  });

  it('windows default keeps $env:USERPROFILE\\.myelin\\bin among the PATH dirs', () => {
    const { posixExport, windowsPathDirs } = managedProfilePathBlock({
      os: 'windows',
      home: 'C:\\Users\\alice',
      env: {},
    });
    assert.equal(posixExport, '');
    assert.ok(windowsPathDirs.includes('$env:USERPROFILE\\.myelin\\bin'), windowsPathDirs.join(','));
    assert.ok(windowsPathDirs.includes('$env:USERPROFILE\\.local\\bin'), windowsPathDirs.join(','));
  });

  it('windows honors MYELIN_DIR — the managed bin entry follows the relocated root', () => {
    const { windowsPathDirs } = managedProfilePathBlock({
      os: 'windows',
      home: 'C:\\Users\\alice',
      env: { MYELIN_DIR: 'D:\\managed' },
    });
    // A Windows-style MYELIN_DIR keeps Windows separators regardless of host —
    // managedPaths derives the separator from the resolved root's own style.
    const relocated = 'D:\\managed\\bin';
    assert.ok(windowsPathDirs.includes(relocated), windowsPathDirs.join(','));
    assert.ok(!windowsPathDirs.some(p => p.includes('USERPROFILE\\.myelin')), windowsPathDirs.join(','));
  });

  it('converts a mounted WSL MYELIN_DIR to a Windows PATH entry', () => {
    const { windowsPathDirs } = managedProfilePathBlock({
      os: 'windows',
      home: '/home/alice',
      env: { MYELIN_DIR: '/mnt/c/Users/alice/myelin' },
    });

    assert.ok(windowsPathDirs.includes('C:\\Users\\alice\\myelin\\bin'), windowsPathDirs.join(','));
    assert.ok(!windowsPathDirs.some((path) => path.startsWith('/mnt/c/')), windowsPathDirs.join(','));
  });
});
