import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  posix,
  win32,
} from 'node:path';
import { gunzipSync } from 'node:zlib';

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const STABLE_RELEASE_ID = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
// Accept 7–40 hex chars: new activations use full 40-char SHAs; short SHAs
// (7–12 chars) remain valid for existing release IDs created by earlier code.
const MAIN_RELEASE_ID = /^main-[0-9a-f]{7,40}$/iu;

function releaseStoreError(message, code, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function normalizePlatform(platform = process.platform) {
  const raw = typeof platform === 'string'
    ? platform
    : platform?.os ?? platform?.platform;
  const value = String(raw ?? process.platform).toLowerCase();
  if (value === 'windows' || value === 'win32') return 'win32';
  if (value === 'darwin' || value === 'linux') return value;
  throw new TypeError(`unsupported platform: ${value}`);
}

function pathFor(platform, pathImpl) {
  if (pathImpl) {
    for (const method of ['basename', 'dirname', 'isAbsolute', 'join', 'relative', 'resolve']) {
      if (typeof pathImpl[method] !== 'function') {
        throw new TypeError(`pathImpl.${method} must be a function.`);
      }
    }
    return pathImpl;
  }
  return platform === 'win32' ? win32 : posix;
}

function validatePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${label} must be a non-empty path string.`);
  }
  return value;
}

function validateReleaseVersion(version) {
  if (typeof version !== 'string' || !(
    STABLE_RELEASE_ID.test(version) || MAIN_RELEASE_ID.test(version)
  )) {
    throw new TypeError('release version must be a safe stable version or main commit identifier.');
  }
  return version;
}

function lstatPresence(fs, path) {
  if (typeof fs?.lstatSync !== 'function') throw new TypeError('fs.lstatSync must be a function.');
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function statusIsDirectory(status) {
  return typeof status?.isDirectory === 'function' && status.isDirectory();
}

function statusIsFile(status) {
  return typeof status?.isFile === 'function' && status.isFile();
}

function statusIsSymbolicLink(status) {
  return typeof status?.isSymbolicLink === 'function' && status.isSymbolicLink();
}

function confinedPath(root, child, path, label) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, child);
  const fromRoot = path.relative(resolvedRoot, target);
  if (
    fromRoot.length === 0
    || fromRoot === '..'
    || fromRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(fromRoot)
  ) {
    throw releaseStoreError(`Unsafe ${label} path.`, 'ERR_RELEASE_PATH_UNSAFE');
  }
  return target;
}

function releaseDirectory(releasesRoot, version, path) {
  return confinedPath(releasesRoot, validateReleaseVersion(version), path, 'release');
}

function ensureReleaseDirectory(releasesRoot, version, options) {
  const target = releaseDirectory(releasesRoot, version, options.path);
  const status = lstatPresence(options.fs, target);
  if (status === null) {
    throw releaseStoreError(
      `Release version directory does not exist: ${target}`,
      'ERR_RELEASE_TARGET_MISSING',
    );
  }
  if (!statusIsDirectory(status) || statusIsSymbolicLink(status)) {
    throw releaseStoreError(
      `Release version directory is not a real directory: ${target}`,
      'ERR_RELEASE_TARGET_UNSAFE',
    );
  }
  return target;
}

function assertFreshPath(path, fs, label) {
  if (lstatPresence(fs, path) !== null) {
    throw releaseStoreError(
      `${label} already exists and will not be overwritten: ${path}`,
      'ERR_RELEASE_IMMUTABLE_STAGE_EXISTS',
    );
  }
}

function assertRegularFile(fs, path, label) {
  const status = lstatPresence(fs, path);
  if (status === null || !statusIsFile(status) || statusIsSymbolicLink(status)) {
    throw releaseStoreError(`${label} must be a regular file.`, 'ERR_RELEASE_SOURCE_INVALID');
  }
}

function assertRealDirectory(fs, path, label) {
  const status = lstatPresence(fs, path);
  if (status === null || !statusIsDirectory(status) || statusIsSymbolicLink(status)) {
    throw releaseStoreError(`${label} must be a real directory.`, 'ERR_RELEASE_SOURCE_INVALID');
  }
}

function validateSourceTree(root, options) {
  assertRealDirectory(options.fs, root, 'release source');
  if (typeof options.fs.readdirSync !== 'function') {
    throw new TypeError('fs.readdirSync must be a function.');
  }
  for (const entry of options.fs.readdirSync(root, { withFileTypes: true })) {
    const path = options.path.join(root, entry.name);
    const status = lstatPresence(options.fs, path);
    if (status === null || statusIsSymbolicLink(status)) {
      throw releaseStoreError('Release source cannot contain symbolic links.', 'ERR_RELEASE_SOURCE_UNSAFE');
    }
    if (statusIsDirectory(status)) {
      validateSourceTree(path, options);
    } else if (!statusIsFile(status)) {
      throw releaseStoreError('Release source contains an unsupported file type.', 'ERR_RELEASE_SOURCE_UNSAFE');
    }
  }
}

function validatePackage(source, target, options) {
  const packagePath = options.path.join(source, 'package.json');
  assertRegularFile(options.fs, packagePath, 'package.json');
  assertRegularFile(options.fs, options.path.join(source, 'package-lock.json'), 'package-lock.json');
  assertRegularFile(options.fs, options.path.join(source, 'bin', 'myelin'), 'bin/myelin');
  assertRegularFile(
    options.fs,
    options.path.join(source, 'src', 'update', 'component-manifest.mjs'),
    'component manifest',
  );
  assertRegularFile(
    options.fs,
    options.path.join(source, 'test', 'component-manifest.test.mjs'),
    'component manifest test',
  );

  let packageJson;
  try {
    packageJson = JSON.parse(options.fs.readFileSync(packagePath, 'utf8'));
  } catch (cause) {
    throw releaseStoreError(
      `package.json is not valid JSON: ${cause.message}`,
      'ERR_RELEASE_PACKAGE_JSON',
      cause,
    );
  }
  if (
    !packageJson
    || typeof packageJson !== 'object'
    || Array.isArray(packageJson)
    || packageJson.name !== 'myelin'
    || !STABLE_RELEASE_ID.test(packageJson.version)
    || packageJson.bin?.myelin !== './bin/myelin'
  ) {
    throw releaseStoreError('package.json is not a valid Myelin release package.', 'ERR_RELEASE_PACKAGE_INVALID');
  }
  if (target.channel === 'stable' && packageJson.version !== target.version) {
    throw releaseStoreError(
      `Stable release package version ${packageJson.version} does not match ${target.version}.`,
      'ERR_RELEASE_PACKAGE_VERSION',
    );
  }
  return packageJson;
}

function validateTarballUrl(value) {
  if (typeof value !== 'string' || value.includes('\0') || /\s/u.test(value)) {
    throw releaseStoreError('Release tarball URL is invalid.', 'ERR_RELEASE_TARBALL_URL');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw releaseStoreError('Release tarball URL is invalid.', 'ERR_RELEASE_TARBALL_URL');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw releaseStoreError('Release tarball URL is invalid.', 'ERR_RELEASE_TARBALL_URL');
  }
  return value;
}

function validateGitSource(source, target) {
  const commit = source.commit ?? target.commit;
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/iu.test(commit)) {
    throw releaseStoreError('Main release source must contain an exact commit.', 'ERR_RELEASE_MAIN_COMMIT');
  }
  if (target.version !== `main-${commit.toLowerCase()}`) {
    throw releaseStoreError('Main release version does not match its exact commit.', 'ERR_RELEASE_MAIN_COMMIT');
  }

  let url;
  try {
    url = new URL(source.url);
  } catch {
    throw releaseStoreError('Main release source URL is invalid.', 'ERR_RELEASE_GIT_URL');
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'github.com'
    || url.username
    || url.password
    || !url.pathname.endsWith('.git')
  ) {
    throw releaseStoreError('Main release source URL is invalid.', 'ERR_RELEASE_GIT_URL');
  }
  return { url: source.url, commit: commit.toLowerCase() };
}

function sourceForTarget(target) {
  if (target?.source && typeof target.source === 'object' && !Array.isArray(target.source)) {
    return target.source;
  }
  if (target?.tarballUrl) return { type: 'tarball', url: target.tarballUrl };
  if (target?.channel === 'main') {
    return {
      type: 'git',
      url: `https://github.com/${target.repository}.git`,
      commit: target.commit,
    };
  }
  throw releaseStoreError('Release target has no supported source.', 'ERR_RELEASE_SOURCE_MISSING');
}

