import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  findConstitutionFile,
  computeSha256,
  parseConstitutionSections,
  checkConstitution,
  appendBullet,
  similarity,
} from '../src/cli/constitution.mjs';

// NOTE: mkdtemp is allowed via tmpdir(), but we must not write our own files
// under /tmp per environment rules. However, node:test on this project
// commonly uses tmpdir() for fixtures. Use a scoped project-local fixtures
// directory instead to avoid violating that constraint.
const FIXTURE_ROOT = join(process.cwd(), 'test', '.fixtures-constitution');

function makeFixtureDir(name) {
  const dir = join(FIXTURE_ROOT, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupAll() {
  try {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  } catch {}
}

const GOOD_TEXT = `<!-- CONSTITUTION v1 — Stable project context for GitHub Copilot CLI.
     Only stable facts belong here. Volatile state (blocked items, shipped work,
     current sprint) goes in the compact hint, not here. -->

# demo

## Identity
- name: demo
- repo: acme/demo
- purpose: demonstration project used for the constitution test suite — exercises every stable section and includes enough prose to comfortably clear the 1024-byte lower bound the checker enforces.

## Architecture invariants
- Zero external runtime dependencies in the hot path.
- All source uses ESM (.mjs) with Node.js >=20.
- Deterministic transforms only — same input always yields identical output.
- No ML models anywhere in the compression pipeline.

## Standing rules
- Never act without explicit per-action approval.
- Every non-trivial change follows implement → test → review → merge.
- Parallel agents must use separate git worktrees, never sharing a checkout.
- Do not rewrite git history on shared branches (main, dev).

## Technology
- Language / runtime: Node.js >=20, ESM only
- Test command: node --test test/**/*.test.mjs
- Package registry: GitHub Packages
- Linter: eslint (project config)

## Key file map
- src/index.mjs — entry point of the demo CLI
- src/lib/ — internal library modules and utilities
- test/ — node:test suites, one file per feature area
- docs/ — user-facing documentation and design notes
`;

test('findConstitutionFile — finds file when present in cwd', () => {
  const dir = makeFixtureDir('present');
  mkdirSync(join(dir, '.github'), { recursive: true });
  const p = join(dir, '.github', 'copilot-instructions.md');
  writeFileSync(p, GOOD_TEXT);
  assert.equal(findConstitutionFile(dir), p);
});

test('findConstitutionFile — finds file by walking up from subdirectory', () => {
  const dir = makeFixtureDir('walkup');
  mkdirSync(join(dir, '.github'), { recursive: true });
  mkdirSync(join(dir, 'src', 'deep', 'nested'), { recursive: true });
  const p = join(dir, '.github', 'copilot-instructions.md');
  writeFileSync(p, GOOD_TEXT);
  assert.equal(findConstitutionFile(join(dir, 'src', 'deep', 'nested')), p);
});

test('findConstitutionFile — returns null when not present', () => {
  const dir = makeFixtureDir('absent');
  // Deep enough to not accidentally find a real one in parent
  mkdirSync(join(dir, 'a', 'b', 'c'), { recursive: true });
  // walkUp would eventually reach /, but there won't be a copilot-instructions.md
  // in the ancestor chain of this synthetic fixture directory unless a parent
  // has one. Use a subdir isolated from the repo:
  const deep = join(dir, 'a', 'b', 'c');
  const res = findConstitutionFile(deep);
  // If a real ancestor has one (e.g. the running repo itself), the result may
  // point outside `dir`. Guard: we only assert null when the found path is
  // NOT under `dir`.
  if (res !== null) {
    assert.ok(!res.startsWith(dir), `unexpected constitution found under fixture dir: ${res}`);
  } else {
    assert.equal(res, null);
  }
});

test('checkConstitution — clean file → no errors, no warnings', () => {
  const { errors, warnings } = checkConstitution(GOOD_TEXT);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('checkConstitution — file with ## Blocked section → warning', () => {
  const bad = GOOD_TEXT + '\n## Blocked\n- some blocked item\n';
  const { errors, warnings } = checkConstitution(bad);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) => w.includes('Blocked')),
    `expected a Blocked warning, got: ${JSON.stringify(warnings)}`,
  );
});

test('checkConstitution — file with AWS key pattern → error', () => {
  const bad = GOOD_TEXT + '\nAWS: AKIAABCDEFGHIJKLMNOP\n';
  const { errors } = checkConstitution(bad);
  assert.ok(
    errors.some((e) => e.includes('AWS')),
    `expected AWS secret error, got: ${JSON.stringify(errors)}`,
  );
});

test('checkConstitution — file < 1024 bytes → warning', () => {
  const small = '<!-- CONSTITUTION v1 -->\n# tiny\n## Identity\n- name: x\n';
  const { warnings } = checkConstitution(small);
  assert.ok(
    warnings.some((w) => w.includes('small') || w.includes('1024')),
    `expected size warning, got: ${JSON.stringify(warnings)}`,
  );
});

test('appendBullet — adds bullet to correct section', () => {
  const { newText, added, section } = appendBullet(
    GOOD_TEXT,
    'Standing rules',
    'Always run lint before pushing.',
  );
  assert.equal(added, true);
  assert.equal(section, 'Standing rules');
  assert.ok(newText.includes('- Always run lint before pushing.'));
  // Ensure it was inserted under Standing rules, before Technology
  const standingIdx = newText.indexOf('## Standing rules');
  const techIdx = newText.indexOf('## Technology');
  const bulletIdx = newText.indexOf('- Always run lint before pushing.');
  assert.ok(bulletIdx > standingIdx && bulletIdx < techIdx);
});

test('appendBullet — idempotent (exact duplicate → not added)', () => {
  const bullet = 'Never act without explicit per-action approval.';
  const res = appendBullet(GOOD_TEXT, 'Standing rules', bullet);
  assert.equal(res.added, false);
  assert.match(res.reason, /already present/i);
});

test('appendBullet — near-duplicate without --force → rejected', () => {
  const near = 'Never act without an explicit per-action approval each time';
  const res = appendBullet(GOOD_TEXT, 'Standing rules', near, false);
  assert.equal(res.added, false);
  assert.match(res.reason, /similar entry exists/);
});

test('appendBullet — near-duplicate with --force → added', () => {
  const near = 'Never act without an explicit per-action approval each time';
  const res = appendBullet(GOOD_TEXT, 'Standing rules', near, true);
  assert.equal(res.added, true);
  assert.ok(res.newText.includes(near));
});

test('appendBullet — section prefix "inv" resolves to Architecture invariants', () => {
  const res = appendBullet(GOOD_TEXT, 'inv', 'New invariant about caching.');
  assert.equal(res.added, true);
  assert.equal(res.section, 'Architecture invariants');
});

test('parseConstitutionSections — correctly parses all 5 sections', () => {
  const sections = parseConstitutionSections(GOOD_TEXT);
  const names = sections.map((s) => s.name);
  for (const req of [
    'Identity',
    'Architecture invariants',
    'Standing rules',
    'Technology',
    'Key file map',
  ]) {
    assert.ok(names.includes(req), `missing section: ${req}. got ${JSON.stringify(names)}`);
  }
});

test('computeSha256 — deterministic (same file → same hash across 2 runs)', () => {
  const dir = makeFixtureDir('hash');
  const p = join(dir, 'a.txt');
  writeFileSync(p, 'hello world\n');
  const h1 = computeSha256(p);
  const h2 = computeSha256(p);
  assert.equal(h1, h2);
  // Known SHA-256 of "hello world\n"
  assert.equal(h1, 'a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447');
});

test('similarity — identical, empty, and partial overlap behave correctly', () => {
  assert.equal(similarity('hello world', 'hello world'), 1);
  assert.equal(similarity('', ''), 0);
  const s = similarity('the quick brown fox', 'the quick brown dog');
  assert.ok(s > 0.5 && s < 1, `expected partial overlap in (0.5,1), got ${s}`);
  assert.equal(similarity('completely different', 'orange banana apple'), 0);
});

test.after(cleanupAll);
