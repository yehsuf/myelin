import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import {
  validateComponentManifest,
  MANAGED_PYTHON_VERSION,
} from './component-manifest.mjs';
import { componentVersionDir } from './version-store.mjs';

const GITHUB_API_ACCEPT = 'Accept: application/vnd.github+json';
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const FULL_SHA = /^[0-9a-f]{40}$/iu;
const SAFE_GITHUB_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_PYTHON_PACKAGE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._,-]+\])?$/u;
const SAFE_NPM_PACKAGE = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function installerError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function isWindows(platform) {
  return platform.os === 'win32';
}

function safeWindowsCmdArgument(value) {
  if (
    typeof value !== 'string'
    || value.includes('\0')
    || /[%!^&|<>()"\r\n]/u.test(value)
  ) {
    throw installerError('unsafe Windows command argument.', 'ERR_COMPONENT_COMMAND_UNSAFE');
  }
  return `"${value}"`;
}

function runCommand(exec, file, args, options, platform) {
  const requiresCmd = isWindows(platform) && (
    file === 'npm'
    || /\.(?:cmd|bat)$/iu.test(file)
  );
  if (!requiresCmd) return exec(file, args, options);
  const executable = /\.(?:cmd|bat)$/iu.test(file)
    ? `call ${safeWindowsCmdArgument(file)}`
    : file;
  const command = [executable, ...args.map(safeWindowsCmdArgument)].join(' ');
  return exec('cmd.exe', ['/d', '/s', '/c', command], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

function pathFor(platform) {
  return isWindows(platform) ? win32 : posix;
}

function lstatPresence(path, fs) {
  if (typeof fs?.lstatSync !== 'function') throw new TypeError('fs.lstatSync must be a function.');
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function normalizePlatform(platform = process.platform) {
  const source = typeof platform === 'string' ? { os: platform } : platform;
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError('platform must be an operating system string or object.');
  }

  const rawOs = String(source.os ?? source.platform ?? process.platform).toLowerCase();
  const os = rawOs === 'windows' || rawOs === 'win32'
    ? 'win32'
    : rawOs;
  if (!['darwin', 'linux', 'win32'].includes(os)) {
    throw new TypeError(`unsupported platform: ${rawOs}`);
  }

  const rawArch = String(source.arch ?? process.arch).toLowerCase();
  const arch = rawArch === 'x86_64' || rawArch === 'amd64'
    ? 'x64'
    : rawArch === 'aarch64'
      ? 'arm64'
      : rawArch;
  if (!['x64', 'arm64', 'ia32'].includes(arch)) {
    throw new TypeError(`unsupported architecture: ${rawArch}`);
  }
  return { os, arch };
}

function validateDestination(destination) {
  if (typeof destination !== 'string' || destination.length === 0 || destination.includes('\0')) {
    throw new TypeError('destination must be a non-empty path string.');
  }
  if (destination.startsWith('-')) {
    throw new TypeError('destination must not start with a command option prefix.');
  }
  return destination;
}

function validatePythonPackage(value) {
  if (typeof value !== 'string' || !SAFE_PYTHON_PACKAGE.test(value)) {
    throw new TypeError('package must be a safe Python package requirement.');
  }
  return value;
}

function validateNpmPackage(value) {
  if (typeof value !== 'string' || !SAFE_NPM_PACKAGE.test(value)) {
    throw new TypeError('package must be a safe npm package name.');
  }
  return value;
}

function validateNpmGitPackage(value) {
  if (typeof value !== 'string' || !value.startsWith('github:')) {
    throw new TypeError('package must be a safe GitHub npm package source.');
  }
  validateGithubRepository(value.slice('github:'.length));
  return value;
}

function validateHttpsGitUrl(repository) {
  if (typeof repository !== 'string' || repository.includes('\0') || /\s/u.test(repository)) {
    throw new TypeError('repository must be a safe HTTPS git URL.');
  }
  let url;
  try {
    url = new URL(repository);
  } catch {
    throw new TypeError('repository must be a safe HTTPS git URL.');
  }
  if (
    url.protocol !== 'https:'
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
    || !url.pathname.endsWith('.git')
  ) {
    throw new TypeError('repository must be a safe HTTPS git URL.');
  }
  return repository;
}

function validateGithubRepository(repository) {
  if (typeof repository !== 'string' || repository.includes('\0')) {
    throw new TypeError('repository must be a GitHub owner/repository identifier.');
  }
  const parts = repository.split('/');
  if (
    parts.length !== 2
    || !parts.every((part) => SAFE_GITHUB_PART.test(part) && part !== '.' && part !== '..')
  ) {
    throw new TypeError('repository must be a GitHub owner/repository identifier.');
  }
  return repository;
}

function validateComponent(component) {
  validateComponentManifest({ component });
  switch (component.kind) {
    case 'uv-venv':
      validatePythonPackage(component.package);
      break;
    case 'uv-git':
      validatePythonPackage(component.package);
      validateHttpsGitUrl(component.repository);
      if (!FULL_SHA.test(component.ref)) {
        throw new TypeError('git ref must be a full immutable SHA.');
      }
      break;
    case 'npm':
      validateNpmPackage(component.package);
      break;
    case 'npm-git':
      validateNpmGitPackage(component.package);
      break;
    case 'git-checkout':
      validateHttpsGitUrl(component.repository);
      if (!FULL_SHA.test(component.ref)) {
        throw new TypeError('git ref must be a full immutable SHA.');
      }
      break;
    case 'github-binary':
      validateGithubRepository(component.repository);
      break;
    default:
      throw new TypeError(`unsupported component kind: ${component.kind}`);
  }
  return component;
}

function withWindowsExecutableExtension(name, platform, extension) {
  if (!isWindows(platform) || /\.[A-Za-z0-9]+$/u.test(name)) return name;
  return `${name}${extension}`;
}

function managedBinaryPath(component, destination, platform) {
  if (!component.bin) return null;
  const path = pathFor(platform);
  switch (component.kind) {
    case 'uv-venv':
    case 'uv-git':
      return path.join(
        destination,
        isWindows(platform) ? 'Scripts' : 'bin',
        withWindowsExecutableExtension(component.bin, platform, '.exe'),
      );
    case 'npm':
    case 'npm-git':
      return path.join(
        destination,
        'node_modules',
        '.bin',
        withWindowsExecutableExtension(component.bin, platform, '.cmd'),
      );
    case 'github-binary':
      return path.join(
        destination,
        'bin',
        withWindowsExecutableExtension(component.bin, platform, '.exe'),
      );
    default:
      return null;
  }
}

function managedPythonPath(destination, platform) {
  const path = pathFor(platform);
  return path.join(
    destination,
    isWindows(platform) ? 'Scripts' : 'bin',
    isWindows(platform) ? 'python.exe' : 'python',
  );
}

function managedVersionProbe(component, plan) {
  const distribution = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9._,-]+\])?$/u
    .exec(component.package ?? '')?.[1];
  if (component.kind === 'uv-venv' && component.bin === distribution) {
    return {
      file: managedPythonPath(plan.destination, plan.platform),
      args: ['-c', `from importlib.metadata import version; print(version("${distribution}"))`],
    };
  }
  return { file: plan.binPath, args: ['--version'] };
}