function safeArchivePath(entryName) {
  if (typeof entryName !== 'string' || entryName.length === 0 || entryName.includes('\0')) {
    throw releaseStoreError('unsafe archive path.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
  }
  const trimmed = entryName.endsWith('/') ? entryName.slice(0, -1) : entryName;
  if (
    trimmed.length === 0
    || trimmed.startsWith('/')
    || trimmed.startsWith('\\')
    || /^[A-Za-z]:/u.test(trimmed)
    || trimmed.includes('\\')
  ) {
    throw releaseStoreError(`unsafe archive path: ${entryName}`, 'ERR_RELEASE_ARCHIVE_UNSAFE');
  }
  const parts = trimmed.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.includes(':'))) {
    throw releaseStoreError(`unsafe archive path: ${entryName}`, 'ERR_RELEASE_ARCHIVE_UNSAFE');
  }
  return parts.join('/');
}

function isZeroBlock(buffer, offset) {
  for (let index = offset; index < offset + 512; index += 1) {
    if (buffer[index] !== 0) return false;
  }
  return true;
}

function boundedSlice(buffer, offset, length, label) {
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || offset + length > buffer.length
  ) {
    throw releaseStoreError(`truncated ${label}.`, 'ERR_RELEASE_ARCHIVE_UNSAFE');
  }
  return buffer.subarray(offset, offset + length);
}

function readTarString(header, offset, length) {
  const field = boundedSlice(header, offset, length, 'tar header');
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator === -1 ? field.length : terminator).toString('utf8');
}

function readTarSize(header) {
  const raw = readTarString(header, 124, 12).trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/u.test(raw)) {
    throw releaseStoreError('tar entry size is invalid.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
  }
  const size = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(size)) {
    throw releaseStoreError('tar entry size is invalid.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
  }
  return size;
}

