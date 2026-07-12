'use strict';
/**
 * Tests for compact-prepare.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '..', 'src', 'cli', 'compact-prepare.mjs');
// Windows absolute paths (C:\...) are invalid as ESM specifiers — use file:// URL
const SCRIPT_URL = pathToFileURL(SCRIPT).href;

// Isolated HOME under the repo (NOT /tmp) so tests are hermetic
const FIXTURE_ROOT = path.resolve(__dirname, '.compact-fixture');

const {
  buildHintSections,
  renderHint,
  parseCompactYaml,
  parseWorkspaceYaml,
  MAX_HINT,
} = await import(SCRIPT_URL);

// ─── helpers ───────────────────────────────────────────────────
function makeSession(sid, opts = {}) {
  const home = path.join(FIXTURE_ROOT, sid + '-home');
  const sessionDir = path.join(home, '.copilot', 'session-state', sid);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(path.join(sessionDir, 'files'), { recursive: true });

  const gitRoot = opts.gitRoot || path.join(home, 'work', 'repo');
  mkdirSync(gitRoot, { recursive: true });

  // Initialize a real git repo so `git log` etc. work
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['-C', gitRoot, 'init', '-q', '-b', 'main'], { env: gitEnv });
  writeFileSync(path.join(gitRoot, 'README.md'), '# hello\n');
  execFileSync('git', ['-C', gitRoot, 'add', '.'], { env: gitEnv });
  execFileSync('git', ['-C', gitRoot, 'commit', '-q', '-m', 'initial commit for tests'],
    { env: gitEnv });

  const ws = opts.workspaceYaml ?? [
    `name: ${opts.name || 'test-session'}`,
    `cwd: ${gitRoot}`,
    `git_root: ${gitRoot}`,
    `repository: ${opts.repository || 'org/repo'}`,
    'branch: main',
    '',
  ].join('\n');
  writeFileSync(path.join(sessionDir, 'workspace.yaml'), ws);

  if (opts.todos) {
    writeFileSync(path.join(sessionDir, 'files', 'todos.json'), JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      source: 'test',
      todos: opts.todos,
    }));
  }
  if (opts.planMd) {
    writeFileSync(path.join(sessionDir, 'plan.md'), opts.planMd);
  }
  if (opts.compactYaml) {
    writeFileSync(path.join(sessionDir, 'compact.yaml'), opts.compactYaml);
  }
  if (opts.globalDefaultsYaml) {
    writeFileSync(path.join(home, '.copilot', 'compact.defaults.yaml'), opts.globalDefaultsYaml);
  }
  if (opts.constitution) {
    mkdirSync(path.join(gitRoot, '.github'), { recursive: true });
    writeFileSync(path.join(gitRoot, '.github', 'copilot-instructions.md'), '# constitution\n');
  }
  if (opts.checkpoints) {
    mkdirSync(path.join(sessionDir, 'checkpoints'), { recursive: true });
    writeFileSync(path.join(sessionDir, 'checkpoints', 'index.md'), opts.checkpoints);
  }

  return { home, sid, sessionDir, gitRoot };
}

function runScript(sid, home, cwd, mode = 'prepare') {
  const env = {
    ...process.env,
    HOME: home,
    COPILOT_AGENT_SESSION_ID: sid,
  };
  return spawnSync(process.execPath, [SCRIPT, mode], {
    env, cwd, encoding: 'utf8',
  });
}

// ─── setup / teardown ──────────────────────────────────────────
before(() => {
  if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  mkdirSync(FIXTURE_ROOT, { recursive: true });
});

after(() => {
  if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

// ─── unit tests: parsers ───────────────────────────────────────
describe('parseWorkspaceYaml', () => {
  it('parses flat key:value pairs', () => {
    const y = 'name: foo\ncwd: /a/b\nbranch: main\n';
    const out = parseWorkspaceYaml(y);
    assert.equal(out.name, 'foo');
    assert.equal(out.cwd, '/a/b');
    assert.equal(out.branch, 'main');
  });

  it('strips quotes', () => {
    const out = parseWorkspaceYaml('name: "hello world"\n');
    assert.equal(out.name, 'hello world');
  });

  it('ignores comments and empty lines', () => {
    const out = parseWorkspaceYaml('# comment\n\nname: ok\n');
    assert.equal(out.name, 'ok');
  });
});

describe('parseCompactYaml', () => {
  it('parses repos, rules, next, notes', () => {
    const y = [
      'repos:',
      '  - path: ~/x',
      '    label: me/x',
      '  - path: /abs/y',
      'rules:',
      '  - do not push to main',
      '  - always run lint',
      'next: "implement feature Z"',
      'notes: "watch for flake"',
      '',
    ].join('\n');
    const out = parseCompactYaml(y);
    assert.equal(out.repos.length, 2);
    assert.equal(out.repos[0].path, '~/x');
    assert.equal(out.repos[0].label, 'me/x');
    assert.equal(out.repos[1].path, '/abs/y');
    assert.deepEqual(out.rules, ['do not push to main', 'always run lint']);
    assert.equal(out.next, 'implement feature Z');
    assert.equal(out.notes, 'watch for flake');
  });

  it('returns empty defaults on empty input', () => {
    const out = parseCompactYaml('');
    assert.deepEqual(out, { repos: [], rules: [], next: '', notes: '' });
  });
});

// ─── unit tests: rendering ─────────────────────────────────────
describe('buildHintSections / renderHint', () => {
  it('MAX_HINT matches the Copilot CLI customInstructions hard cap (4000)', () => {
    assert.equal(MAX_HINT, 4000,
      'MAX_HINT must be 4000 — Copilot CLI aborts /compact if customInstructions exceeds 4000 chars.');
  });

  it('produces sections and stays within MAX_HINT for typical input', () => {
    const data = {
      sid: 'abcdef1234567890',
      cwd: '/home/u/proj',
      repoLabel: 'org/proj',
      primaryRepo: {
        path: '/home/u/proj',
        sha7: 'deadbee',
        subj: 'add feature',
        branch: 'main',
        dirtyCount: 2,
        dirtyFiles: ['a.js', 'b.js'],
        extraWorktrees: [],
        recent: ['abc1234 fix bug', 'def5678 add test'],
      },
      todos: [
        { id: 'T1', title: 'do A', description: 'first', status: 'in_progress' },
        { id: 'T2', title: 'do B', description: '', status: 'pending' },
      ],
      planNext: 'ship it',
      globalRules: ['rule A'],
      sessionRules: ['rule B'],
      constitutionLoaded: false,
      compactNotes: '',
      checkpoints: ['cp1', 'cp2'],
    };
    const sections = buildHintSections(data);
    assert.ok(sections.header.startsWith('COMPACT_STATE_V1 sid=abcdef12'));
    assert.match(sections.repo, /REPO:\s+org\/proj/);
    assert.match(sections.dirty, /DIRTY:\s+2 files/);
    assert.match(sections.inProgress, /IN-PROGRESS:/);
    assert.match(sections.pending, /PENDING:/);
    assert.match(sections.next, /NEXT:\nship it/);
    assert.match(sections.rules, /RULES:/);
    assert.match(sections.checkpoints, /CHECKPOINTS:/);
    const hint = renderHint(sections);
    assert.ok(hint.length <= MAX_HINT, `hint length ${hint.length} > ${MAX_HINT}`);
  });

  it('suppresses RULES and adds CONSTITUTION when constitutionLoaded', () => {
    const sections = buildHintSections({
      sid: 'x', cwd: '/', globalRules: ['x'], sessionRules: ['y'],
      constitutionLoaded: true, todos: [],
    });
    assert.match(sections.rules, /^CONSTITUTION:/);
    assert.doesNotMatch(sections.rules, /RULES:/);
  });

  it('omits empty sections', () => {
    const sections = buildHintSections({
      sid: 'x', cwd: '/', todos: [], globalRules: [], sessionRules: [],
    });
    assert.equal(sections.inProgress, undefined);
    assert.equal(sections.pending, undefined);
    assert.equal(sections.blocked, undefined);
    assert.equal(sections.rules, undefined);
    assert.equal(sections.next, undefined);
  });

  it('truncates output to MAX_HINT with [TRUNCATED] marker', () => {
    // Feed renderHint a manually oversized section
    const huge = 'x'.repeat(MAX_HINT + 500);
    const sections = { header: 'HDR', pinned: 'PINNED: ' + huge };
    const hint = renderHint(sections);
    assert.ok(hint.length <= MAX_HINT);
    assert.ok(hint.endsWith('[TRUNCATED — see session files for full state]'), 'expected [TRUNCATED] marker');
  });

  it('strips non-ASCII characters', () => {
    const sections = buildHintSections({
      sid: 'x', cwd: '/', todos: [
        { id: 'T', title: 'hello 🎉 world', description: '', status: 'in_progress' },
      ],
    });
    const hint = renderHint(sections);
    assert.doesNotMatch(hint, /🎉/);
    assert.match(hint, /hello.*world/);
  });
});

// ─── integration: subprocess modes ─────────────────────────────
describe('CLI modes', () => {
  it('prepare mode produces dashboard + SESSION_STATE_BRIEF sentinels + agent instructions', () => {
    const { home, sid, gitRoot } = makeSession('sid-prepare', {
      todos: [{ id: 'T1', title: 'work on X', description: 'stuff', status: 'in_progress' }],
      planMd: '# plan\n\n## Next\n\nfinish X\n',
      globalDefaultsYaml: 'rules:\n  - global rule\n',
    });
    const r = runScript(sid, home, gitRoot, 'prepare');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /compact-prepare — session/);
    assert.match(r.stdout, /<<<SESSION_STATE_BRIEF>>>/);
    assert.match(r.stdout, /<<<END_SESSION_STATE_BRIEF>>>/);
    assert.match(r.stdout, /COMPACT_STATE_V1/);
    assert.match(r.stdout, /IN-PROGRESS:/);
    assert.match(r.stdout, /NEXT:\s*\nfinish X/);
    // Prepare mode must instruct the agent to compose the hint and enforce cap.
    assert.match(r.stdout, /agent, use this|Compose the actual|compose the actual/i);
    assert.match(r.stdout, /4000/);
    // New: instructs agent to call clipboard mode (not old sentinels)
    assert.match(r.stdout, /compact-prepare\.mjs clipboard/);
    assert.doesNotMatch(r.stdout, />>> COMPACT HINT >>>/);
    assert.doesNotMatch(r.stdout, /<<<COMPACT_HINT>>>/);
  });

  it('emit mode emits ONLY the hint, no sentinels, no dashboard', () => {
    const { home, sid, gitRoot } = makeSession('sid-emit', {
      todos: [{ id: 'T1', title: 'A', description: '', status: 'in_progress' }],
    });
    const r = runScript(sid, home, gitRoot, 'emit');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /<<<SESSION_STATE_BRIEF>>>/);
    assert.doesNotMatch(r.stdout, /<<<COMPACT_HINT>>>/);
    assert.doesNotMatch(r.stdout, /compact-prepare — session/);
    assert.match(r.stdout, /^COMPACT_STATE_V1/);
  });

  it('resume mode prints CONTEXT RESTORED banner, no sentinels', () => {
    const { home, sid, gitRoot } = makeSession('sid-resume', {
      todos: [{ id: 'T1', title: 'top task', description: 'important', status: 'in_progress' }],
    });
    const r = runScript(sid, home, gitRoot, 'resume');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /CONTEXT RESTORED/);
    assert.doesNotMatch(r.stdout, /<<<SESSION_STATE_BRIEF>>>/);
    assert.doesNotMatch(r.stdout, /<<<COMPACT_HINT>>>/);
    assert.doesNotMatch(r.stdout, /After \/compact completes/);
    assert.match(r.stdout, /Top priority:\s*top task — important/);
  });

  it('handles missing session.db and missing plan.md gracefully', () => {
    const { home, sid, gitRoot } = makeSession('sid-min', {});
    const r = runScript(sid, home, gitRoot, 'prepare');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Plan:\s+not found/);
    assert.match(r.stdout, /Todos:\s+0 in-progress/);
  });

  it('constitution present: RULES suppressed, CONSTITUTION line present', () => {
    const { home, sid, gitRoot } = makeSession('sid-const', {
      constitution: true,
      globalDefaultsYaml: 'rules:\n  - should not appear\n',
    });
    const r = runScript(sid, home, gitRoot, 'emit');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /CONSTITUTION:\s*see \.github\/copilot-instructions\.md/);
    assert.doesNotMatch(r.stdout, /RULES:/);
    assert.doesNotMatch(r.stdout, /should not appear/);
  });

  it('exits 2 when no session id and no matching cwd', () => {
    // Create a HOME with an empty session root and cwd that no session references
    const home = path.join(FIXTURE_ROOT, 'nomatch-home');
    mkdirSync(path.join(home, '.copilot', 'session-state'), { recursive: true });
    const stray = path.join(home, 'stray');
    mkdirSync(stray, { recursive: true });
    const env = { ...process.env, HOME: home };
    delete env.COPILOT_AGENT_SESSION_ID;
    const r = spawnSync(process.execPath, [SCRIPT, 'prepare'], {
      env, cwd: stray, encoding: 'utf8',
    });
    assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /cannot resolve session/);
  });

  it('uses COPILOT_AGENT_SESSION_ID when set explicitly', () => {
    const { home, sid, gitRoot } = makeSession('sid-explicit', {
      todos: [{ id: 'T1', title: 'explicit', description: '', status: 'in_progress' }],
    });
    // cwd is NOT the git root but the session id is provided explicitly
    const r = runScript(sid, home, home, 'emit');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /explicit/);
  });

  it('compact.yaml extra repos, rules, and notes are all present in hint', () => {
    // Create a second real git repo for the "extra" entry
    const extraHome = path.join(FIXTURE_ROOT, 'sid-cfg-home', 'extra-repo');
    mkdirSync(extraHome, { recursive: true });
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    execFileSync('git', ['-C', extraHome, 'init', '-q', '-b', 'main'], { env: gitEnv });
    writeFileSync(path.join(extraHome, 'x'), 'x');
    execFileSync('git', ['-C', extraHome, 'add', '.'], { env: gitEnv });
    execFileSync('git', ['-C', extraHome, 'commit', '-q', '-m', 'x'], { env: gitEnv });

    const compactYaml = [
      'repos:',
      `  - path: ${extraHome}`,
      '    label: me/extra',
      'rules:',
      '  - session-rule-1',
      'next: "do the thing"',
      'notes: "watch out"',
      '',
    ].join('\n');

    const { home, sid, gitRoot } = makeSession('sid-cfg', { compactYaml });
    const r = runScript(sid, home, gitRoot, 'emit');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /EXTRA-REPOS:\s*me\/extra@main@/);
    assert.match(r.stdout, /RULES:\n- session-rule-1/);
    assert.match(r.stdout, /NEXT:\ndo the thing/);
    assert.match(r.stdout, /PINNED:\s*watch out/);
  });

  it('hint output is always <= MAX_HINT even with large plan.md', () => {
    const bigNext = 'blah '.repeat(2000);
    const { home, sid, gitRoot } = makeSession('sid-big', {
      planMd: `# plan\n\n## Next\n\n${bigNext}\n`,
    });
    const r = runScript(sid, home, gitRoot, 'emit');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const hint = r.stdout.replace(/\n$/, '');
    assert.ok(hint.length <= MAX_HINT, `hint length ${hint.length} > ${MAX_HINT}`);
  });

  it('stale todos.json (>30 min) is suppressed', () => {
    const staleDate = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const { home, sid, sessionDir, gitRoot } = makeSession('sid-stale', {});
    writeFileSync(path.join(sessionDir, 'files', 'todos.json'), JSON.stringify({
      version: 1, generatedAt: staleDate, source: 'test',
      todos: [{ id: 'S1', title: 'stale-todo', description: '', status: 'in_progress' }],
    }));
    const r = runScript(sid, home, gitRoot, 'emit');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /stale-todo/, 'stale todos.json should be suppressed');
  });

  it('todos.json with no generatedAt is always served', () => {
    const { home, sid, sessionDir, gitRoot } = makeSession('sid-no-ts', {});
    writeFileSync(path.join(sessionDir, 'files', 'todos.json'), JSON.stringify({
      version: 1, source: 'test',
      todos: [{ id: 'N1', title: 'no-timestamp-todo', description: '', status: 'in_progress' }],
    }));
    const r = runScript(sid, home, gitRoot, 'emit');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /no-timestamp-todo/, 'todos.json without generatedAt should be served');
  });
});

// ─── clipboard mode ────────────────────────────────────────────
describe('clipboard mode', () => {
  it('exit 1 when no file argument provided', () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'clipboard'], {
      env: { ...process.env }, encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing file path/);
  });

  it('exit 1 when file does not exist', () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'clipboard', '/tmp/nonexistent-compact-hint-abc.txt'], {
      env: { ...process.env }, encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not found/);
  });

  it('prints /compact <hint> in output', () => {
    const { home, sid, sessionDir, gitRoot } = makeSession('sid-clip1', {});
    const hintFile = path.join(sessionDir, 'files', 'compact-hint.txt');
    writeFileSync(hintFile, 'SESSION SUMMARY: test\nNEXT: do stuff');
    const r = spawnSync(process.execPath, [SCRIPT, 'clipboard', hintFile], {
      env: { ...process.env, HOME: home, COPILOT_AGENT_SESSION_ID: sid },
      cwd: gitRoot, encoding: 'utf8',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /\/compact SESSION SUMMARY: test/);
    assert.match(r.stdout, /NEXT: do stuff/);
  });

  it('reports hint character count', () => {
    const { home, sid, sessionDir, gitRoot } = makeSession('sid-clip2', {});
    const hintFile = path.join(sessionDir, 'files', 'compact-hint.txt');
    const body = 'SUMMARY: x\nNEXT: y';
    writeFileSync(hintFile, body);
    const r = spawnSync(process.execPath, [SCRIPT, 'clipboard', hintFile], {
      env: { ...process.env, HOME: home, COPILOT_AGENT_SESSION_ID: sid },
      cwd: gitRoot, encoding: 'utf8',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`${body.length}/4000 chars`));
  });

  it('truncates hint > 4000 chars and warns', () => {
    const { home, sid, sessionDir, gitRoot } = makeSession('sid-clip3', {});
    const hintFile = path.join(sessionDir, 'files', 'compact-hint.txt');
    writeFileSync(hintFile, 'A'.repeat(4500));
    const r = spawnSync(process.execPath, [SCRIPT, 'clipboard', hintFile], {
      env: { ...process.env, HOME: home, COPILOT_AGENT_SESSION_ID: sid },
      cwd: gitRoot, encoding: 'utf8',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // warn printed to stderr
    assert.match(r.stderr, /truncated/i);
    // full command must not exceed /compact  + 4000 chars
    const cmdLine = r.stdout.split('\n').find(l => l.startsWith('/compact '));
    assert.ok(cmdLine, 'no /compact line in output');
    assert.ok(cmdLine.length <= '/compact '.length + 4000,
      `command line too long: ${cmdLine.length}`);
  });

  it('hint exactly at 4000 chars is not truncated', () => {
    const { home, sid, sessionDir, gitRoot } = makeSession('sid-clip4', {});
    const hintFile = path.join(sessionDir, 'files', 'compact-hint.txt');
    writeFileSync(hintFile, 'B'.repeat(4000));
    const r = spawnSync(process.execPath, [SCRIPT, 'clipboard', hintFile], {
      env: { ...process.env, HOME: home, COPILOT_AGENT_SESSION_ID: sid },
      cwd: gitRoot, encoding: 'utf8',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /truncated/i, 'should not truncate at exactly 4000');
  });
});
