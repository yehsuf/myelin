import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotSerenaHooksConfig, writeCopilotSerenaHooks, mergeClaudeCodeSerenaHooks, writeClaudeCodeSerenaHooks } from '../src/cli/init.mjs';

describe('copilotSerenaHooksConfig', () => {
  it('produces valid JSON with version 1', () => {
    const parsed = JSON.parse(copilotSerenaHooksConfig());
    assert.equal(parsed.version, 1);
  });

  it('wires all three events to the myelin serena-guard bridge command', () => {
    const parsed = JSON.parse(copilotSerenaHooksConfig());
    assert.equal(parsed.hooks.PreToolUse[0].hooks[0].command, 'myelin serena-guard --event=preToolUse --target=copilot-cli');
    assert.equal(parsed.hooks.SessionStart[0].hooks[0].command, 'myelin serena-guard --event=sessionStart --target=copilot-cli');
    assert.equal(parsed.hooks.Stop[0].hooks[0].command, 'myelin serena-guard --event=stop --target=copilot-cli');
  });

  it('uses PascalCase event keys (Claude/VS-Code-compatible matcher mode)', () => {
    const parsed = JSON.parse(copilotSerenaHooksConfig());
    assert.ok('PreToolUse' in parsed.hooks);
    assert.ok(!('preToolUse' in parsed.hooks));
  });
});

