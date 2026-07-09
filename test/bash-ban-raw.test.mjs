import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { shouldWarnOnRawShellSearchCommand } from '../src/hooks/bash-ban-raw.mjs';

describe('shouldWarnOnRawShellSearchCommand', () => {
  it('warns for direct raw tool usage', () => {
    assert.equal(shouldWarnOnRawShellSearchCommand('grep TODO src/install.mjs'), true);
    assert.equal(shouldWarnOnRawShellSearchCommand('  (cat package.json)'), true);
  });

  it('warns when a later chained command uses a raw tool', () => {
    assert.equal(shouldWarnOnRawShellSearchCommand('git status && tail -20 ~/.zshrc'), true);
  });

  it('warns when a raw tool follows a backgrounding & operator', () => {
    assert.equal(shouldWarnOnRawShellSearchCommand('echo hi & cat foo.txt'), true);
    assert.equal(shouldWarnOnRawShellSearchCommand('sleep 1 & grep pattern file.txt'), true);
  });

  it('does not warn for rtk subcommands even after a & operator', () => {
    assert.equal(shouldWarnOnRawShellSearchCommand('rtk grep foo & rtk read bar'), false);
  });

  it('warns for path-qualified raw tools too', () => {
    assert.equal(shouldWarnOnRawShellSearchCommand('/usr/bin/grep TODO src/install.mjs'), true);
  });

  it('supports passthrough wrappers that still execute a raw tool', () => {
    assert.equal(shouldWarnOnRawShellSearchCommand('env FOO=1 grep TODO src/install.mjs'), true);
    assert.equal(shouldWarnOnRawShellSearchCommand('command find src -name "*.mjs"'), true);
  });

  it('does not warn for rtk subcommands', () => {
    assert.equal(shouldWarnOnRawShellSearchCommand('rtk grep TODO src/install.mjs'), false);
    assert.equal(shouldWarnOnRawShellSearchCommand('(rtk find src -name "*.mjs")'), false);
    assert.equal(shouldWarnOnRawShellSearchCommand('/opt/homebrew/bin/rtk grep TODO src/install.mjs'), false);
  });

  it('does not warn for raw tool names used as plain arguments', () => {
    assert.equal(shouldWarnOnRawShellSearchCommand('echo grep tail head'), false);
  });
});
