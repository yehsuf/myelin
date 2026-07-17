/**
 * Regression test: `myelin --version` must report the installed release's real
 * version (from package.json), not a hardcoded string. The CLI previously
 * hardcoded .version('1.0.0'), so `myelin --version` always printed 1.0.0
 * regardless of which release was actually deployed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveCliVersion } from '../src/cli/cli-version.mjs';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
);

describe('resolveCliVersion', () => {
  it('returns the real version from package.json', () => {
    assert.equal(resolveCliVersion(), pkg.version);
    assert.match(resolveCliVersion(), /^\d+\.\d+\.\d+/);
  });

  it('reads <root>/package.json relative to the cli module location', () => {
    const seen = [];
    // Use a platform-absolute root so pathToFileURL round-trips without adding
    // a drive letter on Windows (which would desync the expected path).
    const root = process.platform === 'win32' ? 'C:\\fake\\root' : '/fake/root';
    const fakeMeta = pathToFileURL(join(root, 'src', 'cli', 'index.mjs')).href;
    const version = resolveCliVersion(fakeMeta, (p) => { seen.push(p); return JSON.stringify({ version: '9.9.9' }); });
    assert.equal(version, '9.9.9');
    assert.equal(seen[0], join(root, 'package.json'));
  });

  it('falls back to 0.0.0 when package.json cannot be read', () => {
    assert.equal(resolveCliVersion(import.meta.url, () => { throw new Error('ENOENT'); }), '0.0.0');
  });

  it('falls back to 0.0.0 when version field is missing/blank', () => {
    assert.equal(resolveCliVersion(import.meta.url, () => JSON.stringify({})), '0.0.0');
    assert.equal(resolveCliVersion(import.meta.url, () => JSON.stringify({ version: '' })), '0.0.0');
  });

  it('is a pure module importable without CLI side effects', () => {
    // Imported at the top of this file from src/cli/cli-version.mjs — a module
    // with no commander / no program.parse(), so importing it never parses argv.
    assert.ok(typeof resolveCliVersion === 'function');
  });
});
