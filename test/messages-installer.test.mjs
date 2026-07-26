import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installMessagesWatcher, CHECK_MESSAGES_SH, MESSAGES_WATCHER_LABEL, MESSAGES_WATCHER_UNIT } from '../src/messages/installer.mjs';

const noop = () => {};
const noopBootstrap = noop; // injectable bootReplaceLaunchdImpl — never calls real launchd

describe('installMessagesWatcher', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `myelin-test-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpHome, '.myelin', 'messages'), { recursive: true });
    mkdirSync(join(tmpHome, 'Library', 'LaunchAgents'), { recursive: true });
    mkdirSync(join(tmpHome, '.config', 'systemd', 'user'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns plan without writing in dryRun mode (darwin)', () => {
    const result = installMessagesWatcher({
      home: tmpHome,
      os: 'darwin',
      nodePath: '/usr/local/bin/node',
      dryRun: true,
    });
    assert.ok(result.plistPath, 'returns plistPath');
    assert.ok(result.plist, 'returns plist content');
    assert.ok(!existsSync(join(tmpHome, '.myelin', 'messages', 'watcher.mjs')),
      'does not write watcher.mjs in dryRun');
  });

  it('also accepts legacy os="mac" spelling', () => {
    const result = installMessagesWatcher({
      home: tmpHome,
      os: 'mac',
      nodePath: '/usr/local/bin/node',
      dryRun: true,
    });
    assert.ok(result.plistPath, 'returns plistPath for legacy mac spelling');
  });

  it('generates correct launchd plist for macOS (darwin)', () => {
    installMessagesWatcher({
      home: tmpHome,
      os: 'darwin',
      nodePath: '/usr/local/bin/node',
      ok: noop, warn: noop,
      execSyncImpl: noop,
      bootReplaceLaunchdImpl: noopBootstrap,
    });

    const plistPath = join(tmpHome, 'Library', 'LaunchAgents', `${MESSAGES_WATCHER_LABEL}.plist`);
    assert.ok(existsSync(plistPath), 'plist file written');
    const plist = readFileSync(plistPath, 'utf8');
    assert.ok(plist.includes(MESSAGES_WATCHER_LABEL), 'label in plist');
    assert.ok(plist.includes('/usr/local/bin/node'), 'node path in plist');
    assert.ok(plist.includes('watcher.mjs'), 'watcher script in plist');
    assert.ok(plist.includes('<key>KeepAlive</key>'), 'KeepAlive in plist');
  });

  it('deploys watcher.mjs to messages dir on macOS', () => {
    installMessagesWatcher({
      home: tmpHome,
      os: 'darwin',
      nodePath: '/usr/local/bin/node',
      ok: noop, warn: noop,
      execSyncImpl: noop,
      bootReplaceLaunchdImpl: noopBootstrap,
    });

    const watcherPath = join(tmpHome, '.myelin', 'messages', 'watcher.mjs');
    assert.ok(existsSync(watcherPath), 'watcher.mjs deployed');
    const content = readFileSync(watcherPath, 'utf8');
    assert.ok(content.includes('fs.watch'), 'watcher uses fs.watch');
    assert.ok(content.includes('.new-message'), 'watcher writes marker');
    assert.ok(content.includes('.watcher-pid'), 'watcher writes pid file');
  });

  it('generates check-messages.sh with marker approach', () => {
    installMessagesWatcher({
      home: tmpHome,
      os: 'darwin',
      nodePath: '/usr/local/bin/node',
      ok: noop, warn: noop,
      execSyncImpl: noop,
      bootReplaceLaunchdImpl: noopBootstrap,
    });

    const scriptPath = join(tmpHome, '.myelin', 'messages', 'check-messages.sh');
    assert.ok(existsSync(scriptPath), 'check-messages.sh written');
    const script = readFileSync(scriptPath, 'utf8');
    assert.ok(script.includes('.new-message'), 'uses .new-message marker');
    assert.ok(script.includes('.watcher-pid'), 'checks watcher pid');
    assert.ok(script.includes('.last-mtime'), 'uses .last-mtime for comparison');
    assert.ok(script.includes('kill -0'), 'checks if watcher is alive');
  });

  it('generates correct systemd unit for Linux with quoted ExecStart', () => {
    installMessagesWatcher({
      home: tmpHome,
      os: 'linux',
      nodePath: '/usr/bin/node',
      ok: noop, warn: noop,
      execSyncImpl: noop,
    });

    const unitPath = join(tmpHome, '.config', 'systemd', 'user', MESSAGES_WATCHER_UNIT);
    assert.ok(existsSync(unitPath), 'systemd unit written');
    const unit = readFileSync(unitPath, 'utf8');
    assert.ok(unit.includes('[Service]'), 'has Service section');
    // ExecStart must quote paths to handle spaces
    assert.ok(unit.includes('"'), 'ExecStart paths are quoted');
    assert.ok(unit.includes('/usr/bin/node'), 'node path in unit');
    assert.ok(unit.includes('watcher.mjs'), 'watcher script in unit');
    assert.ok(unit.includes('Restart=always'), 'has Restart=always');
  });

  it('calls bootReplaceLaunchdImpl instead of raw launchctl on macOS', () => {
    let bootCalled = false;
    installMessagesWatcher({
      home: tmpHome,
      os: 'darwin',
      nodePath: '/usr/local/bin/node',
      ok: noop, warn: noop,
      execSyncImpl: noop,
      bootReplaceLaunchdImpl: (opts) => { bootCalled = true; return true; },
    });
    assert.ok(bootCalled, 'bootReplaceLaunchdImpl was called');
  });

  it('calls warn callback when bootReplaceLaunchdImpl throws', () => {
    const warnings = [];
    installMessagesWatcher({
      home: tmpHome,
      os: 'darwin',
      nodePath: '/usr/local/bin/node',
      ok: noop,
      warn: (m) => warnings.push(m),
      execSyncImpl: noop,
      bootReplaceLaunchdImpl: () => { throw new Error('launchctl failed'); },
    });
    assert.ok(warnings.some(w => w.includes('messages watcher')), 'warn called on failure');
  });

  it('is a no-op daemon on Windows (scripts still written, no plist/unit registered)', () => {
    const okMessages = [];
    installMessagesWatcher({
      home: tmpHome,
      os: 'windows',
      nodePath: 'node',
      ok: (m) => okMessages.push(m),
      warn: noop,
      execSyncImpl: noop,
    });
    assert.ok(existsSync(join(tmpHome, '.myelin', 'messages', 'check-messages.sh')));
    assert.ok(existsSync(join(tmpHome, '.myelin', 'messages', 'watcher.mjs')));
    assert.ok(!existsSync(join(tmpHome, 'Library', 'LaunchAgents', `${MESSAGES_WATCHER_LABEL}.plist`)));
  });

  it('exported CHECK_MESSAGES_SH contains required elements', () => {
    assert.ok(CHECK_MESSAGES_SH.includes('#!/usr/bin/env bash'), 'has shebang');
    assert.ok(CHECK_MESSAGES_SH.includes('messages.md'), 'references messages.md');
    assert.ok(CHECK_MESSAGES_SH.includes('.new-message'), 'references marker');
    assert.ok(CHECK_MESSAGES_SH.includes('.watcher-pid'), 'references pid file');
    assert.ok(CHECK_MESSAGES_SH.includes('kill -0'), 'checks liveness');
    // Fallback mtime must work on both macOS and Linux
    assert.ok(CHECK_MESSAGES_SH.includes('stat -f %m'), 'macOS stat fallback');
    assert.ok(CHECK_MESSAGES_SH.includes('stat -c %Y'), 'Linux stat fallback');
  });
});