function paxPathAttribute(data) {
  let offset = 0;
  let path = null;
  while (offset < data.length) {
    const separator = data.indexOf(0x20, offset);
    if (separator <= offset) {
      throw releaseStoreError('PAX archive header is invalid.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
    }
    const lengthText = data.subarray(offset, separator).toString('ascii');
    if (!/^[0-9]+$/u.test(lengthText)) {
      throw releaseStoreError('PAX archive header is invalid.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
    }
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || length <= separator - offset + 1 || offset + length > data.length) {
      throw releaseStoreError('PAX archive header is invalid.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
    }
    const record = data.subarray(separator + 1, offset + length);
    if (record.at(-1) !== 0x0a) {
      throw releaseStoreError('PAX archive header is invalid.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
    }
    const equals = record.indexOf(0x3d);
    if (equals <= 0) {
      throw releaseStoreError('PAX archive header is invalid.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
    }
    if (record.subarray(0, equals).toString('utf8') === 'path') {
      path = record.subarray(equals + 1, -1).toString('utf8');
    }
    offset += length;
  }
  return path;
}

function parseTarGzip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_ARCHIVE_BYTES) {
    throw releaseStoreError('archive exceeds the maximum safe size.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
  }

  let tar;
  try {
    tar = gunzipSync(buffer, { maxOutputLength: MAX_ARCHIVE_BYTES });
  } catch (cause) {
    throw releaseStoreError(`invalid gzip archive: ${cause.message}`, 'ERR_RELEASE_ARCHIVE_UNSAFE', cause);
  }
  if (tar.length > MAX_ARCHIVE_BYTES) {
    throw releaseStoreError('archive exceeds the maximum safe size.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
  }

  const entries = [];
  let offset = 0;
  let totalSize = 0;
  let nextPath = null;
  while (offset < tar.length) {
    if (offset + 512 > tar.length) {
      throw releaseStoreError('truncated tar header.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
    }
    if (isZeroBlock(tar, offset)) break;

    const header = tar.subarray(offset, offset + 512);
    const prefix = readTarString(header, 345, 155);
    const name = readTarString(header, 0, 100);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const size = readTarSize(header);
    if (size > MAX_ARCHIVE_BYTES - totalSize) {
      throw releaseStoreError('archive exceeds the maximum safe size.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
    }
    totalSize += size;

    const dataOffset = offset + 512;
    const data = boundedSlice(tar, dataOffset, size, 'tar entry');
    offset = dataOffset + Math.ceil(size / 512) * 512;
    if (type === 'g') continue;
    if (type === 'x') {
      nextPath = paxPathAttribute(data);
      continue;
    }

    const path = safeArchivePath(nextPath ?? (prefix ? `${prefix}/${name}` : name));
    nextPath = null;
    if (type === '0') {
      entries.push({ type: 'file', path, data });
    } else if (type === '5') {
      if (size !== 0) {
        throw releaseStoreError('tar directory entry has content.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
      }
      entries.push({ type: 'directory', path });
    } else {
      throw releaseStoreError(`unsupported tar entry type for ${path}.`, 'ERR_RELEASE_ARCHIVE_UNSAFE');
    }
  }
  return entries;
}

function stripArchiveRoot(entries) {
  const roots = new Set(entries.map((entry) => entry.path.split('/')[0]));
  if (roots.size !== 1 || !entries.some((entry) => entry.path.includes('/'))) return entries;

  const root = [...roots][0];
  const rootEntry = entries.find((entry) => entry.path === root);
  if (rootEntry && rootEntry.type !== 'directory') {
    throw releaseStoreError(
      `archive file shadows a directory: ${root}.`,
      'ERR_RELEASE_ARCHIVE_UNSAFE',
    );
  }
  return entries.flatMap((entry) => {
    if (entry.path === root) return [];
    return [{ ...entry, path: safeArchivePath(entry.path.slice(root.length + 1)) }];
  });
}

function uniqueArchiveEntries(entries) {
  const byPath = new Map();
  for (const entry of entries) {
    if (byPath.has(entry.path)) {
      throw releaseStoreError(`archive contains duplicate path: ${entry.path}.`, 'ERR_RELEASE_ARCHIVE_UNSAFE');
    }
    byPath.set(entry.path, entry);
  }
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let length = 1; length < parts.length; length += 1) {
      const parent = parts.slice(0, length).join('/');
      if (byPath.get(parent)?.type === 'file') {
        throw releaseStoreError(
          `archive file shadows a directory: ${entry.path}.`,
          'ERR_RELEASE_ARCHIVE_UNSAFE',
        );
      }
    }
  }
  return entries;
}

function extractionPath(destination, entryPath, path) {
  const target = path.resolve(destination, ...entryPath.split('/'));
  const fromRoot = path.relative(path.resolve(destination), target);
  if (
    fromRoot.length === 0
    || fromRoot === '..'
    || fromRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(fromRoot)
  ) {
    throw releaseStoreError(`unsafe archive path: ${entryPath}`, 'ERR_RELEASE_ARCHIVE_UNSAFE');
  }
  return target;
}

function extractTarGzip(buffer, destination, { fs, path }) {
  const entries = uniqueArchiveEntries(stripArchiveRoot(parseTarGzip(buffer)));
  if (entries.length === 0) {
    throw releaseStoreError('archive is empty.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
  }
  for (const entry of entries) extractionPath(destination, entry.path, path);

  fs.mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const target = extractionPath(destination, entry.path, path);
    if (entry.type === 'directory') {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
  }
}

function declaredArchiveLength(response) {
  const raw = response?.headers?.get?.('content-length');
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !/^[0-9]+$/u.test(raw)) {
    throw releaseStoreError('Release tarball content length is invalid.', 'ERR_RELEASE_TARBALL_DOWNLOAD');
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) {
    throw releaseStoreError('Release tarball content length is invalid.', 'ERR_RELEASE_TARBALL_DOWNLOAD');
  }
  return length;
}

async function responseArchiveBuffer(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) {
    if (typeof response?.arrayBuffer !== 'function') {
      throw releaseStoreError('Release tarball response is invalid.', 'ERR_RELEASE_TARBALL_DOWNLOAD');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ARCHIVE_BYTES) {
      throw releaseStoreError('archive exceeds the maximum safe size.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
    }
    return buffer;
  }

  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (chunk.length > MAX_ARCHIVE_BYTES - total) {
        await reader.cancel?.();
        throw releaseStoreError('archive exceeds the maximum safe size.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
      }
      total += chunk.length;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock?.();
  }
}

async function archiveBuffer(source, fetch) {
  if (Buffer.isBuffer(source.data)) return source.data;
  if (source.data instanceof Uint8Array) return Buffer.from(source.data);
  const url = validateTarballUrl(source.url);
  if (typeof fetch !== 'function') throw new TypeError('fetch must be a function for tarball staging.');

  const response = await fetch(url);
  if (!response?.ok) {
    throw releaseStoreError(
      `Unable to download release tarball (${response?.status ?? 'request failed'}).`,
      'ERR_RELEASE_TARBALL_DOWNLOAD',
    );
  }
  if (declaredArchiveLength(response) > MAX_ARCHIVE_BYTES) {
    throw releaseStoreError('archive exceeds the maximum safe size.', 'ERR_RELEASE_ARCHIVE_UNSAFE');
  }
  return responseArchiveBuffer(response);
}

function safeWindowsCmdArgument(value) {
  if (
    typeof value !== 'string'
    || value.includes('\0')
    || /[%!^&|<>()"\r\n]/u.test(value)
  ) {
    throw releaseStoreError('unsafe Windows command argument.', 'ERR_RELEASE_COMMAND_UNSAFE');
  }
  return `"${value}"`;
}

function runCommand(exec, file, args, options, platform) {
  if (platform !== 'win32' || file !== 'npm') return exec(file, args, options);
  const command = [file, ...args.map(safeWindowsCmdArgument)].join(' ');
  return exec('cmd.exe', ['/d', '/s', '/c', command], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

async function populateStage(source, target, staging, options) {
  switch (source.type) {
    case 'directory': {
      const directory = validatePath(source.path, 'release source path');
      validateSourceTree(directory, options);
      if (typeof options.fs.cpSync !== 'function') throw new TypeError('fs.cpSync must be a function.');
      options.fs.cpSync(directory, staging, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      });
      return;
    }
    case 'tarball': {
      const buffer = await archiveBuffer(source, options.fetch);
      await options.extract(buffer, staging, options);
      return;
    }
    case 'git': {
      const { url, commit } = validateGitSource(source, target);
      await options.exec(
        'git',
        ['clone', '--no-checkout', '--', url, staging],
        { stdio: 'inherit' },
      );
      await options.exec(
        'git',
        ['-C', staging, 'checkout', '--detach', commit],
        { stdio: 'inherit' },
      );
      return;
    }
    default:
      throw releaseStoreError('Release source type is unsupported.', 'ERR_RELEASE_SOURCE_MISSING');
  }
}

function normalizeStageOptions(input) {
  const platform = normalizePlatform(input.platform);
  const path = pathFor(platform, input.pathImpl);
  const releasesRoot = validatePath(input.releasesRoot, 'releasesRoot');
  const target = input.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError('target must be an object.');
  }
  const version = validateReleaseVersion(target.version);
  if (typeof input.exec !== 'function') throw new TypeError('exec must be a function.');
  if (typeof input.nodeExecPath !== 'string' || !input.nodeExecPath) throw new TypeError('nodeExecPath must be a non-empty string.');
  if (!isAbsolute(input.nodeExecPath)) throw new TypeError('nodeExecPath must be an absolute path.');
  if (!input.fs || typeof input.fs !== 'object') throw new TypeError('fs must be an object.');
  if (typeof input.extract !== 'function') throw new TypeError('extract must be a function.');

  const resolvedRoot = path.resolve(releasesRoot);
  const destination = releaseDirectory(resolvedRoot, version, path);
  const staging = confinedPath(resolvedRoot, `.${version}.staging`, path, 'release staging');
  return {
    ...input,
    target,
    version,
    platform,
    path,
    releasesRoot: resolvedRoot,
    destination,
    staging,
  };
}

/**
 * Stages a release under its immutable version directory. It never mutates
 * the active or previous release pointer.
 */
/**
 * Reuses an existing immutable release directory when it is already a complete,
 * valid stage of the requested version (e.g. staged before a rolled-back
 * update). A present-but-invalid destination is interrupted debris and is
 * removed so staging can rebuild it cleanly.
 */
function reuseStagedRelease(options) {
  if (lstatPresence(options.fs, options.destination) === null) return null;
  try {
    assertRealDirectory(options.fs, options.destination, 'release destination');
    validateSourceTree(options.destination, options);
    const packageJson = validatePackage(options.destination, options.target, options);
    return {
      version: options.version,
      directory: options.destination,
      packageVersion: packageJson.version,
    };
  } catch {
    options.fs.rmSync(options.destination, { recursive: true, force: true });
    return null;
  }
}

export async function stageRelease({
  target,
  releasesRoot,
  exec = execFileSync,
  fs = nodeFs,
  fetch = globalThis.fetch,
  extract = extractTarGzip,
  platform = process.platform,
  pathImpl,
  nodeExecPath = process.execPath,
} = {}) {
  const options = normalizeStageOptions({
    target,
    releasesRoot,
    exec,
    fs,
    fetch,
    extract,
    platform,
    pathImpl,
    nodeExecPath,
  });
  const source = sourceForTarget(options.target);

  options.fs.mkdirSync(options.releasesRoot, { recursive: true });
  const reused = reuseStagedRelease(options);
  if (reused) return reused;
  if (lstatPresence(options.fs, options.staging) !== null) {
    options.fs.rmSync(options.staging, { recursive: true, force: true });
  }
  assertFreshPath(options.destination, options.fs, 'Release destination');
  assertFreshPath(options.staging, options.fs, 'Release staging directory');

  try {
    await populateStage(source, options.target, options.staging, options);
    validateSourceTree(options.staging, options);
    const packageJson = validatePackage(options.staging, options.target, options);

    // Prepend the running node's bin dir to PATH so that npm's shebang
    // (#!/usr/bin/env node) resolves the same node that launched myelin,
    // regardless of whether the shell loaded NVM, mise, Homebrew, etc.
    const nodeBinDir = dirname(options.nodeExecPath);
    const pathSep = options.platform === 'win32' ? ';' : ':';
    // On Windows, the env key may be 'Path' rather than 'PATH' — find it
    // case-insensitively so we don't create duplicate keys in the child env.
    const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
    const existingPath = process.env[pathKey] ?? '';
    const inPath = options.platform === 'win32'
      ? existingPath.split(pathSep).some(e => e.toLowerCase() === nodeBinDir.toLowerCase())
      : existingPath.split(pathSep).includes(nodeBinDir);
    const subprocessPath = inPath
      ? existingPath
      : (existingPath ? `${nodeBinDir}${pathSep}${existingPath}` : nodeBinDir);
    const subprocessEnv = { ...process.env, [pathKey]: subprocessPath };

    await runCommand(
      options.exec,
      'npm',
      ['ci', '--ignore-scripts=false'],
      { cwd: options.staging, stdio: 'inherit', env: subprocessEnv },
      options.platform,
    );
    await runCommand(
      options.exec,
      'node',
      ['bin/myelin', '--version'],
      { cwd: options.staging, stdio: 'inherit', env: subprocessEnv },
      options.platform,
    );
    await runCommand(
      options.exec,
      'node',
      ['--test', 'test/component-manifest.test.mjs'],
      { cwd: options.staging, stdio: 'inherit', env: subprocessEnv },
      options.platform,
    );

    assertFreshPath(options.destination, options.fs, 'Release destination');
    options.fs.renameSync(options.staging, options.destination);
    return {
      version: options.version,
      directory: options.destination,
      packageVersion: packageJson.version,
    };
  } catch (error) {
    options.fs.rmSync(options.staging, { recursive: true, force: true });
    throw error;
  }
}

function normalizeWindowsJunctionTarget(rawTarget) {
  const extendedPrefix = '\\\\?\\';
  const extendedUncPrefix = '\\\\?\\UNC\\';
  if (rawTarget.startsWith(extendedUncPrefix)) return `\\\\${rawTarget.slice(extendedUncPrefix.length)}`;
  if (rawTarget.startsWith(extendedPrefix)) return rawTarget.slice(extendedPrefix.length);
  return rawTarget;
}

function inspectPointer(options, pointer) {
  const path = options.path.join(options.home, pointer);
  const status = lstatPresence(options.fs, path);
  if (status === null) return { present: false, path };

  let rawTarget;
  try {
    rawTarget = options.fs.readlinkSync(path);
  } catch (cause) {
    throw releaseStoreError(
      `Refusing to operate on non-link release pointer: ${path}`,
      'ERR_RELEASE_POINTER_UNSAFE',
      cause,
    );
  }
  if (typeof rawTarget !== 'string' || rawTarget.includes('\0')) {
    throw releaseStoreError('Release pointer target is invalid.', 'ERR_RELEASE_POINTER_UNSAFE');
  }
  return { present: true, path, rawTarget };
}

function pointerVersion(options, pointer) {
  const artifact = inspectPointer(options, pointer);
  if (!artifact.present) return null;

  const rawTarget = options.platform === 'win32'
    ? normalizeWindowsJunctionTarget(artifact.rawTarget)
    : artifact.rawTarget;
  const target = options.path.resolve(options.home, rawTarget);
  const fromRoot = options.path.relative(options.releasesRoot, target);
  if (
    fromRoot.length === 0
    || options.path.isAbsolute(fromRoot)
    || fromRoot.includes('/')
    || fromRoot.includes('\\')
  ) {
    throw releaseStoreError(
      `Release pointer is not confined to releases: ${artifact.path}`,
      'ERR_RELEASE_POINTER_EXTERNAL',
    );
  }
  const version = validateReleaseVersion(fromRoot);
  if (target !== releaseDirectory(options.releasesRoot, version, options.path)) {
    throw releaseStoreError('Release pointer target is malformed.', 'ERR_RELEASE_POINTER_EXTERNAL');
  }
  ensureReleaseDirectory(options.releasesRoot, version, options);
  return version;
}

function quoteWindowsJunctionPath(value) {
  if (
    typeof value !== 'string'
    || value.includes('\0')
    || /[%!^&|<>()"\r\n]/u.test(value)
  ) {
    throw releaseStoreError(
      'Windows junction paths contain an unsafe CMD metacharacter.',
      'ERR_RELEASE_POINTER_UNSAFE',
    );
  }
  return `"${value}"`;
}

function createWindowsJunction(pointer, target, runCommand) {
  const command = `mklink /J ${quoteWindowsJunctionPath(pointer)} ${quoteWindowsJunctionPath(target)}`;
  runCommand('cmd.exe', ['/d', '/s', '/c', command], {
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
}

function temporaryPointerPath(options, pointer) {
  return options.path.join(options.home, `${pointer}.new`);
}

function backupPointerPath(options, pointer) {
  return options.path.join(options.home, `${pointer}.old`);
}

function createPointer(options, pointer, version, label) {
  const destination = options.path.join(options.home, pointer);
  assertFreshPath(destination, options.fs, label);
  const target = ensureReleaseDirectory(options.releasesRoot, version, options);

  if (options.platform === 'win32') {
    if (options.createJunction) {
      options.createJunction(destination, target);
    } else {
      createWindowsJunction(destination, target, options.runCommand);
    }
  } else {
    options.fs.symlinkSync(options.path.relative(options.home, target), destination, 'dir');
  }

  if (pointerVersion(options, pointer) !== version) {
    throw releaseStoreError('New release pointer targets the wrong release.', 'ERR_RELEASE_POINTER_UNSAFE');
  }
}

function createTemporaryPointer(options, pointer, version) {
  createPointer(options, `${pointer}.new`, version, 'Release temporary pointer');
}

function createBackupPointer(options, pointer, version) {
  createPointer(options, `${pointer}.old`, version, 'Release backup pointer');
}

function removePointer(options, pointerPath) {
  const artifact = inspectPointer(options, options.path.basename(pointerPath));
  if (!artifact.present) return;
  const pointer = options.path.basename(pointerPath);
  pointerVersion(options, pointer);
  options.fs.rmSync(pointerPath, { recursive: true, force: false });
}

function normalizePointerOptions(input) {
  const platform = normalizePlatform(input.platform);
  const path = pathFor(platform, input.pathImpl);
  const releasesRoot = path.resolve(validatePath(input.releasesRoot, 'releasesRoot'));
  if (!input.fs || typeof input.fs !== 'object') throw new TypeError('fs must be an object.');
  if (typeof input.runCommand !== 'function') throw new TypeError('runCommand must be a function.');
  return {
    ...input,
    platform,
    path,
    releasesRoot,
    home: path.dirname(releasesRoot),
  };
}

function normalizeActivationOptions(input) {
  return {
    ...normalizePointerOptions(input),
    version: validateReleaseVersion(input.version),
  };
}

function validateReleasePair(pointers, label = 'pointers') {
  if (typeof pointers !== 'object' || pointers === null || Array.isArray(pointers)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const pair = {};
  for (const pointer of ['current', 'previous']) {
    if (!Object.hasOwn(pointers, pointer)) {
      throw new TypeError(`${label}.${pointer} is required.`);
    }
    const value = pointers[pointer];
    if (value !== null && typeof value !== 'string') {
      throw new TypeError(`${label}.${pointer} must be a string or null.`);
    }
    pair[pointer] = value === null ? null : validateReleaseVersion(value);
  }
  return pair;
}

function sameReleasePair(left, right) {
  return left.current === right.current && left.previous === right.previous;
}

function restorePointers(options, state) {
  let rollbackError;
  for (const pointer of state.installed) {
    try {
      removePointer(options, options.path.join(options.home, pointer));
    } catch (error) {
      rollbackError ??= error;
    }
  }
  for (const pointer of state.parked) {
    const backup = backupPointerPath(options, pointer);
    try {
      if (lstatPresence(options.fs, backup) !== null) {
        if (lstatPresence(options.fs, options.path.join(options.home, pointer)) !== null) {
          throw releaseStoreError('Cannot restore release pointer over an existing artifact.', 'ERR_RELEASE_ROLLBACK');
        }
        pointerVersion(options, `${pointer}.old`);
        options.fs.renameSync(backup, options.path.join(options.home, pointer));
      }
    } catch (error) {
      rollbackError ??= error;
    }
  }
  for (const [pointer, version] of state.snapshots) {
    const backup = backupPointerPath(options, pointer);
    try {
      if (lstatPresence(options.fs, backup) === null) continue;
      const actual = pointerVersion(options, pointer);
      if (actual === null) {
        options.fs.renameSync(backup, options.path.join(options.home, pointer));
      } else if (actual === version) {
        removePointer(options, backup);
      } else {
        throw releaseStoreError('Cannot restore release pointer over a changed pointer.', 'ERR_RELEASE_ROLLBACK');
      }
    } catch (error) {
      rollbackError ??= error;
    }
  }
  for (const pointer of state.created) {
    try {
      removePointer(options, temporaryPointerPath(options, pointer));
    } catch (error) {
      rollbackError ??= error;
    }
  }
  return rollbackError;
}

/**
 * Switches current and previous release pointers. POSIX uses directory
 * symlinks; Windows uses injected or default junction creation.
 */
export function activateRelease({
  releasesRoot,
  version,
  platform = process.platform,
  fs = nodeFs,
  createJunction,
  runCommand = execFileSync,
  pathImpl,
} = {}) {
  const options = normalizeActivationOptions({
    releasesRoot,
    version,
    platform,
    fs,
    createJunction,
    runCommand,
    pathImpl,
  });
  ensureReleaseDirectory(options.releasesRoot, options.version, options);
  const current = pointerVersion(options, 'current');
  const previous = pointerVersion(options, 'previous');
  if (current === options.version) return { current, previous };

  for (const pointer of ['current', 'previous']) {
    assertFreshPath(temporaryPointerPath(options, pointer), options.fs, 'Release temporary pointer');
    assertFreshPath(backupPointerPath(options, pointer), options.fs, 'Release backup pointer');
  }

  const desired = { current: options.version, previous: current };
  const state = { created: [], parked: [], installed: [], snapshots: new Map() };
  try {
    for (const pointer of ['current', 'previous']) {
      if (desired[pointer] !== null) {
        state.created.push(pointer);
        createTemporaryPointer(options, pointer, desired[pointer]);
      }
    }

    if (options.platform !== 'win32' && current !== null) {
      state.snapshots.set('current', current);
      createBackupPointer(options, 'current', current);
    }

    for (const pointer of ['current', 'previous']) {
      const actual = pointerVersion(options, pointer);
      if (actual !== (pointer === 'current' ? current : previous)) {
        throw releaseStoreError('Release pointer changed during activation.', 'ERR_RELEASE_POINTER_STALE');
      }
      if (options.platform !== 'win32' && pointer === 'current') continue;
      if (actual !== null) {
        options.fs.renameSync(
          options.path.join(options.home, pointer),
          backupPointerPath(options, pointer),
        );
        state.parked.push(pointer);
      }
    }

    for (const pointer of ['current', 'previous']) {
      if (desired[pointer] !== null) {
        options.fs.renameSync(
          temporaryPointerPath(options, pointer),
          options.path.join(options.home, pointer),
        );
        state.installed.push(pointer);
      }
    }
  } catch (error) {
    const rollbackError = restorePointers(options, state);
    if (rollbackError) error.rollbackError = rollbackError;
    throw error;
  }

  for (const pointer of state.parked) {
    try {
      removePointer(options, backupPointerPath(options, pointer));
    } catch {}
  }
  for (const pointer of state.snapshots.keys()) {
    try {
      removePointer(options, backupPointerPath(options, pointer));
    } catch {}
  }
  return desired;
}

/**
 * Reads both release pointers as an exact pair. Unlike activation, this does
 * not infer `previous` from `current`, so callers can journal a rollback
 * snapshot without losing an older previous release.
 */
export function readReleasePointers({
  releasesRoot,
  platform = process.platform,
  fs = nodeFs,
  createJunction,
  runCommand = execFileSync,
  pathImpl,
} = {}) {
  const options = normalizePointerOptions({
    releasesRoot,
    platform,
    fs,
    createJunction,
    runCommand,
    pathImpl,
  });
  return {
    current: pointerVersion(options, 'current'),
    previous: pointerVersion(options, 'previous'),
  };
}

function removeExactPointer(options, pointer) {
  const path = options.path.join(options.home, pointer);
  if (lstatPresence(options.fs, path) === null) return;
  removePointer(options, path);
}

function recoverReleaseTransactionArtifacts(options) {
  for (const pointer of ['current', 'previous']) {
    for (const suffix of ['new', 'old']) {
      // Every artifact is validated by removePointer before removal. Release
      // directories are immutable, so a global transaction journal can safely
      // recreate the exact desired pair after an interrupted pointer switch.
      removeExactPointer(options, `${pointer}.${suffix}`);
    }
  }
}

function restoreExactReleasePair(options, before, desired) {
  const state = {
    temporary: [],
    backups: [],
    installed: [],
  };

  try {
    for (const pointer of ['current', 'previous']) {
      if (desired[pointer] === null) continue;
      state.temporary.push(pointer);
      createTemporaryPointer(options, pointer, desired[pointer]);
    }

    for (const pointer of ['current', 'previous']) {
      if (before[pointer] === null) continue;
      const live = options.path.join(options.home, pointer);
      const backup = backupPointerPath(options, pointer);
      if (options.platform === 'win32') {
        options.fs.renameSync(live, backup);
      } else {
        createBackupPointer(options, pointer, before[pointer]);
      }
      state.backups.push(pointer);
    }

    for (const pointer of ['current', 'previous']) {
      const live = options.path.join(options.home, pointer);
      if (desired[pointer] !== null) {
        options.fs.renameSync(temporaryPointerPath(options, pointer), live);
        state.installed.push(pointer);
      } else if (before[pointer] !== null && options.platform !== 'win32') {
        removeExactPointer(options, pointer);
      }
    }
  } catch (error) {
    let rollbackError;
    for (const pointer of [...state.installed].reverse()) {
      try {
        removeExactPointer(options, pointer);
      } catch (cause) {
        rollbackError ??= cause;
      }
    }
    for (const pointer of [...state.backups].reverse()) {
      const live = options.path.join(options.home, pointer);
      const backup = backupPointerPath(options, pointer);
      try {
        if (lstatPresence(options.fs, backup) === null) continue;
        if (lstatPresence(options.fs, live) === null) {
          options.fs.renameSync(backup, live);
        } else if (pointerVersion(options, pointer) === before[pointer]) {
          removeExactPointer(options, `${pointer}.old`);
        } else {
          throw releaseStoreError(
            'Cannot restore release pointer over a changed pointer.',
            'ERR_RELEASE_ROLLBACK',
          );
        }
      } catch (cause) {
        rollbackError ??= cause;
      }
    }
    for (const pointer of state.temporary) {
      try {
        removeExactPointer(options, `${pointer}.new`);
      } catch (cause) {
        rollbackError ??= cause;
      }
    }
    if (rollbackError) error.rollbackError = rollbackError;
    throw error;
  }

  for (const pointer of state.backups) {
    try {
      removeExactPointer(options, `${pointer}.old`);
    } catch {}
  }
  return desired;
}

/**
 * Restores or repairs an exact release pair. This is deliberately separate
 * from `activateRelease()`, whose normal update behavior sets previous to the
 * former current release.
 */
export function restoreRelease({
  releasesRoot,
  pointers,
  platform = process.platform,
  fs = nodeFs,
  createJunction,
  runCommand = execFileSync,
  pathImpl,
} = {}) {
  const desired = validateReleasePair(pointers);
  const options = normalizePointerOptions({
    releasesRoot,
    platform,
    fs,
    createJunction,
    runCommand,
    pathImpl,
  });
  for (const version of Object.values(desired)) {
    if (version !== null) ensureReleaseDirectory(options.releasesRoot, version, options);
  }
  recoverReleaseTransactionArtifacts(options);
  const recoveredBefore = {
    current: pointerVersion(options, 'current'),
    previous: pointerVersion(options, 'previous'),
  };
  if (sameReleasePair(recoveredBefore, desired)) return recoveredBefore;

  for (const pointer of ['current', 'previous']) {
    assertFreshPath(temporaryPointerPath(options, pointer), options.fs, 'Release temporary pointer');
    assertFreshPath(backupPointerPath(options, pointer), options.fs, 'Release backup pointer');
  }
  return restoreExactReleasePair(options, recoveredBefore, desired);
}

function shellQuote(value) {
  if (typeof value !== 'string' || value.includes('\0') || /[\r\n]/u.test(value)) {
    throw new TypeError('home must be a single-line path string.');
  }
  return `'${value.replace(/'/gu, `'\"'\"'`)}'`;
}

function posixLauncher(home) {
  return `#!/bin/sh
set -eu
myelin_home=${shellQuote(join(home, '.myelin'))}
entry="$myelin_home/current/bin/myelin"
if [ ! -f "$entry" ]; then
  printf '%s\\n' 'No managed Myelin release is active. Run: myelin update --channel main' >&2
  exit 1
fi
exec "$entry" "$@"
`;
}

function windowsCommandLauncher() {
  return `@echo off
setlocal DisableDelayedExpansion
set "MYELIN_HOME=%~dp0.."
set "MYELIN_ENTRY=%MYELIN_HOME%\\current\\bin\\myelin"
if not exist "%MYELIN_ENTRY%" (
  >&2 echo No managed Myelin release is active. Run: myelin update --channel main
  exit /b 1
)
node "%MYELIN_ENTRY%" %*
`;
}

function windowsPowerShellLauncher() {
  return `$ErrorActionPreference = 'Stop'
$myelinHome = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $myelinHome 'current\\bin\\myelin'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
  Write-Error 'No managed Myelin release is active. Run: myelin update --channel main'
  exit 1
}
& node $entry @args
exit $LASTEXITCODE
`;
}

/**
 * Installs launcher files only under the supplied home directory. Launchers
 * resolve the current pointer when invoked, so activation requires no rewrite.
 */
export function installStableLauncher({
  home,
  platform = process.platform,
  fs = nodeFs,
  pathImpl,
} = {}) {
  const normalizedPlatform = normalizePlatform(platform);
  const path = pathFor(normalizedPlatform, pathImpl);
  validatePath(home, 'home');
  if (!fs || typeof fs !== 'object') throw new TypeError('fs must be an object.');
  if (typeof fs.mkdirSync !== 'function' || typeof fs.writeFileSync !== 'function') {
    throw new TypeError('fs must support mkdirSync and writeFileSync.');
  }
  if (normalizedPlatform !== 'win32' && typeof fs.chmodSync !== 'function') {
    throw new TypeError('fs.chmodSync must be a function for POSIX launchers.');
  }

  const binDir = path.join(home, '.myelin', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  if (normalizedPlatform === 'win32') {
    const commandLauncher = path.join(binDir, 'myelin.cmd');
    const powerShellLauncher = path.join(binDir, 'myelin.ps1');
    fs.writeFileSync(commandLauncher, windowsCommandLauncher(), 'utf8');
    fs.writeFileSync(powerShellLauncher, windowsPowerShellLauncher(), 'utf8');
    return { binDir, commandLauncher, powerShellLauncher };
  }

  const launcher = path.join(binDir, 'myelin');
  fs.writeFileSync(launcher, posixLauncher(home), 'utf8');
  fs.chmodSync(launcher, 0o755);
  return { binDir, launcher };
}
