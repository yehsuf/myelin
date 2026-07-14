import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { posixSingleQuote, powershellSingleQuote } from '../src/shared/shell-quote.mjs';

// A POSIX `sh` is absent on Windows hosts. Guard the behavioral test so full
// injection coverage runs on POSIX while the suite stays green on Windows.
function hasPosixSh() {
  if (process.platform === 'win32') return false;
  try {
    const r = spawnSync('sh', ['-c', 'exit 0']);
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

const installSrc = readFileSync(fileURLToPath(new URL('../src/install.mjs', import.meta.url)), 'utf8');

// STEP 2a: the legacy ~/.tokenstack -> ~/.myelin migration fallbacks must move
// files with fs cp/rm APIs — never a shell `cp -r`/`robocopy` that would parse a
// managed (MYELIN_DIR-derived) newDir/newRepoDir as a shell string.
describe('install migration — managed dirs never reach a shell (STEP 2a)', () => {
  it('uses fs cpSync/rmSync for the managed-root migration', () => {
    assert.ok(installSrc.includes('cpSync(oldDir, newDir, { recursive: true })'), 'cpSync migration missing');
    assert.ok(installSrc.includes('rmSync(oldDir, { recursive: true, force: true })'), 'rmSync cleanup missing');
    assert.ok(installSrc.includes('cpSync(oldRepo, newRepoDir, { recursive: true })'), 'cpSync repo pre-copy missing');
  });

  it('no longer shells `cp -r`/`robocopy` on the managed newDir/newRepoDir', () => {
    assert.ok(!installSrc.includes('cp -r "${oldDir}" "${newDir}"'), 'shell cp of managed newDir still present');
    assert.ok(!installSrc.includes('robocopy "${oldDir}" "${newDir}"'), 'robocopy of managed newDir still present');
    assert.ok(!installSrc.includes('cp -r "${oldRepo}" "${newRepoDir}"'), 'shell cp of managed newRepoDir still present');
    assert.ok(!installSrc.includes('robocopy "${oldRepo}" "${newRepoDir}"'), 'robocopy of managed newRepoDir still present');
  });
});

// STEP 2c: the combined CA-bundle path (managedPaths().caBundlePath, managed-
// derived) is emitted into generated shell/PowerShell profile lines. It must be
// single-quoted via the shared helpers, never spliced raw or in double quotes.
describe('install CA-bundle profile lines — single-quoted managed path (STEP 2c)', () => {
  it('emits the POSIX export via posixSingleQuote and the PS assignment via powershellSingleQuote', () => {
    assert.ok(installSrc.includes('export ${k}=${posixSingleQuote(v)}'), 'POSIX export is not single-quoted');
    assert.ok(installSrc.includes('$env:${k} = ${powershellSingleQuote(v)}'), 'PS assignment is not single-quoted');
  });

  it('no longer emits an unquoted POSIX export or a double-quoted PS assignment', () => {
    assert.ok(!installSrc.includes('export ${k}=${v}'), 'unquoted POSIX export still present');
    assert.ok(!installSrc.includes('$env:${k} = "${v}"'), 'double-quoted PS assignment still present');
  });

  it('PowerShell assignment keeps $() literal inside single quotes (and doubles embedded quotes)', () => {
    const v = "C:\\Corp$(whoami)\\o'brien\\ca.pem";
    const line = `$env:NODE_EXTRA_CA_CERTS = ${powershellSingleQuote(v)}`;
    assert.equal(line, "$env:NODE_EXTRA_CA_CERTS = 'C:\\Corp$(whoami)\\o''brien\\ca.pem'");
    assert.ok(!line.includes('"'), line);
  });
});

describe('install CA-bundle POSIX export — behavioral: injection never executes under sh (STEP 2c)', () => {
  const artifacts = join(process.cwd(), '.test-artifacts', `ca-export-${process.pid}-${randomBytes(4).toString('hex')}`);
  mkdirSync(artifacts, { recursive: true });
  after(() => rmSync(artifacts, { recursive: true, force: true }));

  it('a $(touch sentinel) CA-bundle path stays an inert literal when the export line is sourced', { skip: !hasPosixSh() }, () => {
    const sentinel = join(artifacts, 'pwned');
    const caBundle = `/nonexistent/$(touch ${sentinel})/ca-bundle.pem`;
    // Mirror the exact install.mjs emission: `export ${k}=${posixSingleQuote(v)}`.
    const exportLine = `export NODE_EXTRA_CA_CERTS=${posixSingleQuote(caBundle)}`;
    const script = `${exportLine}\nprintf '%s' "$NODE_EXTRA_CA_CERTS"`;
    const out = execFileSync('sh', ['-c', script], { encoding: 'utf8' });
    assert.equal(existsSync(sentinel), false, 'command substitution executed — injection!');
    assert.equal(out, caBundle, 'sourced CA-bundle var must equal the literal managed path');
  });
});
