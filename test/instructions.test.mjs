import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG } from '../src/config/schema.mjs';
import { INSTRUCTION_SNIPPETS, renderManagedBlock } from '../src/config/instruction-snippets.mjs';
import { writeManagedSection, MANAGED_SECTION_START, MANAGED_SECTION_END } from '../src/config/managed-section.mjs';

describe('instruction-snippets', () => {
  it('renders all default-enabled snippets for global/claude scope', () => {
    const out = renderManagedBlock({ target: 'global', provider: 'claude', cfg: DEFAULT_CONFIG });
    assert.match(out, /## Token efficiency/);
    assert.match(out, /## Efficient Navigation/);
    assert.match(out, /## Output Protocol/);
  });

  it('renders all default-enabled snippets for repo/copilot scope', () => {
    const out = renderManagedBlock({ target: 'repo', provider: 'copilot', cfg: DEFAULT_CONFIG });
    assert.match(out, /## Token efficiency/);
  });

  it('places "top" snippets before "end" snippets', () => {
    const out = renderManagedBlock({ target: 'global', provider: 'claude', cfg: DEFAULT_CONFIG });
    assert.ok(out.indexOf('## Token efficiency') < out.indexOf('## Output Protocol'),
      'token_efficiency (top) must precede caveman_output_protocol (end)');
  });

  it('excludes a snippet when its config gate is explicitly false', () => {
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    cfg.output_style.token_efficiency = false;
    const out = renderManagedBlock({ target: 'global', provider: 'claude', cfg });
    assert.doesNotMatch(out, /## Token efficiency/);
  });

  it('every registry snippet declares scope including "repo" (AGENTS.md target)', () => {
    for (const s of INSTRUCTION_SNIPPETS) {
      assert.ok(s.scope.includes('repo'), `${s.id} does not target repo scope`);
    }
  });

  it('every snippet has scope, providers, models, placement, and a non-empty render()', () => {
    for (const s of INSTRUCTION_SNIPPETS) {
      assert.ok(Array.isArray(s.scope) && s.scope.length > 0, `${s.id} missing scope`);
      assert.ok(Array.isArray(s.providers) && s.providers.length > 0, `${s.id} missing providers`);
      assert.ok(Array.isArray(s.models) && s.models.length > 0, `${s.id} missing models`);
      assert.ok(s.placement === 'top' || s.placement === 'end', `${s.id} invalid placement`);
      assert.ok(typeof s.render() === 'string' && s.render().length > 0, `${s.id} empty render()`);
    }
  });
});

describe('managed-section', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'myelin-managed-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('creates a new file with HTML-comment markers (Markdown-safe, not a heading)', () => {
    const file = join(dir, 'AGENTS.md');
    writeManagedSection(file, '\nhello');
    const content = readFileSync(file, 'utf8');
    assert.ok(content.includes(MANAGED_SECTION_START));
    assert.ok(content.includes(MANAGED_SECTION_END));
    assert.match(MANAGED_SECTION_START, /^<!--/, 'marker must be an HTML comment, not a Markdown heading');
  });

  it('replaces only the managed section on re-run, preserving surrounding content', () => {
    const file = join(dir, 'PRESERVE.md');
    writeFileSync(file, '# My own notes\nkeep me\n');
    writeManagedSection(file, '\nfirst');
    writeManagedSection(file, '\nsecond');
    const content = readFileSync(file, 'utf8');
    assert.match(content, /keep me/);
    assert.match(content, /second/);
    assert.doesNotMatch(content, /first/);
  });

  it('is idempotent — re-running does not duplicate the block', () => {
    const file = join(dir, 'IDEMPOTENT.md');
    writeManagedSection(file, '\nX');
    writeManagedSection(file, '\nX');
    const content = readFileSync(file, 'utf8');
    assert.equal(content.split(MANAGED_SECTION_START).length - 1, 1);
  });

  it('migrates legacy shell-style `#` markers to HTML-comment markers in place', () => {
    const file = join(dir, 'LEGACY.md');
    writeFileSync(file, '# >>> myelin managed >>>\nold\n# <<< myelin managed <<<\n');
    writeManagedSection(file, '\nnew');
    const content = readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /old/);
    assert.match(content, /new/);
    assert.equal(content.split(MANAGED_SECTION_START).length - 1, 1);
  });

  it('creates a timestamped backup when overwriting an existing file', () => {
    const file = join(dir, 'BACKUP.md');
    writeFileSync(file, 'v1');
    writeManagedSection(file, '\nv2');
    const backups = readdirSync(dir).filter(f => f.startsWith('BACKUP.md.bak.'));
    assert.ok(backups.length >= 1, 'expected at least one .bak.<timestamp> file');
  });
});
