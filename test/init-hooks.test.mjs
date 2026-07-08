import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotSerenaHooksConfig, writeCopilotSerenaHooks } from '../src/cli/init.mjs';

describe('copilotSerenaHooksConfig', () => {
  it('produces valid JSON with version 1', () => {
    const parsed = JSON.parse(copilotSerenaHooksConfig());
    assert.equal(parsed.version, 1);
  });

  it('wires all three events to the myelin serena-guard bridge command', () => {
    const parsed = JSON.parse(copilotSerenaHooksConfig());
    assert.equal(parsed.hooks.PreToolUse[0].hooks[0].command, 'myelin serena-guard --event=preToolUse');
    assert.equal(parsed.hooks.SessionStart[0].hooks[0].command, 'myelin serena-guard --event=sessionStart');
    assert.equal(parsed.hooks.Stop[0].hooks[0].command, 'myelin serena-guard --event=stop');
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