function githubReleaseUrl(component) {
  return `https://api.github.com/repos/${component.repository}/releases/tags/${component.ref}`;
}

function githubReleaseCommand(component) {
  return [
    'curl',
    '--fail',
    '--silent',
    '--show-error',
    '--location',
    '--proto',
    '=https',
    '--proto-redir',
    '=https',
    '--header',
    GITHUB_API_ACCEPT,
    githubReleaseUrl(component),
  ];
}

function githubDownloadCommand(url) {
  return [
    'curl',
    '--fail',
    '--silent',
    '--show-error',
    '--location',
    '--proto',
    '=https',
    '--proto-redir',
    '=https',
    url,
  ];
}

/**
 * Produces only immutable, argument-vector commands. It does not execute,
 * resolve, or download anything.
 */
export function buildComponentInstallPlan(component, destination, platform = process.platform) {
  validateComponent(component);
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedDestination = pathFor(normalizedPlatform).normalize(validateDestination(destination));
  const binPath = managedBinaryPath(component, normalizedDestination, normalizedPlatform);
  const base = {
    kind: component.kind,
    destination: normalizedDestination,
    platform: normalizedPlatform,
    binPath,
  };

  switch (component.kind) {
    case 'uv-venv': {
      const pyVersion = component.pythonVersion ?? MANAGED_PYTHON_VERSION;
      // noBuildOnPlatforms: skip source builds on listed platforms. This prevents
      // uv from invoking Rust/maturin when a binary wheel is Defender-blocked,
      // producing a clear "no binary wheel" error instead of "link.exe not found"
      // (WIN-HEADROOM-BINONLY-001). normalizedPlatform is { os, arch } — compare .os.
      const noBuildPlatforms = Array.isArray(component.noBuildOnPlatforms) ? component.noBuildOnPlatforms : [];
      const noBuild = noBuildPlatforms.includes(normalizedPlatform.os);
      return {
        ...base,
        commands: [
          ['uv', 'venv', '--python', pyVersion, normalizedDestination],
          ['uv', 'pip', 'install', ...(noBuild ? ['--only-binary', ':all:'] : []),
            '--python', normalizedDestination, `${component.package}==${component.version}`],
        ],
      };
    }
    case 'uv-git': {
      const pyVersion = component.pythonVersion ?? MANAGED_PYTHON_VERSION;
      return {
        ...base,
        commands: [
          ['uv', 'venv', '--python', pyVersion, normalizedDestination],
          ['uv', 'pip', 'install', '--python', normalizedDestination, `git+${component.repository}@${component.ref}`],
        ],
      };
    }
    case 'npm':
      return {
        ...base,
        commands: [
          ['npm', 'install', '--prefix', normalizedDestination, `${component.package}@${component.version}`],
        ],
      };
    case 'npm-git':
      return {
        ...base,
        commands: [
          ['npm', 'install', '--prefix', normalizedDestination, `${component.package}#${component.ref}`],
        ],
      };
    case 'git-checkout':
      return {
        ...base,
        commands: [
          ['git', 'clone', '--no-checkout', '--', component.repository, normalizedDestination],
          ['git', '-C', normalizedDestination, 'fetch', '--depth', '1', 'origin', component.ref],
          ['git', '-C', normalizedDestination, 'checkout', '--detach', component.ref],
        ],
      };
    case 'github-binary':
      return {
        ...base,
        commands: [githubReleaseCommand(component)],
        release: {
          repository: component.repository,
          tag: component.ref,
          url: githubReleaseUrl(component),
        },
      };
    default:
      throw new TypeError(`unsupported component kind: ${component.kind}`);
  }
}

