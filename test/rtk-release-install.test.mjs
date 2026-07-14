import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildRtkReleaseInstallPlan, tryGithubRelease } from '../src/tools/rtk.mjs';
import { managedPaths } from '../src/shared/myelin-paths.mjs';

const EVIL_BINDIR = "/evil/$(touch pwned)/`whoami`/'q'/%TEMP%/root/.myelin/bin";
const URL = 'https://github.com/rtk-ai/rtk/releases/download/v1/rtk-x86_64-linux.tar.gz';

describe('buildRtkReleaseInstallPlan — managed binDir injection safety', () => {
  it('POSIX: passes url + managed binDir as literal positional argv elements (never in a shell string)', () => {
    const plan = buildRtkReleaseInstallPlan({ platform: 'linux', binDir: EVIL_BINDIR, url: URL });
    assert.equal(plan.download.file, '/bin/bash');
    assert.equal(plan.download.args[0], '-c');
    // url is $1, binDir is $2 — both opaque argv slots.
    assert.equal(plan.download.args[3], URL);
    assert.equal(plan.download.args[4], EVIL_BINDIR);
    const script = plan.download.args[1];
    assert.ok(!script.includes('evil'), `script must not interpolate binDir:\n${script}`);
    assert.ok(script.includes('url="$1"') && script.includes('dir="$2"'), script);
    // The PATH smoke test runs `rtk --version` with binDir prepended via env, not a shell string.
    assert.equal(plan.verify.file, 'rtk');
    assert.deepEqual(plan.verify.args, ['--version']);
    assert.ok(plan.verify.env.PATH.startsWith(`${EVIL_BINDIR}:`), plan.verify.env.PATH);
  });

  it('Windows: passes managed binDir + url via child ENV (PowerShell reads $env as data; no argv is a shell command line)', () => {
    const plan = buildRtkReleaseInstallPlan({ platform: 'win32', binDir: EVIL_BINDIR, url: URL, baseEnv: {} });
    assert.equal(plan.download.file, 'powershell');
    assert.deepEqual(plan.download.args.slice(0, 2), ['-NoProfile', '-Command']);
    // The payload is NOT spliced into any argv element…
    assert.ok(!plan.download.args.some((a) => a.includes('evil')), JSON.stringify(plan.download.args));
    assert.ok(!plan.download.args.some((a) => a.includes(URL)), JSON.stringify(plan.download.args));
    // …it rides in the environment, where $env:* is a literal string, never code.
    assert.equal(plan.download.env.MYELIN_RTK_BINDIR, EVIL_BINDIR);
    assert.equal(plan.download.env.MYELIN_RTK_URL, URL);
    // The PowerShell script references only $env: variables (no interpolation of the path).
    assert.ok(plan.download.args[2].includes('$env:MYELIN_RTK_BINDIR'));
    assert.ok(plan.download.args[2].includes('$env:MYELIN_RTK_URL'));
    assert.ok(!plan.download.args[2].includes('%TEMP%\\root'), plan.download.args[2]);
    assert.equal(plan.verify, null);
  });

  it('POSIX exec is inert against command substitution when actually run (no side effect)', async () => {
    const { execFileSync } = await import('node:child_process');
    const { randomBytes } = await import('node:crypto');
    const { existsSync } = await import('node:fs');
    const marker = `${process.cwd()}/_rtk_pwn_${randomBytes(4).toString('hex')}`;
    // A binDir whose $() would run `touch <marker>` if it ever reached a shell.
    const binDir = `/nonexistent/$(touch ${marker})/bin`;
    const plan = buildRtkReleaseInstallPlan({ platform: 'linux', binDir, url: 'file:///dev/null' });
    try { execFileSync(plan.download.file, plan.download.args, { stdio: 'pipe' }); } catch { /* curl/tar failure expected */ }
    assert.ok(!existsSync(marker), 'command substitution in binDir must NOT execute');
  });
});

describe('tryGithubRelease — arg-array exec wiring (injected deps, no live network/shell)', () => {
  it('resolves the managed binDir and hands it to execFileSync as a literal positional arg', async () => {
    const home = '/home/alice';
    const expectedBinDir = managedPaths({ home }).binDir;
    const execFileCalls = [];
    let mkdirTarget = null;

    const ok = await tryGithubRelease({
      home,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: async () => ({
        json: async () => ({
          assets: [{ name: 'rtk-x86_64-linux.tar.gz', browser_download_url: URL }],
        }),
      }),
      mkdirSyncImpl: (p) => { mkdirTarget = p; },
      execFileSyncImpl: (file, args) => execFileCalls.push({ file, args }),
    });

    assert.equal(ok, true);
    assert.equal(mkdirTarget, expectedBinDir);
    const download = execFileCalls[0];
    assert.equal(download.file, '/bin/bash');
    assert.equal(download.args[4], expectedBinDir, 'managed binDir is a literal argv element');
    assert.equal(download.args[3], URL);
  });
});
