import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReleaseTarget } from '../src/update/release-channels.mjs';

describe('managed release channels', () => {
  it('uses the newest non-prerelease GitHub release for stable', async () => {
    const requests = [];
    const target = await resolveReleaseTarget({
      channel: 'stable',
      repository: 'yehsuf/myelin',
      fetch: async (url, options) => {
        requests.push({ url, options });
        return {
          ok: true,
          json: async () => [
            { tag_name: 'v1.2.0-beta.1', prerelease: true },
            { tag_name: 'v1.1.0', prerelease: false, tarball_url: 'https://example.test/v1.1.0' },
          ],
        };
      },
    });

    assert.equal(target.channel, 'stable');
    assert.equal(target.version, '1.1.0');
    assert.equal(target.tag, 'v1.1.0');
    assert.equal(target.tarballUrl, 'https://example.test/v1.1.0');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.github.com/repos/yehsuf/myelin/releases');
  });

  it('does not fall back to main when stable has no release', async () => {
    await assert.rejects(
      () => resolveReleaseTarget({
        channel: 'stable',
        repository: 'yehsuf/myelin',
        fetch: async () => ({ ok: true, json: async () => [] }),
      }),
      /No stable Myelin release exists.*--channel main/,
    );
  });

  it('continues GitHub release pagination until it finds a stable release', async () => {
    const urls = [];
    const target = await resolveReleaseTarget({
      channel: 'stable',
      repository: 'yehsuf/myelin',
      fetch: async (url) => {
        urls.push(url);
        if (urls.length === 1) {
          return {
            ok: true,
            headers: {
              get: (name) => (
                name.toLowerCase() === 'link'
                  ? '<https://api.github.com/repos/yehsuf/myelin/releases?page=2>; rel="next"'
                  : null
              ),
            },
            json: async () => [{ tag_name: 'v2.0.0-beta.1', prerelease: true }],
          };
        }
        return {
          ok: true,
          headers: { get: () => null },
          json: async () => [{
            tag_name: 'v1.1.0',
            prerelease: false,
            tarball_url: 'https://example.test/v1.1.0',
          }],
        };
      },
    });

    assert.equal(target.version, '1.1.0');
    assert.deepEqual(urls, [
      'https://api.github.com/repos/yehsuf/myelin/releases',
      'https://api.github.com/repos/yehsuf/myelin/releases?page=2',
    ]);
  });

  it('resolves main only to an exact remote commit using argv execution', async () => {
    const commands = [];
    const target = await resolveReleaseTarget({
      channel: 'main',
      repository: 'yehsuf/myelin',
      fetch: async () => {
        throw new Error('main must not query the releases API');
      },
      exec: (file, args, options) => {
        commands.push({ file, args, options });
        return '0123456789abcdef0123456789abcdef01234567\trefs/heads/main\n';
      },
    });

    assert.deepEqual(commands.map(({ file, args }) => [file, args]), [[
      'git',
      ['ls-remote', 'https://github.com/yehsuf/myelin.git', 'refs/heads/main'],
    ]]);
    assert.equal(target.channel, 'main');
    assert.equal(target.commit, '0123456789abcdef0123456789abcdef01234567');
    assert.equal(target.version, 'main-0123456789abcdef0123456789abcdef01234567');
  });

  it('rejects unsafe repository, release URL, and main output values', async () => {
    await assert.rejects(
      () => resolveReleaseTarget({
        channel: 'stable',
        repository: '../myelin',
        fetch: async () => ({ ok: true, json: async () => [] }),
      }),
      /repository/i,
    );

    await assert.rejects(
      () => resolveReleaseTarget({
        channel: 'stable',
        repository: 'yehsuf/myelin',
        fetch: async () => ({
          ok: true,
          json: async () => [{
            tag_name: 'v1.1.0',
            prerelease: false,
            tarball_url: 'file:///unsafe-release.tar.gz',
          }],
        }),
      }),
      /tarball URL/i,
    );

    await assert.rejects(
      () => resolveReleaseTarget({
        channel: 'main',
        repository: 'yehsuf/myelin',
        exec: () => 'not-a-sha\trefs/heads/main\n',
      }),
      /main commit/i,
    );
  });
});