function assetMatchesOperatingSystem(name, os) {
  switch (os) {
    case 'win32':
      return /(?:windows|win32|pc-win)/iu.test(name)
        || /^winsw-[a-z0-9._-]+\.exe$/iu.test(name);
    case 'darwin':
      return /(?:darwin|macos|apple-darwin)/iu.test(name);
    case 'linux':
      return /linux/iu.test(name);
    default:
      return false;
  }
}

function assetArchitectureScore(name, arch) {
  const containsX64 = /(?:x86_64|amd64|(?:^|[-_.])x64(?:[-_.]|$))/iu.test(name);
  const containsArm64 = /(?:aarch64|arm64)/iu.test(name);
  const containsIa32 = /(?:i[3-6]86|x86(?!_64))/iu.test(name);
  const hasKnownArchitecture = containsX64 || containsArm64 || containsIa32;
  const matches = (
    (arch === 'x64' && containsX64)
    || (arch === 'arm64' && containsArm64)
    || (arch === 'ia32' && containsIa32)
  );
  if (matches) return 2;
  return hasKnownArchitecture ? -1 : 1;
}

function isChecksumAssetName(name) {
  return (
    /(?:^|[._-])(?:sha256sums?|checksums?)(?:[._-]|$)/iu.test(name)
    || /\.sha256(?:sum)?$/iu.test(name)
  );
}

/**
 * Selects by operating system, architecture, and lexical asset name so release
 * asset array order cannot alter the chosen download.
 */
export function selectGithubBinaryAsset(release = {}, platform = process.platform) {
  const normalizedPlatform = normalizePlatform(platform);
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const winswAssets = normalizedPlatform.os === 'win32'
    ? assets
      .filter((asset) => typeof asset?.name === 'string' && typeof asset?.browser_download_url === 'string')
      .filter((asset) => /^winsw-[a-z0-9._-]+\.exe$/iu.test(asset.name))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    : [];
  if (winswAssets.length > 0) {
    const first = (pattern) => winswAssets.find((asset) => pattern.test(asset.name)) ?? null;
    if (normalizedPlatform.arch === 'arm64') {
      return first(/^winsw-(?:arm64|aarch64)\.exe$/iu)
        ?? first(/^winsw-x64\.exe$/iu)
        ?? first(/^winsw-(?:net461|net4)\.exe$/iu);
    }
    if (normalizedPlatform.arch === 'x64') {
      return first(/^winsw-x64\.exe$/iu)
        ?? first(/^winsw-(?:net461|net4)\.exe$/iu);
    }
    if (normalizedPlatform.arch === 'ia32') {
      return first(/^winsw-x86\.exe$/iu)
        ?? first(/^winsw-(?:net461|net4)\.exe$/iu);
    }
  }
  const candidates = assets
    .filter((asset) => typeof asset?.name === 'string' && typeof asset?.browser_download_url === 'string')
    .map((asset) => ({
      asset,
      name: asset.name.toLowerCase(),
    }))
    .filter(({ name }) => !isChecksumAssetName(name) && assetMatchesOperatingSystem(name, normalizedPlatform.os))
    .map(({ asset, name }) => ({
      asset,
      name,
      architectureScore: assetArchitectureScore(name, normalizedPlatform.arch),
    }))
    .filter(({ architectureScore }) => architectureScore >= 0)
    .sort((left, right) => (
      right.architectureScore - left.architectureScore
      || left.name.localeCompare(right.name, 'en')
    ));
  return candidates[0]?.asset ?? null;
}

