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
