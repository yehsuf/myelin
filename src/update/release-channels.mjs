import { execFileSync } from 'node:child_process';

const SAFE_REPOSITORY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const STABLE_TAG = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/u;
const FULL_SHA = /^[0-9a-f]{40}$/iu;

function releaseChannelError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateRepository(repository) {
  if (typeof repository !== 'string' || repository.includes('\0')) {
    throw new TypeError('repository must be an owner/name string.');
  }
  const parts = repository.split('/');
  if (parts.length !== 2 || !parts.every((part) => SAFE_REPOSITORY_PART.test(part))) {
    throw new TypeError('repository must be a safe GitHub owner/name string.');
  }
  return repository;
}

export function stableVersion(tag) {
  if (typeof tag !== 'string') return null;
  return STABLE_TAG.exec(tag)?.[1] ?? null;
}

function validateTarballUrl(value) {
  if (typeof value !== 'string' || value.includes('\0') || /\s/u.test(value)) {
    throw releaseChannelError('Stable release tarball URL is invalid.', 'ERR_RELEASE_TARBALL_URL');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw releaseChannelError('Stable release tarball URL is invalid.', 'ERR_RELEASE_TARBALL_URL');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw releaseChannelError('Stable release tarball URL is invalid.', 'ERR_RELEASE_TARBALL_URL');
  }
  return value;
}

function outputText(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
}

function releasesUrl(repository) {
  return `https://api.github.com/repos/${repository}/releases`;
}

function nextReleasePage(response, repository) {
  const link = response?.headers?.get?.('link');
  if (typeof link !== 'string' || link.length === 0) return null;
  const next = /<([^>]+)>\s*;\s*rel="next"/u.exec(link)?.[1];
  if (!next) return null;

  let url;
  try {
    url = new URL(next);
  } catch {
    throw releaseChannelError('Stable release pagination URL is invalid.', 'ERR_RELEASE_API');
  }
  const expected = new URL(releasesUrl(repository));
  if (
    url.protocol !== expected.protocol
    || url.hostname !== expected.hostname
    || url.username
    || url.password
    || url.pathname !== expected.pathname
  ) {
    throw releaseChannelError('Stable release pagination URL is invalid.', 'ERR_RELEASE_API');
  }
  return url.href;
}

function mainTarget(repository, exec) {
  if (typeof exec !== 'function') throw new TypeError('exec must be a function.');

  const sourceUrl = `https://github.com/${repository}.git`;
  const output = outputText(exec(
    'git',
    ['ls-remote', sourceUrl, 'refs/heads/main'],
    { encoding: 'utf8', stdio: 'pipe' },
  )).trim();
  const match = /^([0-9a-f]{40})\trefs\/heads\/main$/iu.exec(output);
  if (!match || !FULL_SHA.test(match[1])) {
    throw releaseChannelError(
      'Unable to resolve an exact main commit from git ls-remote.',
      'ERR_RELEASE_MAIN_COMMIT',
    );
  }

  const commit = match[1].toLowerCase();
  return {
    channel: 'main',
    repository,
    sourceValidated: true,
    commit,
    version: `main-${commit}`,
    source: {
      type: 'git',
      url: sourceUrl,
      commit,
    },
  };
}

async function stableTarget(repository, fetch) {
  if (typeof fetch !== 'function') throw new TypeError('fetch must be a function for the stable channel.');

  let pageUrl = releasesUrl(repository);
  const seenPages = new Set();
  for (let page = 0; page < 100 && pageUrl !== null; page += 1) {
    if (seenPages.has(pageUrl)) {
      throw releaseChannelError('Stable release pagination loop is invalid.', 'ERR_RELEASE_API');
    }
    seenPages.add(pageUrl);
    const response = await fetch(pageUrl, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response?.ok) {
      throw releaseChannelError(
        `Unable to resolve stable Myelin releases (${response?.status ?? 'request failed'}).`,
        'ERR_RELEASE_API',
      );
    }

    let releases;
    try {
      releases = await response.json();
    } catch (cause) {
      throw releaseChannelError(
        `Stable release response was not valid JSON: ${cause.message}`,
        'ERR_RELEASE_API_JSON',
      );
    }
    if (!Array.isArray(releases)) {
      throw releaseChannelError('Stable release response must be an array.', 'ERR_RELEASE_API_JSON');
    }

    const release = releases.find((candidate) => (
      candidate
      && candidate.draft !== true
      && candidate.prerelease !== true
      && stableVersion(candidate.tag_name) !== null
    ));
    if (release) {
      const version = stableVersion(release.tag_name);
      const tarballUrl = validateTarballUrl(release.tarball_url);
      return {
        channel: 'stable',
        repository,
        sourceValidated: true,
        version,
        tag: release.tag_name,
        tarballUrl,
        source: {
          type: 'tarball',
          url: tarballUrl,
        },
      };
    }

    pageUrl = nextReleasePage(response, repository);
  }
  throw releaseChannelError(
    'No stable Myelin release exists. Use myelin update --channel main to select an explicit main commit.',
    'ERR_RELEASE_STABLE_MISSING',
  );
}

/**
 * Resolves a channel to an immutable stable release or exact main commit.
 * All network and command dependencies are injectable for deterministic tests.
 */
export async function resolveReleaseTarget({
  channel = 'stable',
  repository = 'yehsuf/myelin',
  fetch = globalThis.fetch,
  exec = execFileSync,
} = {}) {
  const safeRepository = validateRepository(repository);
  if (channel === 'stable') return stableTarget(safeRepository, fetch);
  if (channel === 'main') return mainTarget(safeRepository, exec);
  throw new TypeError('channel must be "stable" or "main".');
}
