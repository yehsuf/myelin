import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { posix } from 'node:path';
import { managedProfilePathBlock, managedMyelinCommandLine, managedRegistryMyelinDirVar, renderWindowsProfilePathLines } from '../src/install.mjs';

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
    const expectedBin = posix.join('/custom/mroot', 'bin');
    // The relocated bin is spliced in as a single-quoted literal.
    assert.ok(posixExport.includes(`:"'${expectedBin}'":$PATH`), posixExport);
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
    assert.ok(posixExport.includes(":\"'/custom/mroot/bin'\":$PATH"), posixExport);
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

  it('posix default keeps the managed bin export exactly shell-portable', () => {
    const { posixExport } = managedProfilePathBlock({
      os: 'darwin',
      home: '/home/alice',
      env: {},
    });
    assert.equal(posixExport, '\nexport PATH="$HOME/.local/bin:$HOME/.myelin/bin:$PATH"');
  });

  it('posix neutralizes command substitution in a relocated managed bin path', () => {
    const { posixExport } = managedProfilePathBlock({
      os: 'linux',
      home: '/home/alice',
      env: { MYELIN_DIR: '/opt/$(touch pwned)/myelin' },
    });
    // The `$(…)` must survive verbatim inside single quotes, never as a
    // command substitution the shell would execute when sourcing the profile.
    assert.equal(
      posixExport,
      "\nexport PATH=\"$HOME/.local/bin:\"'/opt/$(touch pwned)/myelin/bin'\":$PATH\"",
    );
    assert.ok(!posixExport.includes('$(touch pwned)/myelin/bin:$PATH'), posixExport);
  });

  it('posix neutralizes backtick command substitution in a relocated managed bin path', () => {
    const { posixExport } = managedProfilePathBlock({
      os: 'darwin',
      home: '/home/alice',
      env: { MYELIN_DIR: '/opt/`id`/myelin' },
    });
    assert.equal(
      posixExport,
      "\nexport PATH=\"$HOME/.local/bin:\"'/opt/`id`/myelin/bin'\":$PATH\"",
    );
  });

  it('posix neutralizes an embedded double quote in a relocated managed bin path', () => {
    const { posixExport } = managedProfilePathBlock({
      os: 'linux',
      home: '/home/alice',
      env: { MYELIN_DIR: '/opt/a"; rm -rf ~; "b/myelin' },
    });
    // The stray double quote stays inside the single-quoted literal, so it can
    // never break out of the PATH string to inject a following command.
    assert.equal(
      posixExport,
      "\nexport PATH=\"$HOME/.local/bin:\"'/opt/a\"; rm -rf ~; \"b/myelin/bin'\":$PATH\"",
    );
  });

  it('posix neutralizes variable expansion in a relocated managed bin path', () => {
    const { posixExport } = managedProfilePathBlock({
      os: 'darwin',
      home: '/home/alice',
      env: { MYELIN_DIR: '/opt/$HOME/myelin' },
    });
    // `$HOME` in the relocated literal must not expand — only the leading
    // `$HOME/.local/bin` and trailing `$PATH` are meant to be shell variables.
    assert.equal(
      posixExport,
      "\nexport PATH=\"$HOME/.local/bin:\"'/opt/$HOME/myelin/bin'\":$PATH\"",
    );
  });

  it('posix escapes an embedded single quote in a relocated managed bin path', () => {
    const { posixExport } = managedProfilePathBlock({
      os: 'linux',
      home: '/home/alice',
      env: { MYELIN_DIR: "/opt/o'brien/myelin" },
    });
    assert.equal(
      posixExport,
      "\nexport PATH=\"$HOME/.local/bin:\"'/opt/o'\\''brien/myelin/bin'\":$PATH\"",
    );
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

// ── I1: `myelin update` forwards the resolved managed root to the staged
// installer as MYELIN_DIR, and resolveMyelinRoot NEVER returns blank — so a
// DEFAULT install has MYELIN_DIR set to exactly <home>/.myelin during update.
// The profile block must recognize that as the default (NOT a relocation) and
// keep the portable $HOME-relative PATH form with no absolute MYELIN_DIR export,
// so repeated updates never rewrite ~/.zshrc to a hardcoded absolute path.
describe('managedProfilePathBlock — default install is never treated as relocated (I1)', () => {
  it('an explicit MYELIN_DIR equal to the default keeps the portable $HOME form', () => {
    const { posixExport, posixMyelinDirExport } = managedProfilePathBlock({
      os: 'darwin',
      home: '/home/alice',
      env: { MYELIN_DIR: '/home/alice/.myelin' },
    });
    assert.equal(posixExport, '\nexport PATH="$HOME/.local/bin:$HOME/.myelin/bin:$PATH"');
    assert.equal(posixMyelinDirExport, '');
  });

  it('re-running update (forwarded default MYELIN_DIR) does not rewrite to an absolute path', () => {
    const env = { MYELIN_DIR: '/home/alice/.myelin' };
    const first = managedProfilePathBlock({ os: 'linux', home: '/home/alice', env });
    const second = managedProfilePathBlock({ os: 'linux', home: '/home/alice', env });
    // Idempotent + portable: both runs keep the $HOME form and never emit an
    // absolute MYELIN_DIR export.
    assert.equal(first.posixExport, '\nexport PATH="$HOME/.local/bin:$HOME/.myelin/bin:$PATH"');
    assert.equal(second.posixExport, first.posixExport);
    assert.equal(first.posixMyelinDirExport, '');
    assert.ok(!first.posixExport.includes('/home/alice/.myelin/bin'), first.posixExport);
  });

  it('a genuinely relocated MYELIN_DIR still emits the absolute form + escaped export', () => {
    const { posixExport, posixMyelinDirExport } = managedProfilePathBlock({
      os: 'linux',
      home: '/home/alice',
      env: { MYELIN_DIR: '/custom/mroot' },
    });
    assert.ok(posixExport.includes(":\"'/custom/mroot/bin'\":$PATH"), posixExport);
    assert.equal(posixMyelinDirExport, "\nexport MYELIN_DIR='/custom/mroot'");
  });
});

// ── I10: a relocated Windows root must persist $env:MYELIN_DIR in the managed
// PowerShell profile block (only when relocated), using PowerShell single-quote
// escaping, and carrying the NATIVE Windows form of the root (so a mounted
// /mnt/<drive>/… WSL root becomes <Drive>:\…). A default install emits nothing.
describe('managedProfilePathBlock — Windows MYELIN_DIR export (I10)', () => {
  it('emits no windowsMyelinDirExport for a default install', () => {
    const { windowsMyelinDirExport } = managedProfilePathBlock({
      os: 'windows',
      home: 'C:\\Users\\alice',
      env: {},
    });
    assert.equal(windowsMyelinDirExport, '');
  });

  it('emits no windowsMyelinDirExport when MYELIN_DIR equals the default root', () => {
    const { windowsMyelinDirExport } = managedProfilePathBlock({
      os: 'windows',
      home: 'C:\\Users\\alice',
      env: { MYELIN_DIR: 'C:\\Users\\alice\\.myelin' },
    });
    assert.equal(windowsMyelinDirExport, '');
  });

  it('emits an escaped $env:MYELIN_DIR for a relocated Windows drive root', () => {
    const { windowsMyelinDirExport } = managedProfilePathBlock({
      os: 'windows',
      home: 'C:\\Users\\alice',
      env: { MYELIN_DIR: 'D:\\managed' },
    });
    assert.equal(windowsMyelinDirExport, "$env:MYELIN_DIR = 'D:\\managed'");
  });

  it('persists the NATIVE Windows form of a mounted WSL root in the PS export', () => {
    const { windowsMyelinDirExport } = managedProfilePathBlock({
      os: 'windows',
      home: '/home/alice',
      env: { MYELIN_DIR: '/mnt/d/managed/myelin' },
    });
    assert.equal(windowsMyelinDirExport, "$env:MYELIN_DIR = 'D:\\managed\\myelin'");
  });

  it('doubles an embedded single quote per PowerShell literal rules', () => {
    const { windowsMyelinDirExport } = managedProfilePathBlock({
      os: 'windows',
      home: 'C:\\Users\\alice',
      env: { MYELIN_DIR: "D:\\o'brien\\managed" },
    });
    assert.equal(windowsMyelinDirExport, "$env:MYELIN_DIR = 'D:\\o''brien\\managed'");
  });

  it('posix branch never emits a windowsMyelinDirExport', () => {
    const relocated = managedProfilePathBlock({
      os: 'linux',
      home: '/home/alice',
      env: { MYELIN_DIR: '/custom/mroot' },
    });
    assert.equal(relocated.windowsMyelinDirExport, '');
  });
});

// ── I10: the registry (HKCU\Environment) persistence must carry the NATIVE
// Windows form of a relocated root — a mounted WSL `/mnt/<drive>/…` becomes
// `<Drive>:\…`. A default install persists nothing.
describe('managedRegistryMyelinDirVar — native-form registry persistence (I10)', () => {
  it('persists nothing for a default install', () => {
    assert.deepEqual(
      managedRegistryMyelinDirVar({ os: 'windows', home: 'C:\\Users\\alice', env: {} }),
      {},
    );
  });

  it('persists nothing when MYELIN_DIR equals the default root', () => {
    assert.deepEqual(
      managedRegistryMyelinDirVar({
        os: 'windows',
        home: 'C:\\Users\\alice',
        env: { MYELIN_DIR: 'C:\\Users\\alice\\.myelin' },
      }),
      {},
    );
  });

  it('persists a relocated Windows drive root verbatim', () => {
    assert.deepEqual(
      managedRegistryMyelinDirVar({
        os: 'windows',
        home: 'C:\\Users\\alice',
        env: { MYELIN_DIR: 'D:\\managed' },
      }),
      { MYELIN_DIR: 'D:\\managed' },
    );
  });

  it('converts a mounted WSL root to its native <Drive>:\\ form', () => {
    assert.deepEqual(
      managedRegistryMyelinDirVar({
        os: 'windows',
        home: '/home/alice',
        env: { MYELIN_DIR: '/mnt/d/managed/myelin' },
      }),
      { MYELIN_DIR: 'D:\\managed\\myelin' },
    );
  });
});

// I2 (SECURITY): the `myelin` command line emitted into the managed profile block
// embeds the MYELIN_DIR-derived managed command path. A relocated managed root
// containing $(...), backticks, $VAR, or a quote must be an inert single-quoted
// literal — never executed/expanded when the profile is sourced or the alias run.
describe('managedMyelinCommandLine — POSIX alias single-quotes the managed path (I2)', () => {
  it('single-quotes a normal managed command path', () => {
    assert.equal(
      managedMyelinCommandLine({ os: 'darwin', commandPath: '/home/alice/.myelin/bin/myelin' }),
      "alias myelin='/home/alice/.myelin/bin/myelin'",
    );
  });

  it('neutralizes $(...) command substitution in the managed command path', () => {
    const line = managedMyelinCommandLine({ os: 'linux', commandPath: '/opt/$(printf INJECTED)/bin/myelin' });
    assert.equal(line, "alias myelin='/opt/$(printf INJECTED)/bin/myelin'");
    assert.ok(!line.includes('"'), line);
  });

  it('neutralizes backtick command substitution in the managed command path', () => {
    assert.equal(
      managedMyelinCommandLine({ os: 'darwin', commandPath: '/opt/`id`/bin/myelin' }),
      "alias myelin='/opt/`id`/bin/myelin'",
    );
  });

  it('neutralizes $VAR expansion in the managed command path', () => {
    assert.equal(
      managedMyelinCommandLine({ os: 'linux', commandPath: '/opt/$HOME/bin/myelin' }),
      "alias myelin='/opt/$HOME/bin/myelin'",
    );
  });

  it('escapes an embedded single quote in the managed command path', () => {
    assert.equal(
      managedMyelinCommandLine({ os: 'darwin', commandPath: "/opt/o'brien/bin/myelin" }),
      "alias myelin='/opt/o'\\''brien/bin/myelin'",
    );
  });

  it('neutralizes an embedded double quote in the managed command path', () => {
    assert.equal(
      managedMyelinCommandLine({ os: 'linux', commandPath: '/opt/a"; rm -rf ~; "b/bin/myelin' }),
      "alias myelin='/opt/a\"; rm -rf ~; \"b/bin/myelin'",
    );
  });
});

describe('managedMyelinCommandLine — Windows function single-quotes the managed path (I2)', () => {
  it('uses the PowerShell call operator with a single-quoted literal path', () => {
    assert.equal(
      managedMyelinCommandLine({ os: 'windows', commandPath: 'C:\\Users\\alice\\.myelin\\bin\\myelin.cmd' }),
      "function global:myelin { & 'C:\\Users\\alice\\.myelin\\bin\\myelin.cmd' @args }",
    );
  });

  it('neutralizes PowerShell subexpression $(...) in the managed path', () => {
    const line = managedMyelinCommandLine({ os: 'windows', commandPath: 'D:\\$(rm x)\\bin\\myelin.cmd' });
    assert.equal(line, "function global:myelin { & 'D:\\$(rm x)\\bin\\myelin.cmd' @args }");
    assert.ok(!line.includes('"'), line);
  });

  it('doubles an embedded single quote per PowerShell literal-string rules', () => {
    assert.equal(
      managedMyelinCommandLine({ os: 'windows', commandPath: "D:\\o'brien\\myelin.cmd" }),
      "function global:myelin { & 'D:\\o''brien\\myelin.cmd' @args }",
    );
  });
});

// Security regression (fix-review #1): the PowerShell $PROFILE PATH lines embed
// managed (MYELIN_DIR-derived) path entries. A relocated managed bin dir is
// arbitrary user text and must be an inert single-quoted PowerShell literal —
// while the trusted `$env:`-prefixed constants must still expand.
describe('renderWindowsProfilePathLines — managed path entries are inert literals', () => {
  it('single-quotes a relocated managed bin dir so $(...)/`/$VAR can not run', () => {
    const relocated = 'D:\\ev$(calc)`bt`$VAR\\bin';
    const lines = renderWindowsProfilePathLines([relocated]);
    // The relocated path appears ONLY as a single-quoted literal (never inside a
    // double-quoted, expanding PowerShell string).
    assert.ok(lines.includes(`'D:\\ev$(calc)\`bt\`$VAR\\bin'`), lines);
    assert.ok(!/"\*D:\\/.test(lines), `must not double-quote the managed path: ${lines}`);
  });

  it('escapes an embedded single quote in a relocated managed bin dir', () => {
    const lines = renderWindowsProfilePathLines(["D:\\o'brien\\bin"]);
    assert.ok(lines.includes(`'D:\\o''brien\\bin'`), lines);
  });

  it('keeps $env:-prefixed trusted entries in an expanding double-quoted string', () => {
    const lines = renderWindowsProfilePathLines(['$env:USERPROFILE\\.local\\bin']);
    assert.ok(lines.includes('"$env:USERPROFILE\\.local\\bin"'), lines);
    // No single-quoting of the trusted, expandable variable reference.
    assert.ok(!lines.includes("'$env:USERPROFILE"), lines);
  });

  it('produces a working prepend guard for each entry', () => {
    const lines = renderWindowsProfilePathLines(['$env:APPDATA\\npm', 'D:\\managed\\bin']);
    const rows = lines.split('\n');
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(row.startsWith('if ($env:PATH -notlike ('), row);
      assert.ok(row.includes("+ ';' + $env:PATH"), row);
    }
  });
});