function validateDownloadUrl(value) {
  if (typeof value !== 'string' || value.includes('\0') || /\s/u.test(value)) {
    throw installerError('GitHub release asset URL is invalid.', 'ERR_COMPONENT_ASSET_URL');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw installerError('GitHub release asset URL is invalid.', 'ERR_COMPONENT_ASSET_URL');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw installerError('GitHub release asset URL is invalid.', 'ERR_COMPONENT_ASSET_URL');
  }
  return value;
}

function outputText(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value ?? '');
}

function outputBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
}

function parseRelease(value) {
  try {
    const release = JSON.parse(outputText(value));
    if (!release || typeof release !== 'object' || Array.isArray(release)) {
      throw new Error('release is not an object');
    }
    return release;
  } catch (cause) {
    throw installerError(
      `GitHub release response was not valid JSON: ${cause.message}`,
      'ERR_COMPONENT_RELEASE_JSON',
    );
  }
}

function directAssetChecksum(asset) {
  if (!Object.hasOwn(asset, 'digest') || asset.digest === null) return null;
  if (typeof asset.digest !== 'string') {
    throw installerError('Published asset checksum is malformed.', 'ERR_COMPONENT_CHECKSUM');
  }
  const match = /^sha256:([0-9a-f]{64})$/iu.exec(asset.digest);
  if (!match) {
    throw installerError('Published asset checksum is malformed.', 'ERR_COMPONENT_CHECKSUM');
  }
  return { algorithm: 'sha256', expected: match[1].toLowerCase(), source: 'asset-digest' };
}

function selectChecksumAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const candidates = assets
    .filter((asset) => typeof asset?.name === 'string' && typeof asset?.browser_download_url === 'string')
    .filter((asset) => isChecksumAssetName(asset.name.toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  return candidates[0] ?? null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function checksumFromManifest(text, assetName) {
  const escapedName = escapeRegExp(assetName);
  const sha256sum = new RegExp(`^\\s*([0-9a-f]{64})\\s+\\*?${escapedName}\\s*$`, 'iu');
  const bsdStyle = new RegExp(`^\\s*SHA256\\s*\\(${escapedName}\\)\\s*=\\s*([0-9a-f]{64})\\s*$`, 'iu');
  for (const line of String(text).split(/\r?\n/u)) {
    const match = sha256sum.exec(line) ?? bsdStyle.exec(line);
    if (match) return match[1].toLowerCase();
  }
  throw installerError(
    `Published checksum does not contain an entry for ${assetName}.`,
    'ERR_COMPONENT_CHECKSUM',
  );
}

function verifyChecksum(buffer, checksum) {
  if (!checksum) return { verified: false, algorithm: null, source: null };
  const actual = createHash(checksum.algorithm).update(buffer).digest('hex');
  if (actual !== checksum.expected) {
    throw installerError('Published checksum mismatch for downloaded component asset.', 'ERR_COMPONENT_CHECKSUM_MISMATCH');
  }
  return {
    verified: true,
    algorithm: checksum.algorithm,
    source: checksum.source,
  };
}

function pinnedChecksum(component, assetName) {
  const map = component?.checksums;
  if (!map || typeof map !== 'object') return null;
  const key = Object.keys(map).find((name) => name.toLowerCase() === assetName.toLowerCase());
  if (key === undefined) return null;
  const value = map[key];
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/iu.test(value)) {
    throw installerError(
      `Reviewer-pinned checksum for ${assetName} is malformed.`,
      'ERR_COMPONENT_CHECKSUM',
    );
  }
  return { algorithm: 'sha256', expected: value.toLowerCase(), source: 'manifest-pinned' };
}

function archiveError(message) {
  return installerError(message, 'ERR_COMPONENT_ARCHIVE_UNSAFE');
}

function safeArchivePath(entryName) {
  if (typeof entryName !== 'string' || entryName.length === 0 || entryName.includes('\0')) {
    throw archiveError('unsafe archive path.');
  }
  const trimmed = entryName.endsWith('/') ? entryName.slice(0, -1) : entryName;
  if (
    trimmed.length === 0
    || trimmed.startsWith('/')
    || trimmed.startsWith('\\')
    || /^[A-Za-z]:/u.test(trimmed)
    || trimmed.includes('\\')
  ) {
    throw archiveError(`unsafe archive path: ${entryName}`);
  }
  const parts = trimmed.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.includes(':'))) {
    throw archiveError(`unsafe archive path: ${entryName}`);
  }
  return parts.join('/');
}

