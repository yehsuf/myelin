import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectRtkHookArtifacts, getRtkVersionStatus, parseRtkVersion, RTK_PINNED_VERSION, rtkInstallStrategy } from '../src/tools/rtk.mjs';
import { parseHeadroomVersion, headroomHealthUrl } from '../src/tools/headroom.mjs';

describe('RTK version parsing', () => {
  it('parses version from rtk --version output', () => {
    const v = parseRtkVersion('rtk 0.5.1');
    assert.equal(v, '0.5.1');
  });
  it('returns null for empty string', () => {
    assert.equal(parseRtkVersion(''), null);
  });
  it('returns null for unrecognised output', () => {
    assert.equal(parseRtkVersion('not a version'), null);
  });
  it('tracks whether the version matches the pinned RTK release', () => {
    const pinned = getRtkVersionStatus(`rtk ${RTK_PINNED_VERSION}`);
    const newer = getRtkVersionStatus('rtk 9.9.9');
    assert.equal(pinned.pinnedVersionMatches, true);
    assert.equal(newer.pinnedVersionMatches, false);
    assert.equal(newer.pinnedVersion, RTK_PINNED_VERSION);
  });
});

describe('RTK install strategy', () => {
  it('returns brew on darwin', () => {
    const s = rtkInstallStrategy('darwin');
    assert.equal(s[0].method, 'brew');
  });
  it('returns github_release first on linux', () => {
    const s = rtkInstallStrategy('linux');
    assert.equal(s[0].method, 'github_release');
  });
  it('returns github_release first on windows', () => {
    const s = rtkInstallStrategy('windows');
    assert.equal(s[0].method, 'github_release');
  });
  it('always includes cargo as last fallback', () => {
    const s = rtkInstallStrategy('darwin');
    assert.equal(s[s.length - 1].method, 'cargo');
  });
});

describe('Headroom version parsing', () => {
  it('parses version from headroom --version output', () => {
    const v = parseHeadroomVersion('headroom 1.2.3');
    assert.equal(v, '1.2.3');
  });
  it('parses version from headroom-ai style', () => {
    const v = parseHeadroomVersion('headroom-ai 1.0.0');
    assert.equal(v, '1.0.0');
  });
});

describe('headroomHealthUrl', () => {
  it('constructs URL from port', () => {
    assert.equal(headroomHealthUrl(8787), 'http://127.0.0.1:8787/health');
  });
  it('uses default 8787', () => {
    assert.equal(headroomHealthUrl(), 'http://127.0.0.1:8787/health');
  });
});

describe('detectRtkHookArtifacts', () => {
  const testRoot = join(process.cwd(), '.test-artifacts', `rtk-hooks-${process.pid}`);

  const makeHome = (name) => {
    const home = join(testRoot, name);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    return home;
  };

  after(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('detects Claude hook wiring', () => {
    const home = makeHome('claude-ok');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# Notes\n\n@RTK.md\n');
    writeFileSync(join(home, '.claude', 'RTK.md'), '# RTK\n');
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }],
      },
    }, null, 2));

    const state = detectRtkHookArtifacts({ home });
    assert.equal(state.claude.relevant, true);
    assert.equal(state.claude.ok, true);
    assert.equal(state.claude.detail, 'hook + RTK.md + @RTK.md present');
  });

  it('detects Copilot hook wiring', () => {
    const home = makeHome('copilot-ok');
    mkdirSync(join(home, '.copilot', 'hooks'), { recursive: true });
    writeFileSync(join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: {} }, null, 2));
    writeFileSync(join(home, '.copilot', 'copilot-instructions.md'), '<!-- rtk-instructions v2 -->\n# RTK\n');
    writeFileSync(join(home, '.copilot', 'hooks', 'rtk-rewrite.json'), JSON.stringify({
      version: 1,
      hooks: {
        PreToolUse: [{ type: 'command', command: 'rtk hook copilot' }],
        preToolUse: [{ type: 'command', bash: 'rtk hook copilot', powershell: 'rtk hook copilot' }],
      },
    }, null, 2));

    const state = detectRtkHookArtifacts({ home });
    assert.equal(state.copilot.relevant, true);
    assert.equal(state.copilot.ok, true);
    assert.equal(state.copilot.detail, 'hook file + copilot-instructions.md present');
  });

  it('reports missing RTK artifacts clearly', () => {
    const home = makeHome('claude-missing');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: {} }, null, 2));

    const state = detectRtkHookArtifacts({ home });
    assert.equal(state.claude.ok, false);
    assert.match(state.claude.detail, /settings\.json hook missing/);
    assert.match(state.claude.detail, /RTK\.md missing/);
    assert.match(state.claude.detail, /CLAUDE\.md missing @RTK\.md/);
  });

  it('reports unreadable hook files', () => {
    const home = makeHome('copilot-bad-json');
    mkdirSync(join(home, '.copilot', 'hooks'), { recursive: true });
    writeFileSync(join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: {} }, null, 2));
    writeFileSync(join(home, '.copilot', 'copilot-instructions.md'), '<!-- rtk-instructions v2 -->\n# RTK\n');
    writeFileSync(join(home, '.copilot', 'hooks', 'rtk-rewrite.json'), '{ not-json');

    const state = detectRtkHookArtifacts({ home });
    assert.equal(state.copilot.ok, false);
    assert.match(state.copilot.detail, /hook file unreadable/);
  });
});