describe('writeCopilotSerenaHooks', () => {
  it('does nothing when the repo has no .serena/project.yml (Serena not set up here)', () => {
    const root = mkdtempSync(join(tmpdir(), 'myelin-init-hooks-test-noserena-'));
    try {
      writeCopilotSerenaHooks(root);
      assert.equal(existsSync(join(root, '.github', 'hooks', 'copilot-serena-guard.json')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes .github/hooks/copilot-serena-guard.json when Serena is set up', () => {
    const root = mkdtempSync(join(tmpdir(), 'myelin-init-hooks-test-'));
    try {
      mkdirSync(join(root, '.serena'), { recursive: true });
      writeFileSync(join(root, '.serena', 'project.yml'), 'project_name: "x"\n');

      writeCopilotSerenaHooks(root);

      const hookFile = join(root, '.github', 'hooks', 'copilot-serena-guard.json');
      assert.ok(existsSync(hookFile));
      const parsed = JSON.parse(readFileSync(hookFile, 'utf8'));
      assert.equal(parsed.version, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('gitignores the generated hook file (machine-specific, must never be committed)', () => {
    const root = mkdtempSync(join(tmpdir(), 'myelin-init-hooks-test-'));
    try {
      mkdirSync(join(root, '.serena'), { recursive: true });
      writeFileSync(join(root, '.serena', 'project.yml'), 'project_name: "x"\n');

      writeCopilotSerenaHooks(root);

      const gitignoreContent = readFileSync(join(root, '.gitignore'), 'utf8');
      assert.ok(gitignoreContent.includes('.github/hooks/copilot-serena-guard.json'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('appends to an existing .gitignore without clobbering existing entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'myelin-init-hooks-test-'));
    try {
      mkdirSync(join(root, '.serena'), { recursive: true });
      writeFileSync(join(root, '.serena', 'project.yml'), 'project_name: "x"\n');
      writeFileSync(join(root, '.gitignore'), 'node_modules/\n');

      writeCopilotSerenaHooks(root);

      const gitignoreContent = readFileSync(join(root, '.gitignore'), 'utf8');
      assert.ok(gitignoreContent.includes('node_modules/'));
      assert.ok(gitignoreContent.includes('.github/hooks/copilot-serena-guard.json'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent - running twice does not duplicate the gitignore entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'myelin-init-hooks-test-'));
    try {
      mkdirSync(join(root, '.serena'), { recursive: true });
      writeFileSync(join(root, '.serena', 'project.yml'), 'project_name: "x"\n');

      writeCopilotSerenaHooks(root);
      writeCopilotSerenaHooks(root);

      const gitignoreContent = readFileSync(join(root, '.gitignore'), 'utf8');
      const occurrences = gitignoreContent.split('.github/hooks/copilot-serena-guard.json').length - 1;
      assert.equal(occurrences, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mergeClaudeCodeSerenaHooks', () => {
  it('adds our hooks to settings with no existing hooks key', () => {
    const merged = mergeClaudeCodeSerenaHooks({ permissions: { allow: ['Bash(ls)'] } });
    assert.deepEqual(merged.permissions, { allow: ['Bash(ls)'] }); // preserved untouched
    assert.ok(merged.hooks.PreToolUse[0].hooks[0].command.includes('--target=claude-code'));
    assert.ok(merged.hooks.SessionStart);
    assert.ok(merged.hooks.SessionEnd);
  });

  it('adds a separate auto-approve entry matching mcp__serena__* alongside the remind entry', () => {
    const merged = mergeClaudeCodeSerenaHooks({});
    assert.equal(merged.hooks.PreToolUse.length, 2);
    const remind = merged.hooks.PreToolUse.find((e) => e.matcher === '');
    const autoApprove = merged.hooks.PreToolUse.find((e) => e.matcher === 'mcp__serena__*');
    assert.ok(remind.hooks[0].command.includes('--event=preToolUse '));
    assert.ok(autoApprove.hooks[0].command.includes('--event=preToolUseAutoApprove'));
  });

  it('preserves unrelated pre-existing hook entries for the same event', () => {
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'some-other-tool --check' }] }],
      },
    };
    const merged = mergeClaudeCodeSerenaHooks(existing);
    const commands = merged.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    assert.ok(commands.includes('some-other-tool --check'));
    assert.ok(commands.some((c) => c.includes('myelin serena-guard')));
  });

  it('replaces (does not duplicate) prior myelin serena-guard entries on re-run', () => {
    const once = mergeClaudeCodeSerenaHooks({});
    const twice = mergeClaudeCodeSerenaHooks(once);
    const preToolUseCommands = twice.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    const myelinEntries = preToolUseCommands.filter((c) => c.includes('myelin serena-guard'));
    assert.equal(myelinEntries.length, 2); // remind (matcher "") + auto-approve (matcher mcp__serena__*)
  });

  it('handles a completely empty/undefined settings object', () => {
    assert.doesNotThrow(() => mergeClaudeCodeSerenaHooks(undefined));
    const merged = mergeClaudeCodeSerenaHooks(undefined);
    assert.ok(merged.hooks.PreToolUse);
  });
});

describe('writeClaudeCodeSerenaHooks', () => {
  it('does nothing when the repo has no .serena/project.yml', () => {
    const root = mkdtempSync(join(tmpdir(), 'myelin-init-hooks-test-noserena-'));
    try {
      writeClaudeCodeSerenaHooks(root);
      assert.equal(existsSync(join(root, '.claude', 'settings.local.json')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes .claude/settings.local.json when Serena is set up', () => {
    const root = mkdtempSync(join(tmpdir(), 'myelin-init-hooks-test-'));
    try {
      mkdirSync(join(root, '.serena'), { recursive: true });
      writeFileSync(join(root, '.serena', 'project.yml'), 'project_name: "x"\n');

      writeClaudeCodeSerenaHooks(root);

      const settingsPath = join(root, '.claude', 'settings.local.json');
      assert.ok(existsSync(settingsPath));
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
      assert.ok(parsed.hooks.PreToolUse);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves existing settings.local.json content (e.g. permissions.allow)', () => {
    const root = mkdtempSync(join(tmpdir(), 'myelin-init-hooks-test-'));
    try {
      mkdirSync(join(root, '.serena'), { recursive: true });
      writeFileSync(join(root, '.serena', 'project.yml'), 'project_name: "x"\n');
      mkdirSync(join(root, '.claude'), { recursive: true });
      writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['mcp__serena__find_symbol'] } }));

      writeClaudeCodeSerenaHooks(root);

      const parsed = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
      assert.deepEqual(parsed.permissions, { allow: ['mcp__serena__find_symbol'] });
      assert.ok(parsed.hooks.PreToolUse);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers gracefully from a malformed pre-existing settings.local.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'myelin-init-hooks-test-'));
    try {
      mkdirSync(join(root, '.serena'), { recursive: true });
      writeFileSync(join(root, '.serena', 'project.yml'), 'project_name: "x"\n');
      mkdirSync(join(root, '.claude'), { recursive: true });
      writeFileSync(join(root, '.claude', 'settings.local.json'), 'not valid json {{{');

      assert.doesNotThrow(() => writeClaudeCodeSerenaHooks(root));
      const parsed = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
      assert.ok(parsed.hooks.PreToolUse);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent - running twice does not duplicate hook entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'myelin-init-hooks-test-'));
    try {
      mkdirSync(join(root, '.serena'), { recursive: true });
      writeFileSync(join(root, '.serena', 'project.yml'), 'project_name: "x"\n');

      writeClaudeCodeSerenaHooks(root);
      writeClaudeCodeSerenaHooks(root);

      const parsed = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
      assert.equal(parsed.hooks.PreToolUse.length, 2); // remind (matcher "") + auto-approve (matcher mcp__serena__*), not duplicated
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