function boundedSlice(buffer, start, length, label) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > buffer.length) {
    throw archiveError(`malformed ${label}.`);
  }
  return buffer.subarray(start, start + length);
}

function readTarString(header, start, length) {
  const field = boundedSlice(header, start, length, 'tar header');
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator === -1 ? field.length : terminator).toString('utf8');
}

function readTarSize(header) {
  const raw = readTarString(header, 124, 12).trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/u.test(raw)) throw archiveError('tar entry has an invalid size.');
  const size = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE_BYTES) {
    throw archiveError('tar entry exceeds the maximum safe size.');
  }
  return size;
}

function isZeroBlock(buffer, offset) {
  for (let index = offset; index < offset + 512; index += 1) {
    if (buffer[index] !== 0) return false;
  }
  return true;
}

function parseTarGzip(buffer) {
  let tar;
  try {
    tar = gunzipSync(buffer, { maxOutputLength: MAX_ARCHIVE_BYTES });
  } catch (cause) {
    throw archiveError(`invalid gzip archive: ${cause.message}`);
  }
  if (tar.length > MAX_ARCHIVE_BYTES) throw archiveError('archive exceeds the maximum safe size.');

  const entries = [];
  let offset = 0;
  let totalSize = 0;
  while (offset < tar.length) {
    if (offset + 512 > tar.length) throw archiveError('truncated tar header.');
    if (isZeroBlock(tar, offset)) break;
    const header = tar.subarray(offset, offset + 512);
    const prefix = readTarString(header, 345, 155);
    const name = readTarString(header, 0, 100);
    const path = safeArchivePath(prefix ? `${prefix}/${name}` : name);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const size = readTarSize(header);
    if (size > MAX_ARCHIVE_BYTES - totalSize) {
      throw archiveError('archive exceeds the maximum cumulative safe size.');
    }
    totalSize += size;
    const dataOffset = offset + 512;
    const data = boundedSlice(tar, dataOffset, size, 'tar entry');
    if (type === '0') {
      entries.push({ type: 'file', path, data });
    } else if (type === '5') {
      if (size !== 0) throw archiveError('tar directory entry has content.');
      entries.push({ type: 'directory', path });
    } else {
      throw archiveError(`unsupported tar entry type for ${path}.`);
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readUInt16(buffer, offset, label) {
  boundedSlice(buffer, offset, 2, label);
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset, label) {
  boundedSlice(buffer, offset, 4, label);
  return buffer.readUInt32LE(offset);
}

function findZipEnd(buffer) {
  const first = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= first; offset -= 1) {
    if (readUInt32(buffer, offset, 'zip end') === 0x06054b50) return offset;
  }
  throw archiveError('zip end record is missing.');
}

function parseZip(buffer) {
  if (buffer.length > MAX_ARCHIVE_BYTES) throw archiveError('archive exceeds the maximum safe size.');
  const end = findZipEnd(buffer);
  const disk = readUInt16(buffer, end + 4, 'zip end');
  const centralDisk = readUInt16(buffer, end + 6, 'zip end');
  const entriesOnDisk = readUInt16(buffer, end + 8, 'zip end');
  const entryCount = readUInt16(buffer, end + 10, 'zip end');
  const centralSize = readUInt32(buffer, end + 12, 'zip end');
  const centralOffset = readUInt32(buffer, end + 16, 'zip end');
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw archiveError('multi-disk zip archives are not supported.');
  }
  boundedSlice(buffer, centralOffset, centralSize, 'zip central directory');

  const entries = [];
  let offset = centralOffset;
  let totalUncompressedSize = 0;
  for (let count = 0; count < entryCount; count += 1) {
    if (readUInt32(buffer, offset, 'zip central directory') !== 0x02014b50) {
      throw archiveError('malformed zip central directory.');
    }
    const madeBy = readUInt16(buffer, offset + 4, 'zip central directory');
    const flags = readUInt16(buffer, offset + 8, 'zip central directory');
    const method = readUInt16(buffer, offset + 10, 'zip central directory');
    const compressedSize = readUInt32(buffer, offset + 20, 'zip central directory');
    const uncompressedSize = readUInt32(buffer, offset + 24, 'zip central directory');
    const nameLength = readUInt16(buffer, offset + 28, 'zip central directory');
    const extraLength = readUInt16(buffer, offset + 30, 'zip central directory');
    const commentLength = readUInt16(buffer, offset + 32, 'zip central directory');
    const externalAttributes = readUInt32(buffer, offset + 38, 'zip central directory');
    const localOffset = readUInt32(buffer, offset + 42, 'zip central directory');
    const rawName = boundedSlice(buffer, offset + 46, nameLength, 'zip filename');
    const name = rawName.toString('utf8');
    const path = safeArchivePath(name);
    const unixFileType = ((externalAttributes >>> 16) & 0o170000);
    const directory = name.endsWith('/');
    if ((madeBy >>> 8) === 3 && unixFileType !== 0 && unixFileType !== 0o100000 && unixFileType !== 0o040000) {
      throw archiveError(`unsupported zip entry type for ${path}.`);
    }
    if ((flags & 0x1) !== 0 || ![0, 8].includes(method)) {
      throw archiveError(`unsupported zip encoding for ${path}.`);
    }
    if (uncompressedSize > MAX_ARCHIVE_BYTES - totalUncompressedSize) {
      throw archiveError('zip archive exceeds the maximum cumulative safe size.');
    }
    totalUncompressedSize += uncompressedSize;
    if (readUInt32(buffer, localOffset, 'zip local header') !== 0x04034b50) {
      throw archiveError('zip local header is missing.');
    }
    const localNameLength = readUInt16(buffer, localOffset + 26, 'zip local header');
    const localExtraLength = readUInt16(buffer, localOffset + 28, 'zip local header');
    const compressed = boundedSlice(
      buffer,
      localOffset + 30 + localNameLength + localExtraLength,
      compressedSize,
      'zip entry',
    );
    let data;
    try {
      data = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_ARCHIVE_BYTES });
    } catch (cause) {
      throw archiveError(`cannot decompress zip entry ${path}: ${cause.message}`);
    }
    if (data.length !== uncompressedSize) throw archiveError(`zip entry size mismatch for ${path}.`);
    if (directory) {
      if (data.length !== 0) throw archiveError(`zip directory entry has content: ${path}.`);
      entries.push({ type: 'directory', path });
    } else {
      entries.push({ type: 'file', path, data });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset > centralOffset + centralSize) throw archiveError('zip central directory exceeds its bounds.');
  return entries;
}

