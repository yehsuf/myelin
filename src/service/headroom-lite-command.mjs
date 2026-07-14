import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

const JAVASCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);

function isJavaScriptEntrypoint(path) {
  if (JAVASCRIPT_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  try {
    return /^#!.*\bnode(?:\s|$)/u.test(readFileSync(path, 'utf8').split(/\r?\n/u, 1)[0]);
  } catch {
    return false;
  }
}

function isWithin(directory, path) {
  const pathRelative = relative(directory, path);
  return pathRelative === '' || (!pathRelative.startsWith('..') && !isAbsolute(pathRelative));
}

function packageCliEntrypoint(packageDir, binName) {
  const metadataPath = join(packageDir, 'package.json');
  if (!existsSync(metadataPath)) return null;

  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch {
    return null;
  }

  const packageNameMatchesBin = metadata.name === binName || metadata.name?.endsWith(`/${binName}`);
  if (!packageNameMatchesBin) return null;
  const declaredBin = typeof metadata.bin === 'string'
    ? metadata.bin
    : metadata.bin?.[binName];
  const entrypoint = declaredBin;
  if (typeof entrypoint !== 'string' || !entrypoint) return null;
  if (isAbsolute(entrypoint)) {
    throw new Error(`headroom-lite package metadata must use a relative CLI entrypoint: ${metadataPath}`);
  }

  const entrypointPath = resolve(packageDir, entrypoint);
  if (!isWithin(packageDir, entrypointPath)) {
    throw new Error(`headroom-lite package metadata points outside its package directory: ${metadataPath}`);
  }

  let realEntrypoint;
  try {
    realEntrypoint = realpathSync(entrypointPath);
  } catch {
    throw new Error(`headroom-lite package metadata points to a missing CLI entrypoint: ${entrypointPath}`);
  }
  if (!isJavaScriptEntrypoint(realEntrypoint)) {
    throw new Error(`headroom-lite package metadata must resolve to a JavaScript CLI entrypoint: ${realEntrypoint}`);
  }
  return realEntrypoint;
}

function isDirectoryEntry(entry, path) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function packageDirectories(globalNodeModules) {
  try {
    return readdirSync(globalNodeModules, { withFileTypes: true }).flatMap((entry) => {
      const path = join(globalNodeModules, entry.name);
      if (!isDirectoryEntry(entry, path)) return [];
      if (!entry.name.startsWith('@')) return [path];
      try {
        return readdirSync(path, { withFileTypes: true })
          .flatMap((scopedPackage) => {
            const scopedPath = join(path, scopedPackage.name);
            return isDirectoryEntry(scopedPackage, scopedPath) ? [scopedPath] : [];
          });
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function resolveFromGlobalPackages(binPath, binName) {
  const binDir = dirname(binPath);
  if (basename(binDir) !== 'bin') return null;

  const globalNodeModules = join(dirname(binDir), 'lib', 'node_modules');
  const candidates = [];
  for (const packageDir of packageDirectories(globalNodeModules)) {
    const entrypoint = packageCliEntrypoint(packageDir, binName);
    if (entrypoint) candidates.push(entrypoint);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(`Multiple global headroom-lite package candidates were found for "${binName}". Reinstall headroom-lite so its global launcher resolves uniquely.`);
  }
  return null;
}

function resolveFromContainingPackage(realBinPath, binName) {
  let directory = dirname(realBinPath);
  while (directory !== dirname(directory)) {
    const entrypoint = packageCliEntrypoint(directory, binName);
    if (entrypoint) return entrypoint;
    directory = dirname(directory);
  }
  return null;
}

export function resolveHeadroomLiteEntrypoint(headroomLiteBin) {
  let realBinPath;
  try {
    realBinPath = realpathSync(headroomLiteBin);
  } catch {
    throw new Error(`Unable to resolve headroom-lite launcher "${headroomLiteBin}". Reinstall headroom-lite or provide its npm global bin path.`);
  }
  if (JAVASCRIPT_EXTENSIONS.has(extname(realBinPath).toLowerCase())) return realBinPath;

  const binName = basename(headroomLiteBin);
  const entrypoint = resolveFromContainingPackage(realBinPath, binName)
    ?? resolveFromGlobalPackages(headroomLiteBin, binName);
  if (entrypoint) return entrypoint;

  throw new Error(`Unable to resolve a JavaScript entrypoint for headroom-lite launcher "${headroomLiteBin}". Reinstall headroom-lite so its package metadata declares the "${binName}" CLI.`);
}
