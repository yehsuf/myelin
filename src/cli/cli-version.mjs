import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Read the real version from the package.json shipped in this release, so
 * `myelin --version` always reflects the installed release instead of a stale
 * hardcoded string (the CLI used to hardcode .version('1.0.0'), so
 * `myelin --version` always printed 1.0.0 regardless of the deployed release).
 *
 * Kept in its own module (no commander / no argv parsing) so it is importable
 * from tests without triggering the CLI's program.parse() side effect.
 */
export function resolveCliVersion(metaUrl = import.meta.url, readFileSyncImpl = readFileSync) {
  try {
    const pkgPath = join(dirname(fileURLToPath(metaUrl)), '..', '..', 'package.json');
    const version = JSON.parse(readFileSyncImpl(pkgPath, 'utf8'))?.version;
    return typeof version === 'string' && version ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