function archiveEntries(assetName, buffer) {
  const name = assetName.toLowerCase();
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return parseTarGzip(buffer);
  if (name.endsWith('.zip')) return parseZip(buffer);
  return null;
}

function uniqueArchiveEntries(entries) {
  const entriesByPath = new Map();
  for (const entry of entries) {
    if (entriesByPath.has(entry.path)) throw archiveError(`archive contains duplicate path: ${entry.path}.`);
    entriesByPath.set(entry.path, entry);
  }
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let length = 1; length < parts.length; length += 1) {
      const parent = parts.slice(0, length).join('/');
      if (entriesByPath.get(parent)?.type === 'file') {
        throw archiveError(`archive file shadows a directory: ${entry.path}.`);
      }
    }
  }
  return entries;
}

function safeExtractionPath(destination, relativePath, platform) {
  const path = pathFor(platform);
  const target = path.resolve(destination, ...relativePath.split('/'));
  const relativePathFromRoot = path.relative(path.resolve(destination), target);
  if (
    relativePathFromRoot === ''
    || relativePathFromRoot === '..'
    || relativePathFromRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePathFromRoot)
  ) {
    throw archiveError(`unsafe archive path: ${relativePath}.`);
  }
  return target;
}

function extractEntries(entries, destination, component, plan, fs) {
  const path = pathFor(plan.platform);
  const binRoot = path.join(destination, 'bin');
  const expectedName = path.basename(plan.binPath);
  const binaryEntry = entries.find((entry) => (
    entry.type === 'file'
    && (path.basename(entry.path) === expectedName || path.basename(entry.path) === component.bin)
  ));
  if (!binaryEntry) {
    throw archiveError(`archive does not contain ${component.bin}.`);
  }

  const normalizedEntries = entries.map((entry) => (
    entry === binaryEntry ? { ...entry, path: expectedName } : entry
  ));
  uniqueArchiveEntries(normalizedEntries);
  for (const entry of normalizedEntries) safeExtractionPath(binRoot, entry.path, plan.platform);

  fs.mkdirSync(binRoot, { recursive: true });
  for (const entry of normalizedEntries) {
    const target = safeExtractionPath(binRoot, entry.path, plan.platform);
    if (entry.type === 'directory') {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    if (target === plan.binPath) {
      try {
        fs.chmodSync(target, 0o755);
      } catch {}
    }
  }
}

function stageGithubBinary({ name, component, destination, plan, exec, fs }) {
  assertFreshStageDestination(destination, fs);
  const release = parseRelease(runCommand(exec, plan.commands[0][0], plan.commands[0].slice(1), {
    encoding: 'utf8',
    maxBuffer: MAX_ARCHIVE_BYTES,
  }, plan.platform));
  if (release.tag_name !== component.ref) {
    throw installerError(
      `GitHub release tag mismatch: expected ${component.ref}, received ${release.tag_name ?? 'none'}.`,
      'ERR_COMPONENT_RELEASE_TAG',
    );
  }

  const asset = selectGithubBinaryAsset(release, plan.platform);
  if (!asset) {
    throw installerError(
      `No GitHub release asset matches ${plan.platform.os}/${plan.platform.arch}.`,
      'ERR_COMPONENT_ASSET_MISSING',
    );
  }
  validateDownloadUrl(asset.browser_download_url);

  let checksum = pinnedChecksum(component, asset.name);
  if (!checksum) checksum = directAssetChecksum(asset);
  if (!checksum) {
    const checksumAsset = selectChecksumAsset(release);
    if (checksumAsset) {
      validateDownloadUrl(checksumAsset.browser_download_url);
      assertFreshStageDestination(destination, fs);
      const text = outputText(runCommand(exec, 'curl', githubDownloadCommand(checksumAsset.browser_download_url).slice(1), {
        encoding: 'utf8',
        maxBuffer: MAX_ARCHIVE_BYTES,
      }, plan.platform));
      checksum = {
        algorithm: 'sha256',
        expected: checksumFromManifest(text, asset.name),
        source: `asset:${checksumAsset.name}`,
      };
    }
  }

  assertFreshStageDestination(destination, fs);
  const downloaded = outputBuffer(runCommand(exec, 'curl', githubDownloadCommand(asset.browser_download_url).slice(1), {
    maxBuffer: MAX_ARCHIVE_BYTES,
  }, plan.platform));
  const checksumResult = verifyChecksum(downloaded, checksum);
  if (component.requireVerifiedChecksum && checksumResult.verified !== true) {
    throw installerError(
      `Refusing to stage ${name}: no verified checksum available for ${asset.name}.`,
      'ERR_COMPONENT_CHECKSUM_MISSING',
    );
  }
  const entries = archiveEntries(asset.name, downloaded);
  assertFreshStageDestination(destination, fs);
  if (entries) {
    extractEntries(entries, destination, component, plan, fs);
  } else {
    const path = pathFor(plan.platform);
    fs.mkdirSync(path.join(destination, 'bin'), { recursive: true });
    fs.writeFileSync(plan.binPath, downloaded);
    try {
      fs.chmodSync(plan.binPath, 0o755);
    } catch {}
  }

  return {
    name,
    version: component.version,
    destination,
    binPath: plan.binPath,
    plan,
    asset: { name: asset.name },
    checksum: checksumResult,
  };
}

function assertFreshStageDestination(destination, fs) {
  if (lstatPresence(destination, fs) !== null) {
    throw installerError(
      `Immutable stage destination already exists: ${destination}. Refusing to overwrite an existing staged version.`,
      'ERR_COMPONENT_IMMUTABLE_STAGE_EXISTS',
    );
  }
}

/**
 * The durable completion marker is written as the final step of a successful
 * stage. Its presence is the authoritative signal that a version directory is a
 * complete, immutable stage rather than interrupted debris.
 */
export const STAGE_COMPLETE_MARKER = '.myelin-stage-complete';

function stageCompletionMarkerPath(destination, platform) {
  return pathFor(platform).join(destination, STAGE_COMPLETE_MARKER);
}

/**
 * Reports whether a component version directory carries a valid completion
 * marker. A directory without the marker is treated as an interrupted stage,
 * never as a complete immutable version.
 */
export function isStageComplete(destination, { fs = nodeFs, platform = process.platform } = {}) {
  const resolvedPlatform = normalizePlatform(platform);
  const markerPath = stageCompletionMarkerPath(destination, resolvedPlatform);
  const presence = lstatPresence(markerPath, fs);
  if (presence === null) return false;
  if (typeof presence.isFile === 'function' && !presence.isFile()) return false;
  if (typeof fs.readFileSync === 'function') {
    try {
      const parsed = JSON.parse(String(fs.readFileSync(markerPath, 'utf8')));
      return parsed?.complete === true;
    } catch {
      return false;
    }
  }
  return true;
}

function writeStageCompletionMarker(destination, meta, fs, platform) {
  const markerPath = stageCompletionMarkerPath(destination, platform);
  const payload = JSON.stringify({
    complete: true,
    name: meta.name,
    version: meta.version,
  });
  fs.writeFileSync(markerPath, payload);
  // Best-effort durability: flush the marker and its directory so the completion
  // signal survives a crash. Adapters without fsync support (test doubles) skip.
  if (
    typeof fs.openSync === 'function'
    && typeof fs.fsyncSync === 'function'
    && typeof fs.closeSync === 'function'
  ) {
    for (const target of [markerPath, destination]) {
      try {
        const fd = fs.openSync(target, 'r');
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } catch {}
    }
  }
}

/**
 * Prepares an immutable stage destination. A completed (marked) destination is
 * refused to preserve immutability. An interrupted (marker-less) destination is
 * reclaimed so a retry can rebuild the version cleanly instead of failing
 * permanently.
 */
function prepareStageDestination(destination, fs, platform) {
  if (lstatPresence(destination, fs) === null) return;
  if (isStageComplete(destination, { fs, platform })) {
    throw installerError(
      `Immutable stage destination already exists: ${destination}. Refusing to overwrite an existing staged version.`,
      'ERR_COMPONENT_IMMUTABLE_STAGE_EXISTS',
    );
  }
  if (typeof fs.rmSync !== 'function') {
    throw installerError(
      `Cannot reclaim an incomplete stage destination without fs.rmSync: ${destination}.`,
      'ERR_COMPONENT_STAGE_RECLAIM_UNAVAILABLE',
    );
  }
  fs.rmSync(destination, { recursive: true, force: true });
}

/**
 * Stages a component under its immutable version directory. Activation is
 * intentionally separate and remains the version-store consumer's job.
 */
export function stageComponent({
  name,
  component,
  root,
  platform = process.platform,
  exec = execFileSync,
  fs = nodeFs,
} = {}) {
  if (typeof exec !== 'function') throw new TypeError('exec must be a function.');
  if (!fs || typeof fs !== 'object') throw new TypeError('fs must be an object.');
  const normalizedPlatform = normalizePlatform(platform);
  const versionDirectory = componentVersionDir(root, name, component?.version, pathFor(normalizedPlatform));
  const plan = buildComponentInstallPlan(component, versionDirectory, normalizedPlatform);
  const destination = plan.destination;
  fs.mkdirSync(pathFor(plan.platform).dirname(destination), { recursive: true });
  prepareStageDestination(destination, fs, plan.platform);

  let result;
  if (component.kind === 'github-binary') {
    result = stageGithubBinary({ name, component, destination, plan, exec, fs });
  } else {
    for (const [file, ...args] of plan.commands) {
      runCommand(exec, file, args, { stdio: 'inherit' }, plan.platform);
    }
    result = {
      name,
      version: component.version,
      destination,
      binPath: plan.binPath,
      plan,
    };
  }
  writeStageCompletionMarker(
    destination,
    { name, version: component.version },
    fs,
    plan.platform,
  );
  return result;
}

/**
 * Parses a complete version token without treating a longer version as a
 * prefix match for an immutable manifest pin.
 */
export function parseManagedComponentVersion(raw = '') {
  const text = String(raw);
  const expression = /(?:^|[^0-9A-Za-z])v?(\d+\.\d+\.\d+(?:(?:[-+][0-9A-Za-z.-]+)|(?:\.(?:dev|post|rc|a|b)\d+))?)(?![0-9A-Za-z.-])/gu;
  return expression.exec(text)?.[1] ?? null;
}

/**
 * Executes the binary inside the component's versioned installation directory
 * and reports whether the parsed output exactly matches the manifest pin.
 */
export function detectManagedComponent({
  name,
  component,
  root,
  platform = process.platform,
  exec = execFileSync,
} = {}) {
  if (typeof exec !== 'function') throw new TypeError('exec must be a function.');
  const normalizedPlatform = normalizePlatform(platform);
  const destination = componentVersionDir(root, name, component?.version, pathFor(normalizedPlatform));
  const plan = buildComponentInstallPlan(component, destination, normalizedPlatform);
  const pinnedVersion = component.version;
  if (!plan.binPath) {
    return {
      installed: false,
      version: null,
      path: null,
      parsedVersion: null,
      pinnedVersion,
      pinnedVersionMatches: false,
    };
  }
  try {
    const probe = managedVersionProbe(component, plan);
    const raw = outputText(runCommand(exec, probe.file, probe.args, {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }, plan.platform));
    const version = raw.trim().split(/\r?\n/u)[0]?.trim() || null;
    const parsedVersion = parseManagedComponentVersion(raw);
    return {
      installed: true,
      version,
      path: plan.binPath,
      parsedVersion,
      pinnedVersion,
      pinnedVersionMatches: parsedVersion === pinnedVersion,
    };
  } catch {
    return {
      installed: false,
      version: null,
      path: null,
      parsedVersion: null,
      pinnedVersion,
      pinnedVersionMatches: false,
    };
  }
}
