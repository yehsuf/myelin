import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { generateGenericPlist, writeValidatedPlist, generateLaunchdWatchdogScript } from '../src/service/launchd.mjs';
import { posixSingleQuote } from '../src/shared/shell-quote.mjs';
import { managedPaths, joinManaged } from '../src/shared/myelin-paths.mjs';

describe('I8 launchd plist XML-escaping', () => {
  it('XML-escapes & < > and double-quotes in the log path (StandardOut/ErrorPath)', () => {
    const xml = generateGenericPlist({
      label: 'com.myelin.test',
      command: '/usr/bin/thing',
      args: ['--go'],
      logPath: '/srv/A&B/<log>/"out".log',
    });
    const escaped = '/srv/A&amp;B/&lt;log&gt;/&quot;out&quot;.log';
    assert.ok(xml.includes(`<key>StandardOutPath</key>\n    <string>${escaped}</string>`));
    assert.ok(xml.includes(`<key>StandardErrorPath</key>\n    <string>${escaped}</string>`));
    assert.ok(!xml.includes('<log>'), 'no raw < > in output');
    assert.ok(!xml.includes('A&B'), 'no raw & in output');
  });

  it('XML-escapes the label and working directory', () => {
    const xml = generateGenericPlist({
      label: 'com.myelin.a&b',
      command: '/usr/bin/thing',
      args: [],
      logPath: '/tmp/x.log',
      workingDirectory: '/srv/work & <dir>',
    });
    assert.ok(xml.includes('<string>com.myelin.a&amp;b</string>'));
    assert.ok(xml.includes('<string>/srv/work &amp; &lt;dir&gt;</string>'));
  });

  it('XML-escapes env keys and values', () => {
    const xml = generateGenericPlist({
      label: 'com.myelin.test',
      command: '/usr/bin/thing',
      args: [],
      envVars: { 'MYELIN_DIR': '/srv/A&B<x>"y"' },
      logPath: '/tmp/x.log',
    });
    assert.ok(xml.includes('<string>/srv/A&amp;B&lt;x&gt;&quot;y&quot;</string>'));
  });

  it('produces well-formed XML for an exec path with & and <', () => {
    const xml = generateGenericPlist({
      label: 'com.myelin.test',
      command: '/srv/A&B/<bin>/headroom',
      args: ['proxy'],
      logPath: '/tmp/x.log',
    });
    assert.ok(!/[^&]&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'every & is a valid XML entity');
    assert.ok(!/<string>[^<]*<(?!\/string>)/.test(xml.split('ProgramArguments')[1] ?? ''), 'no raw < inside string values');
  });
});

describe('I8 writeValidatedPlist (candidate -> lint -> atomic replace)', () => {
  it('writes a candidate, lints it, then atomically renames onto the target', () => {
    const calls = [];
    const path = '/srv/managed/Library/LaunchAgents/com.myelin.headroom.plist';
    const result = writeValidatedPlist({
      path,
      content: '<plist/>',
      writeFileSyncImpl: (p, c) => calls.push(['write', p, c]),
      execFileSyncImpl: (bin, args) => calls.push(['lint', bin, ...args]),
      renameSyncImpl: (from, to) => calls.push(['rename', from, to]),
      unlinkSyncImpl: (p) => calls.push(['unlink', p]),
    });
    assert.equal(result, path);
    // Order: write candidate, lint candidate, THEN rename candidate->final.
    assert.deepEqual(calls[0], ['write', `${path}.candidate`, '<plist/>']);
    assert.deepEqual(calls[1], ['lint', 'plutil', '-lint', `${path}.candidate`]);
    assert.deepEqual(calls[2], ['rename', `${path}.candidate`, path]);
    assert.ok(!calls.some(([op]) => op === 'unlink'), 'no unlink on the happy path');
  });

  it('does NOT replace the existing plist when plutil -lint fails, and removes the candidate', () => {
    const calls = [];
    const path = '/srv/managed/Library/LaunchAgents/com.myelin.headroom.plist';
    assert.throws(() => writeValidatedPlist({
      path,
      content: '<broken',
      writeFileSyncImpl: (p, c) => calls.push(['write', p, c]),
      execFileSyncImpl: () => { throw new Error('candidate.candidate: Invalid object'); },
      renameSyncImpl: (from, to) => calls.push(['rename', from, to]),
      unlinkSyncImpl: (p) => calls.push(['unlink', p]),
    }), /Refusing to install invalid plist/);
    assert.ok(!calls.some(([op]) => op === 'rename'), 'never renames a broken candidate over the healthy plist');
    assert.deepEqual(calls.at(-1), ['unlink', `${path}.candidate`], 'broken candidate is cleaned up');
  });
});

describe('generateLaunchdWatchdogScript — managed-root injection safety', () => {
  const EVIL_ROOT = "/srv/ev'il/$(touch pwned)/`whoami`/root";

  function watchdogScript() {
    return generateLaunchdWatchdogScript({
      home: '/home/alice',
      env: { MYELIN_DIR: EVIL_ROOT },
      headroomPort: 8787,
      mitmPort: 8888,
    });
  }

  it('single-quote-escapes the MYELIN_DIR-derived watchdog.log path in the generated bash', () => {
    const script = watchdogScript();
    const root = managedPaths({ home: '/home/alice', env: { MYELIN_DIR: EVIL_ROOT } }).root;
    const watchdogLog = joinManaged(root, 'watchdog.log');
    // The redirect target is the exact POSIX single-quoted literal — verbatim, never expanded.
    assert.ok(
      script.includes(`>> ${posixSingleQuote(watchdogLog)}`),
      `generated script should single-quote the watchdog log path:\n${script}`,
    );
  });

  it('renders $()/backtick/quote in the root inert (no double-quoted, unexpanded redirect)', () => {
    const script = watchdogScript();
    const redirect = script.split('\n').find((l) => l.includes('watchdog.log'));
    // Not the old double-quoted form that would command-substitute $(...) / backticks.
    assert.ok(!script.includes('>> "/srv'), redirect);
    assert.ok(!redirect.includes('>> "'), redirect);
    // The payload is wrapped in single quotes, so bash treats it as opaque data.
    assert.ok(redirect.includes(">> '/srv/ev'"), redirect);
    // An embedded single quote is closed/escaped/reopened, never left able to break out.
    assert.ok(redirect.includes(`'\\''`), redirect);
  });
});
