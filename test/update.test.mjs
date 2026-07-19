import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUpdateCheckReport } from '../src/cli/update.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const cli = join(root, 'src', 'cli', 'index.mjs');
const temporaryHomes = [];

function makeHome() {
  const home = fs.mkdtempSync(join(root, '.test-update-cli-home-'));
  temporaryHomes.push(home);
  return home;
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function runUpdateCli(...args) {
  const home = makeHome();
  return spawnSync(process.execPath, [cli, 'update', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
    },
  });
}

describe('update CLI contract', () => {
  it('rejects removed --self with update guidance and exit 2', () => {
    const result = runUpdateCli('--self');

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--self was removed.*myelin update/u);
  });

  it('rejects removed --force with update guidance and exit 2', () => {
    const result = runUpdateCli('--force');

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--force was removed.*myelin update/u);
  });

  it('rejects an unsupported release channel with exit 2', () => {
    const result = runUpdateCli('--channel', 'nightly');

    assert.equal(result.status, 2);
    assert.match(result.stderr, /invalid update channel.*stable.*main/iu);
  });

  it('formats a read-only update report for terminal output', () => {
    const output = formatUpdateCheckReport({
      plan: {
        channel: 'stable',
        releaseSnapshot: { current: '1.0.0' },
        target: { version: '1.1.0' },
        backend: 'headroom-lite',
        components: [{ name: 'headroomLite', current: '0.31.0' }],
      },
      config: { migrationRequired: false },
      lock: { held: false },
      journal: null,
    });

    assert.match(output, /active release: 1\.0\.0/u);
    assert.match(output, /target release: 1\.1\.0/u);
    assert.match(output, /headroomLite@0\.31\.0/u);
  });
});

describe('runToolUpdates — headroom upgrade guard (WIN-LITELLM-001)', () => {
  it('does not run headroom uv pip install when backend is headroom-lite', async () => {
    const { runToolUpdates } = await import('../src/cli/update.mjs');
    const upgradeCalls = [];
    await runToolUpdates(
      { check: false },
      {
        os: 'linux',
        log: () => {},
        warn: () => {},
        loadConfigFn: async () => ({ compression: { backend: 'headroom-lite' } }),
        detectAllFn: async () => ({
          node: { installed: true, version: 'v20.0.0' },
          uv: { installed: false, version: null },
          headroom: { installed: true, version: '0.31.0' },
          rtk: { installed: false, version: null },
          serena: { installed: false, version: null },
          semble: { installed: false, version: null },
          astgrep: { installed: false, version: null },
          codegraph: { installed: false, version: null },
        }),
        execSyncFn: (cmd) => { upgradeCalls.push({ cmd }); },
        execFileSyncFn: (file, args) => { upgradeCalls.push({ file, args }); },
      },
    );
    const headroomCall = upgradeCalls.find(
      c => c.args?.includes('headroom-ai') || (c.cmd ?? '').includes('headroom-ai'),
    );
    assert.equal(headroomCall, undefined, `headroom upgrade should not run for headroom-lite, got: ${JSON.stringify(headroomCall)}`);
  });

  it('runs headroom uv pip install when backend is headroom-original', async () => {
    const { runToolUpdates } = await import('../src/cli/update.mjs');
    const upgradeCalls = [];
    await runToolUpdates(
      { check: false },
      {
        os: 'linux',
        log: () => {},
        warn: () => {},
        loadConfigFn: async () => ({ compression: { backend: 'headroom-original' } }),
        detectAllFn: async () => ({
          node: { installed: false, version: null },
          uv: { installed: false, version: null },
          headroom: { installed: true, version: '0.31.0' },
          rtk: { installed: false, version: null },
          serena: { installed: false, version: null },
          semble: { installed: false, version: null },
          astgrep: { installed: false, version: null },
          codegraph: { installed: false, version: null },
        }),
        execSyncFn: (cmd) => { upgradeCalls.push({ cmd }); },
        execFileSyncFn: (file, args) => { upgradeCalls.push({ file, args }); },
      },
    );
    const headroomCall = upgradeCalls.find(
      c => c.args?.some(a => String(a).includes('headroom-ai')),
    );
    assert.ok(headroomCall !== undefined, 'headroom upgrade should run for headroom-original');
    assert.equal(headroomCall.file, 'uv');
    assert.ok(headroomCall.args.includes('pip'));
  });
});
