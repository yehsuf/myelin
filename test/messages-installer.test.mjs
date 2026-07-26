import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installMessagesWatcher, CHECK_MESSAGES_SH, MESSAGES_WATCHER_LABEL, MESSAGES_WATCHER_UNIT } from '../src/messages/installer.mjs';

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

  it('returns plan without writing in dryRun mode', () => {
    const result = installMessagesWatcher({
      home: tmpHome,
      os: 'mac',
      nodePath: '/usr/local/bin/node',
      dryRun: true,
    });
    assert.ok(result.plistPath, 'returns plistPath');
    assert.ok(result.plist, 'returns plist content');
    // Nothing written
    assert.ok(!existsSync(join(tmpHome, '.myelin', 'messages', 'watcher.mjs')),
      'does not write watcher.mjs in dryRun');
  });

  it('generates correct launchd plist for macOS', () => {
    const execCalls = [];
    installMessagesWatcher({
      home: tmpHome,
      os: 'mac',
      nodePath: '/usr/local/bin/node',
      ok: () => {},
      warn: () => {},
      execSyncImpl: (cmd) => { execCalls.push(cmd); },
      existsSyncImpl: () => false,
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
      os: 'mac',
      nodePath: '/usr/local/bin/node',
      ok: () => {},
      warn: () => {},
      execSyncImpl: () => {},
      existsSyncImpl: () => false,
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
      os: 'mac',
      nodePath: '/usr/local/bin/node',
      ok: () => {},
      warn: () => {},
      execSyncImpl: () => {},
      existsSyncImpl: () => false,
    });

    const scriptPath = join(tmpHome, '.myelin', 'messages', 'check-messages.sh');
    assert.ok(existsSync(scriptPath), 'check-messages.sh written');
    const script = readFileSync(scriptPath, 'utf8');
    assert.ok(script.includes('.new-message'), 'script uses .new-message marker');
    assert.ok(script.includes('.watcher-pid'), 'script checks watcher pid');
    assert.ok(script.includes('.last-mtime'), 'script uses .last-mtime for comparison');
    assert.ok(script.includes('kill -0'), 'script checks if watcher is alive');
  });

  it('generates correct systemd unit for Linux', () => {
    installMessagesWatcher({
      home: tmpHome,
      os: 'linux',
      nodePath: '/usr/bin/node',
      ok: () => {},
      warn: () => {},
      execSyncImpl: () => {},
      existsSyncImpl: () => false,
    });

    const unitPath = join(tmpHome, '.config', 'systemd', 'user', MESSAGES_WATCHER_UNIT);
    assert.ok(existsSync(unitPath), 'systemd unit written');
    const unit = readFileSync(unitPath, 'utf8');
    assert.ok(unit.includes('[Service]'), 'has Service section');
    assert.ok(unit.includes('/usr/bin/node'), 'node path in unit');
    assert.ok(unit.includes('watcher.mjs'), 'watcher script in unit');
    assert.ok(unit.includes('Restart=always'), 'has Restart=always');
  });

  it('calls ok callback on success (macOS)', () => {
    const messages = [];
    installMessagesWatcher({
      home: tmpHome,
      os: 'mac',
      nodePath: '/usr/local/bin/node',
      ok: (m) => messages.push(m),
      warn: () => {},
      execSyncImpl: () => {},
      existsSyncImpl: () => false,
    });
    assert.ok(messages.some(m => m.includes('messages watcher')), 'ok called with watcher message');
  });

  it('calls warn callback when launchctl bootstrap fails (macOS)', () => {
    const warnings = [];
    installMessagesWatcher({
      home: tmpHome,
      os: 'mac',
      nodePath: '/usr/local/bin/node',
      ok: () => {},
      warn: (m) => warnings.push(m),
      execSyncImpl: (cmd) => {
        if (cmd.includes('bootstrap')) throw new Error('no permission');
      },
      existsSyncImpl: () => false,
    });
    assert.ok(warnings.some(w => w.includes('messages watcher')), 'warn called on bootstrap failure');
  });

  it('is a no-op on Windows (scripts still written, no daemon registered)', () => {
    const okMessages = [];
    installMessagesWatcher({
      home: tmpHome,
      os: 'windows',
      nodePath: 'node',
      ok: (m) => okMessages.push(m),
      warn: () => {},
      execSyncImpl: () => {},
      existsSyncImpl: () => false,
    });
    // check-messages.sh and watcher.mjs still written
    assert.ok(existsSync(join(tmpHome, '.myelin', 'messages', 'check-messages.sh')));
    assert.ok(existsSync(join(tmpHome, '.myelin', 'messages', 'watcher.mjs')));
    // No plist or unit file
    assert.ok(!existsSync(join(tmpHome, 'Library', 'LaunchAgents', `${MESSAGES_WATCHER_LABEL}.plist`)));
  });

  it('exported CHECK_MESSAGES_SH contains required elements', () => {
    assert.ok(CHECK_MESSAGES_SH.includes('#!/usr/bin/env bash'), 'has shebang');
    assert.ok(CHECK_MESSAGES_SH.includes('messages.md'), 'references messages.md');
    assert.ok(CHECK_MESSAGES_SH.includes('.new-message'), 'references marker');
    assert.ok(CHECK_MESSAGES_SH.includes('.watcher-pid'), 'references pid file');
    assert.ok(CHECK_MESSAGES_SH.includes('kill -0'), 'checks liveness');
  });
});
