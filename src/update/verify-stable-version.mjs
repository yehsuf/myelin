#!/usr/bin/env node
// Rejects any version input that stable release discovery (resolveReleaseTarget
// with channel: 'stable' in ./release-channels.mjs) would not select, so the
// release workflow can never publish a release that `myelin update` ignores.
import { stableVersion } from './release-channels.mjs';

const version = process.argv[2];
const parsed = stableVersion(version);

// stableVersion tolerates an optional leading "v" and returns the version
// without it; requiring an exact match rejects both "v"-prefixed input and
// any prerelease/malformed input that the regex does not fully consume.
if (parsed === null || parsed !== version) {
  console.error(
    `Version "${version}" is not an accepted stable release version. `
    + 'It must match the exact format stable release discovery accepts: '
    + 'MAJOR.MINOR.PATCH with no leading "v" and no prerelease suffix '
    + '(optional build metadata such as +build.1 is allowed).',
  );
  process.exit(1);
}

process.stdout.write(`${parsed}\n`);
