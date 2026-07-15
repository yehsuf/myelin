import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

const POINTER_NAMES = Object.freeze(['current', 'previous']);
const JOURNAL_FILE = '.pointer-store-journal.json';
const JOURNAL_TEMP_FILE = '.pointer-store-journal.json.new';
const LOCK_DIRECTORY = '.pointer-store.lock';
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_RECLAIM_FILE = '.reclaim';
const JOURNAL_SCHEMA_VERSION = 1;
const BACKSLASH = '\\';
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const RESERVED_TOKENS = new Set([
  ...POINTER_NAMES,
  ...POINTER_NAMES.map((pointer) => `${pointer}.new`),
  ...POINTER_NAMES.map((pointer) => `${pointer}.old`),
  JOURNAL_FILE,
  JOURNAL_TEMP_FILE,
  LOCK_DIRECTORY,
]);

function componentStoreError(message, code, metadata, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  if (metadata !== undefined) error.componentStore = metadata;
  return error;
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function validateRoot(root) {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) {
    throw new TypeError('root must be a non-empty path string.');
  }
  return root;
}

function validateToken(value, label) {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value) || RESERVED_TOKENS.has(value)) {
    throw new TypeError(`${label} must be a safe token and not a reserved staging name.`);
  }
  return value;
}

function validateName(name) {
  return validateToken(name, 'name');
}

function validateVersion(version, label = 'version') {
  return validateToken(version, label);
}

function validatePair(pointers, label = 'pointers') {
  if (typeof pointers !== 'object' || pointers === null || Array.isArray(pointers)) {
    throw new TypeError(`${label} must be an object.`);
  }

  const pair = {};
  for (const pointer of POINTER_NAMES) {
    if (!(pointer in pointers)) {
      throw new TypeError(`${label}.${pointer} is required.`);
    }
    const value = pointers[pointer];
    if (value !== null && typeof value !== 'string') {
      throw new TypeError(`${label}.${pointer} must be a string or null.`);
    }
    pair[pointer] = value === null ? null : validateVersion(value, `${label}.${pointer}`);
  }
  return pair;
}

function samePair(left, right) {
  return POINTER_NAMES.every((pointer) => left[pointer] === right[pointer]);
}

function componentDirectory(root, name) {
  return join(root, name);
}

function resolvedComponentDirectory(root, name) {
  return resolve(root, name);
}

function resolvedVersionDirectory(root, name, version) {
  return resolve(root, name, version);
}

export function componentVersionDir(root, name, version, pathModule = { join }) {
  validateRoot(root);
  validateName(name);
  validateVersion(version);
  return pathModule.join(root, name, version);
}

function pointerPath(options, pointer) {
  return join(options.componentDir, pointer);
}

function temporaryPointerPath(options, pointer) {
  return pointerPath(options, `${pointer}.new`);
}

function backupPointerPath(options, pointer) {
  return pointerPath(options, `${pointer}.old`);
}

function journalPath(options) {
  return join(options.componentDir, JOURNAL_FILE);
}

function journalTemporaryPath(options) {
  return join(options.componentDir, JOURNAL_TEMP_FILE);
}

function lockPath(options) {
  return join(options.componentDir, LOCK_DIRECTORY);
}

function lstatPresence(path, fs) {
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

function componentDirectoryPresent(options, { allowMissing = false } = {}) {
  const status = lstatPresence(options.componentDir, options.fs);
  if (status === null) {
    if (allowMissing) return false;
    throw componentStoreError(
      `Component directory does not exist: ${options.componentDir}`,
      'ERR_COMPONENT_DIRECTORY_MISSING',
    );
  }

  if (!statusIsDirectory(status) || statusIsSymbolicLink(status)) {
    throw componentStoreError(
      `Component directory must be a real directory: ${options.componentDir}`,
      'ERR_COMPONENT_DIRECTORY_UNSAFE',
    );
  }
  return true;
}

function targetDirectory(options, version) {
  return resolvedVersionDirectory(options.root, options.name, version);
}

function ensureTargetDirectory(options, version) {
  const target = targetDirectory(options, version);
  const lstat = lstatPresence(target, options.fs);
  if (lstat === null) {
    throw componentStoreError(
      `Component target version directory does not exist: ${target}`,
      'ERR_COMPONENT_TARGET_MISSING',
      { target, version },
    );
  }

  if (!statusIsDirectory(lstat) || statusIsSymbolicLink(lstat)) {
    throw componentStoreError(
      `Component target version directory is not a real directory: ${target}`,
      'ERR_COMPONENT_TARGET_UNSAFE',
      { target, version },
    );
  }

  try {
    const stat = options.fs.statSync(target);
    if (!statusIsDirectory(stat)) {
      throw componentStoreError(
        `Component target version directory is not a directory: ${target}`,
        'ERR_COMPONENT_TARGET_UNSAFE',
        { target, version },
      );
    }
  } catch (error) {
    if (isMissing(error)) {
      throw componentStoreError(
        `Component target version directory does not exist: ${target}`,
        'ERR_COMPONENT_TARGET_MISSING',
        { target, version },
        error,
      );
    }
    throw error;
  }

  return target;
}

function ensurePairDirectories(options, pair) {
  for (const pointer of POINTER_NAMES) {
    if (pair[pointer] !== null) ensureTargetDirectory(options, pair[pointer]);
  }
}

function inspectPointerArtifact(options, path) {
  const status = lstatPresence(path, options.fs);
  if (status === null) return { present: false, path };

  let rawTarget;
  try {
    rawTarget = options.fs.readlinkSync(path);
  } catch (error) {
    throw componentStoreError(
      `Refusing to operate on non-link pointer artifact: ${path}`,
      'ERR_COMPONENT_POINTER_UNSAFE',
      { path },
      error,
    );
  }

  if (typeof rawTarget !== 'string' || rawTarget.includes('\0')) {
    throw componentStoreError(
      `Pointer artifact has an invalid target: ${path}`,
      'ERR_COMPONENT_POINTER_UNSAFE',
      { path },
    );
  }

  return {
    present: true,
    path,
    rawTarget,
    status,
  };
}

function normalizeWindowsJunctionTarget(options, rawTarget) {
  if (!isWindows(options.platform)) return rawTarget;

  const extendedPrefix = `${BACKSLASH}${BACKSLASH}?${BACKSLASH}`;
  const extendedUncPrefix = `${extendedPrefix}UNC${BACKSLASH}`;
  if (rawTarget.startsWith(extendedUncPrefix)) {
    return `${BACKSLASH}${BACKSLASH}${rawTarget.slice(extendedUncPrefix.length)}`;
  }
  if (rawTarget.startsWith(extendedPrefix)) {
    return rawTarget.slice(extendedPrefix.length);
  }
  return rawTarget;
}

function parseConfinedPointerTarget(options, artifact) {
  const componentRoot = resolvedComponentDirectory(options.root, options.name);
  const resolvedTarget = resolve(
    componentRoot,
    normalizeWindowsJunctionTarget(options, artifact.rawTarget),
  );
  const relativeTarget = relative(componentRoot, resolvedTarget);

  if (
    relativeTarget.length === 0
    || isAbsolute(relativeTarget)
    || relativeTarget.includes('/')
    || relativeTarget.includes('\\')
  ) {
    throw componentStoreError(
      `Pointer target is not confined to this component: ${artifact.path}`,
      'ERR_COMPONENT_POINTER_EXTERNAL',
      { path: artifact.path, target: artifact.rawTarget },
    );
  }

  const version = validateVersion(relativeTarget, 'pointer target version');
  const expectedTarget = targetDirectory(options, version);
  if (resolvedTarget !== expectedTarget) {
    throw componentStoreError(
      `Pointer target is malformed: ${artifact.path}`,
      'ERR_COMPONENT_POINTER_EXTERNAL',
      { path: artifact.path, target: artifact.rawTarget },
    );
  }

  return { version, target: expectedTarget };
}

function readActivePointer(options, pointer, { allowMissingTarget = false } = {}) {
  const artifact = inspectPointerArtifact(options, pointerPath(options, pointer));
  if (!artifact.present) {
    return {
      present: false,
      stale: false,
      version: null,
    };
  }

  const parsed = parseConfinedPointerTarget(options, artifact);
  try {
    ensureTargetDirectory(options, parsed.version);
  } catch (error) {
    if (allowMissingTarget && error?.code === 'ERR_COMPONENT_TARGET_MISSING') {
      return {
        present: true,
        stale: true,
        version: null,
        staleVersion: parsed.version,
      };
    }
    throw error;
  }

  return {
    present: true,
    stale: false,
    version: parsed.version,
  };
}

function readPairUnsafe(options, { allowStalePrevious = false } = {}) {
  const current = readActivePointer(options, 'current');
  const previous = readActivePointer(options, 'previous', {
    allowMissingTarget: allowStalePrevious,
  });

  return {
    pointers: {
      current: current.version,
      previous: previous.version,
    },
    stalePrevious: previous.stale,
    entries: {
      current,
      previous,
    },
  };
}

function fsyncPath(fs, path) {
  const descriptor = fs.openSync(path, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(fs, path, platform) {
  try {
    fsyncPath(fs, path);
  } catch (error) {
    // Node cannot open directory handles for fsync on Windows; callers can inject
    // a platform-specific durability implementation when one is available.
    if (
      isWindows(platform)
      && ['EACCES', 'EISDIR', 'EPERM'].includes(error?.code)
    ) {
      return;
    }
    throw error;
  }
}

function normalizeDurability(fs, durability, platform) {
  return {
    fsyncFile: durability?.fsyncFile ?? ((path) => fsyncPath(fs, path)),
    fsyncDirectory: durability?.fsyncDirectory ?? ((path) => fsyncDirectory(fs, path, platform)),
  };
}

function lockOwnerPath(path) {
  return join(path, LOCK_OWNER_FILE);
}

function lockReclaimPath(path) {
  return join(path, LOCK_RECLAIM_FILE);
}

function invalidLockError(path, cause) {
  return componentStoreError(
    `Component pointer-store lock is malformed: ${path}`,
    'ERR_COMPONENT_STORE_LOCKED',
    { path },
    cause,
  );
}

function readLockRecord(fs, path, recordPath, { allowMissing = false } = {}) {
  const lockStatus = lstatPresence(path, fs);
  if (lockStatus === null) {
    if (allowMissing) return null;
    throw invalidLockError(path);
  }
  if (!statusIsDirectory(lockStatus) || statusIsSymbolicLink(lockStatus)) {
    throw invalidLockError(path);
  }

  const recordStatus = lstatPresence(recordPath, fs);
  if (recordStatus === null) {
    if (allowMissing) return null;
    throw invalidLockError(path);
  }
  if (!statusIsFile(recordStatus) || statusIsSymbolicLink(recordStatus)) {
    throw invalidLockError(path);
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch (error) {
    if (allowMissing && isMissing(error)) return null;
    throw invalidLockError(path, error);
  }

  if (
    typeof record !== 'object'
    || record === null
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || typeof record.token !== 'string'
    || record.token.length === 0
  ) {
    throw invalidLockError(path);
  }
  return record;
}

function readLockOwner(fs, path, options) {
  return readLockRecord(fs, path, lockOwnerPath(path), options);
}

function readLockReclaimer(fs, path, options) {
  return readLockRecord(fs, path, lockReclaimPath(path), options);
}

function lockOwnerIsAlive(owner) {
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function lockHeldError(path) {
  const error = new Error(`Component pointer-store lock is already held: ${path}`);
  error.code = 'EEXIST';
  return error;
}

function isExistingLockError(error) {
  return error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY';
}

function createDefaultLock(fs, durability) {
  function createLock(path) {
    const owner = {
      pid: process.pid,
      token: randomUUID(),
    };
    const temporaryPath = `${path}.pending-${owner.token}`;
    fs.mkdirSync(temporaryPath, { mode: 0o700 });
    let published = false;

    try {
      const ownerPath = lockOwnerPath(temporaryPath);
      fs.writeFileSync(ownerPath, JSON.stringify(owner), 'utf8');
      durability.fsyncFile(ownerPath);
      durability.fsyncDirectory(temporaryPath);
      durability.fsyncDirectory(dirname(path));
      fs.renameSync(temporaryPath, path);
      published = true;
      durability.fsyncDirectory(path);
      durability.fsyncDirectory(dirname(path));
      return { path, ...owner };
    } catch (error) {
      try {
        fs.rmSync(published ? path : temporaryPath, { recursive: true, force: false });
        durability.fsyncDirectory(dirname(path));
      } catch (cleanupError) {
        error.lockCleanupError = cleanupError;
      }
      throw error;
    }
  }

  function removeClaim(path, claim) {
    const currentClaim = readLockReclaimer(fs, path, { allowMissing: true });
    if (
      currentClaim !== null
      && currentClaim.pid === claim.pid
      && currentClaim.token === claim.token
    ) {
      fs.unlinkSync(lockReclaimPath(path));
      durability.fsyncDirectory(path);
    }
  }

  function claimStaleLock(path) {
    const existingClaim = readLockReclaimer(fs, path, { allowMissing: true });
    if (existingClaim !== null) {
      if (lockOwnerIsAlive(existingClaim)) throw lockHeldError(path);
      fs.unlinkSync(lockReclaimPath(path));
      durability.fsyncDirectory(path);
    }

    const claim = {
      pid: process.pid,
      token: randomUUID(),
    };
    const pendingPath = join(path, `.reclaim-pending-${claim.token}`);
    fs.writeFileSync(pendingPath, JSON.stringify(claim), { encoding: 'utf8', flag: 'wx' });
    durability.fsyncFile(pendingPath);
    durability.fsyncDirectory(path);

    try {
      fs.linkSync(pendingPath, lockReclaimPath(path));
    } catch (error) {
      if (error?.code === 'EEXIST') throw lockHeldError(path);
      throw error;
    } finally {
      try {
        fs.unlinkSync(pendingPath);
        durability.fsyncDirectory(path);
      } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') throw cleanupError;
      }
    }

    durability.fsyncDirectory(path);
    return claim;
  }

  function reclaimStaleLock(path, owner) {
    if (lockOwnerIsAlive(owner)) throw lockHeldError(path);

    const claim = claimStaleLock(path);
    try {
      const currentOwner = readLockOwner(fs, path, { allowMissing: true });
      if (
        currentOwner === null
      ) {
        const error = new Error('Lock owner disappeared during reclaim verification');
        error.code = 'ENOENT';
        throw error;
      }
      if (
        currentOwner.pid !== owner.pid
        || currentOwner.token !== owner.token
        || lockOwnerIsAlive(currentOwner)
      ) {
        throw lockHeldError(path);
      }

      const stalePath = `${path}.stale-${randomUUID()}`;
      fs.renameSync(path, stalePath);
      durability.fsyncDirectory(dirname(path));
      fs.rmSync(stalePath, { recursive: true, force: false });
      durability.fsyncDirectory(dirname(path));
    } catch (error) {
      try {
        removeClaim(path, claim);
      } catch (cleanupError) {
        error.lockCleanupError = cleanupError;
      }
      throw error;
    }
  }

  return {
    acquire(path) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return createLock(path);
        } catch (error) {
          if (error?.code === 'EPERM') {
            if (lstatPresence(path, fs) === null) continue;
          } else if (!isExistingLockError(error)) {
            throw error;
          }
        }

        try {
          const owner = readLockOwner(fs, path, { allowMissing: true });
          if (owner === null) continue;
          reclaimStaleLock(path, owner);
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw error;
        }
      }
      throw lockHeldError(path);
    },
    release(token, path) {
      const owner = readLockOwner(fs, path);
      if (!token || owner.pid !== token.pid || owner.token !== token.token) {
        throw invalidLockError(path);
      }
      fs.rmSync(path, { recursive: true, force: false });
      durability.fsyncDirectory(dirname(path));
    },
  };
}

function normalizeOptions(input) {
  const root = validateRoot(input.root);
  const name = validateName(input.name);
  const fs = input.fs ?? nodeFs;
  const platform = input.platform ?? process.platform;
  const durability = normalizeDurability(fs, input.durability, platform);
  const options = {
    ...input,
    root,
    name,
    fs,
    durability,
    platform,
    componentDir: componentDirectory(root, name),
  };
  options.lock = input.lock ?? createDefaultLock(fs, durability);
  return options;
}

function withComponentLock(options, operation) {
  let token;
  let acquired = false;
  let operationError;

  try {
    token = options.lock.acquire(lockPath(options));
    acquired = true;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw componentStoreError(
        `Component pointer-store lock is already held: ${lockPath(options)}`,
        'ERR_COMPONENT_STORE_LOCKED',
        { path: lockPath(options) },
        error,
      );
    }
    throw error;
  }

  try {
    return operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (acquired) {
      try {
        options.lock.release(token, lockPath(options));
      } catch (releaseError) {
        if (operationError) {
          operationError.lockReleaseError = releaseError;
        } else {
          throw releaseError;
        }
      }
    }
  }
}

function syncComponentDirectory(options) {
  options.durability.fsyncDirectory(options.componentDir);
}

function ensureRegularFile(options, path, label) {
  const status = lstatPresence(path, options.fs);
  if (status === null) return false;
  if (!statusIsFile(status) || statusIsSymbolicLink(status)) {
    throw componentStoreError(
      `${label} must be a regular file: ${path}`,
      'ERR_COMPONENT_JOURNAL_UNSAFE',
      { path },
    );
  }
  return true;
}

function removeRegularFile(options, path, label) {
  if (!ensureRegularFile(options, path, label)) return false;
  options.fs.unlinkSync(path);
  syncComponentDirectory(options);
  return true;
}

function writeJournal(options, journal) {
  const destination = journalPath(options);
  const temporary = journalTemporaryPath(options);
  ensureRegularFile(options, destination, 'Transaction journal');
  removeRegularFile(options, temporary, 'Transaction journal temporary file');
  let published = false;
  let step = 'write-temporary';

  try {
    options.fs.writeFileSync(temporary, JSON.stringify(journal), 'utf8');
    step = 'fsync-temporary';
    options.durability.fsyncFile(temporary);
    step = 'rename-publish';
    options.fs.renameSync(temporary, destination);
    published = true;
    step = 'fsync-published-journal';
    options.durability.fsyncFile(destination);
    step = 'fsync-component-directory';
    syncComponentDirectory(options);
  } catch (error) {
    error.journalWrite = {
      phase: journal.phase,
      cleanupState: journal.cleanupState,
      published,
      step,
      path: destination,
      temporaryPath: temporary,
    };
    throw error;
  }
}

function readJournalFile(options, path, label) {
  if (!ensureRegularFile(options, path, label)) return null;

  let journal;
  try {
    journal = JSON.parse(options.fs.readFileSync(path, 'utf8'));
  } catch (error) {
    throw componentStoreError(
      `Transaction journal is malformed: ${path}`,
      'ERR_COMPONENT_JOURNAL_INVALID',
      { path },
      error,
    );
  }
  return validateJournal(options, journal);
}

function validateJournal(options, journal) {
  if (typeof journal !== 'object' || journal === null || Array.isArray(journal)) {
    throw componentStoreError('Transaction journal must be an object.', 'ERR_COMPONENT_JOURNAL_INVALID');
  }
  if (journal.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    throw componentStoreError('Transaction journal schema version is unsupported.', 'ERR_COMPONENT_JOURNAL_INVALID');
  }
  if (journal.name !== options.name) {
    throw componentStoreError('Transaction journal belongs to another component.', 'ERR_COMPONENT_JOURNAL_INVALID');
  }
  if (journal.phase !== 'prepared' && journal.phase !== 'committed') {
    throw componentStoreError('Transaction journal has an invalid phase.', 'ERR_COMPONENT_JOURNAL_INVALID');
  }
  if (journal.cleanupState !== 'pending' && journal.cleanupState !== 'complete') {
    throw componentStoreError('Transaction journal has an invalid cleanup state.', 'ERR_COMPONENT_JOURNAL_INVALID');
  }
  if (journal.repairPrevious !== undefined && typeof journal.repairPrevious !== 'boolean') {
    throw componentStoreError('Transaction journal has an invalid repair state.', 'ERR_COMPONENT_JOURNAL_INVALID');
  }

  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    name: options.name,
    snapshot: validatePair(journal.snapshot, 'journal.snapshot'),
    desired: validatePair(journal.desired, 'journal.desired'),
    phase: journal.phase,
    cleanupState: journal.cleanupState,
    repairPrevious: journal.repairPrevious === true,
  };
}

function readJournal(options) {
  const committedJournal = readJournalFile(options, journalPath(options), 'Transaction journal');
  if (committedJournal !== null) return committedJournal;

  const temporary = journalTemporaryPath(options);
  try {
    return readJournalFile(options, temporary, 'Transaction journal temporary file');
  } catch (error) {
    // No committed journal exists, so the temporary journal is the only record of an
    // in-flight transaction. An invalid temporary journal in this state is indistinguishable
    // from a crash mid-write (e.g. truncated JSON from an interrupted writeFileSync) rather
    // than a durable, meaningful transaction — discard it and proceed as if no transaction
    // was ever prepared. A malformed *committed* journal above still fails closed.
    if (error?.code === 'ERR_COMPONENT_JOURNAL_INVALID') {
      removeRegularFile(options, temporary, 'Transaction journal temporary file');
      return null;
    }
    throw error;
  }
}

function removeJournalFiles(options) {
  removeRegularFile(options, journalTemporaryPath(options), 'Transaction journal temporary file');
  removeRegularFile(options, journalPath(options), 'Transaction journal');
}

function removePointerArtifact(options, path) {
  const artifact = inspectPointerArtifact(options, path);
  if (!artifact.present) return false;

  options.fs.rmSync(path, { recursive: true, force: false });
  syncComponentDirectory(options);
  return true;
}

function isWindows(platform) {
  return platform === 'win32' || platform === 'windows';
}

function quoteCmdArgument(value) {
  if (
    typeof value !== 'string'
    || value.includes('\0')
    || value.includes('"')
    || value.includes('%')
    || value.includes('!')
    || value.includes('\r')
    || value.includes('\n')
  ) {
    throw new TypeError('Windows junction paths contain a CMD metacharacter that cannot be safely quoted.');
  }
  return `"${value}"`;
}

function createWindowsJunction(pointer, target, runCommand) {
  const command = `mklink /J ${quoteCmdArgument(pointer)} ${quoteCmdArgument(target)}`;
  runCommand('cmd', ['/d', '/s', '/c', command], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

function createTemporaryPointer(options, pointer, version) {
  const temporary = temporaryPointerPath(options, pointer);
  const target = ensureTargetDirectory(options, version);

  if (isWindows(options.platform)) {
    if (options.createJunction) {
      options.createJunction(temporary, target);
    } else {
      createWindowsJunction(temporary, target, options.runCommand ?? execFileSync);
    }
  } else {
    options.fs.symlinkSync(version, temporary, 'dir');
  }

  const artifact = inspectPointerArtifact(options, temporary);
  const parsed = parseConfinedPointerTarget(options, artifact);
  if (parsed.version !== version) {
    throw componentStoreError(
      `New pointer does not target the requested version: ${temporary}`,
      'ERR_COMPONENT_POINTER_UNSAFE',
      { pointer, version, target: artifact.rawTarget },
    );
  }
  ensureTargetDirectory(options, parsed.version);
  syncComponentDirectory(options);
}

function clearTransactionArtifacts(options) {
  for (const pointer of POINTER_NAMES) {
    removePointerArtifact(options, temporaryPointerPath(options, pointer));
    removePointerArtifact(options, backupPointerPath(options, pointer));
  }
}

function parkActivePointers(options, {
  expected = null,
  allowStalePrevious = false,
} = {}) {
  for (const pointer of POINTER_NAMES) {
    const entry = readActivePointer(options, pointer, {
      allowMissingTarget: pointer === 'previous' && allowStalePrevious,
    });

    if (expected !== null) {
      if (entry.stale) {
        if (!(pointer === 'previous' && allowStalePrevious && expected.previous === null)) {
          throw componentStoreError(
            `Pointer changed or became stale during transaction: ${pointer}`,
            'ERR_COMPONENT_POINTER_STALE',
            { pointer, expected: expected[pointer] },
          );
        }
      } else if (entry.version !== expected[pointer]) {
        throw componentStoreError(
          `Pointer changed during transaction: ${pointer}`,
          'ERR_COMPONENT_POINTER_STALE',
          { pointer, expected: expected[pointer], actual: entry.version },
        );
      }
    }

    if (entry.present) {
      options.fs.renameSync(pointerPath(options, pointer), backupPointerPath(options, pointer));
      syncComponentDirectory(options);
    }
  }
}

function installTemporaryPointers(options, pair) {
  for (const pointer of POINTER_NAMES) {
    const destination = pointerPath(options, pointer);
    const destinationStatus = lstatPresence(destination, options.fs);
    if (destinationStatus !== null) {
      throw componentStoreError(
        `Pointer was not safely parked before install: ${destination}`,
        'ERR_COMPONENT_POINTER_UNSAFE',
        { pointer, path: destination },
      );
    }

    if (pair[pointer] !== null) {
      options.fs.renameSync(temporaryPointerPath(options, pointer), destination);
      syncComponentDirectory(options);
    }
  }
}

function stageAndInstallPair(options, pair, transactionOptions = {}) {
  ensurePairDirectories(options, pair);
  clearTransactionArtifacts(options);

  for (const pointer of POINTER_NAMES) {
    if (pair[pointer] !== null) {
      createTemporaryPointer(options, pointer, pair[pointer]);
    }
  }

  parkActivePointers(options, transactionOptions);
  installTemporaryPointers(options, pair);
}

function verifyPair(options, expected) {
  const actual = readPairUnsafe(options).pointers;
  if (!samePair(actual, expected)) {
    throw componentStoreError(
      'Component pointer transaction did not install the expected pair.',
      'ERR_COMPONENT_POINTER_VERIFY',
      { expected, actual },
    );
  }
  return actual;
}

function preparedJournal(options, snapshot, desired, { repairPrevious = false } = {}) {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    name: options.name,
    snapshot,
    desired,
    phase: 'prepared',
    cleanupState: 'pending',
    repairPrevious,
  };
}

function recoverPreparedJournal(options, journal) {
  ensurePairDirectories(options, journal.snapshot);
  stageAndInstallPair(options, journal.snapshot, {
    allowStalePrevious: journal.repairPrevious,
  });
  verifyPair(options, journal.snapshot);
  clearTransactionArtifacts(options);
  removeJournalFiles(options);
  return journal.snapshot;
}

function cleanupCommittedJournal(options, journal) {
  try {
    clearTransactionArtifacts(options);
  } catch (error) {
    return { complete: false, error };
  }

  try {
    if (journal.cleanupState !== 'complete') {
      writeJournal(options, {
        ...journal,
        cleanupState: 'complete',
      });
    }
    removeJournalFiles(options);
  } catch (error) {
    return { complete: false, error };
  }
  return { complete: true };
}

function attachRecoveryMetadata(error, journal, step, extra = {}) {
  error.recovery = {
    phase: journal.phase,
    cleanupState: journal.cleanupState,
    desired: journal.desired,
    snapshot: journal.snapshot,
    step,
    ...extra,
  };
  return error;
}

function ensureCommittedDesiredState(options, journal) {
  const actual = readPairUnsafe(options).pointers;
  if (samePair(actual, journal.desired)) return false;

  ensurePairDirectories(options, journal.desired);
  stageAndInstallPair(options, journal.desired, {
    allowStalePrevious: journal.repairPrevious,
  });
  verifyPair(options, journal.desired);
  return true;
}

function recoverCommittedPublicationFailure(options, error, journal) {
  let persisted = journal;

  try {
    const onDiskJournal = readJournal(options);
    if (onDiskJournal === null) {
      throw componentStoreError(
        'Committed transaction journal disappeared after publication.',
        'ERR_COMPONENT_JOURNAL_INVALID',
        { path: journalPath(options) },
      );
    }
    persisted = onDiskJournal;
    if (persisted.phase !== 'committed') {
      throw componentStoreError(
        'Committed transaction journal was not durable after publication.',
        'ERR_COMPONENT_JOURNAL_INVALID',
        { path: journalPath(options), phase: persisted.phase },
      );
    }
  } catch (recoveryError) {
    return attachRecoveryMetadata(recoveryError, journal, 'read-committed-journal', {
      journalPublished: true,
      journalWriteStep: error?.journalWrite?.step,
      cleanupRetained: true,
    });
  }

  try {
    const repaired = ensureCommittedDesiredState(options, persisted);
    return attachRecoveryMetadata(error, persisted, repaired ? 'repair-desired' : 'verify-desired', {
      journalPublished: true,
      journalWriteStep: error?.journalWrite?.step,
      cleanupRetained: true,
    });
  } catch (recoveryError) {
    return attachRecoveryMetadata(recoveryError, persisted, 'repair-desired', {
      journalPublished: true,
      journalWriteStep: error?.journalWrite?.step,
      cleanupRetained: true,
    });
  }
}

function recoverComponentLocked(options) {
  const journal = readJournal(options);
  if (journal === null) return;

  if (journal.phase === 'prepared') {
    try {
      recoverPreparedJournal(options, journal);
    } catch (error) {
      throw attachRecoveryMetadata(error, journal, 'restore-snapshot');
    }
    return;
  }

  try {
    ensureCommittedDesiredState(options, journal);
  } catch (error) {
    throw attachRecoveryMetadata(error, journal, 'repair-desired');
  }

  try {
    cleanupCommittedJournal(options, journal);
  } catch (error) {
    throw attachRecoveryMetadata(error, journal, 'record-cleanup');
  }
}

function attachTransactionMetadata(error, {
  snapshot,
  desired,
  compensation,
}) {
  error.transaction = {
    snapshot,
    desired,
    phase: 'prepared',
    compensation,
  };
  return error;
}

function executeTransaction(options, {
  snapshot,
  desired,
  allowStalePrevious = false,
}) {
  ensurePairDirectories(options, desired);
  const journal = preparedJournal(options, snapshot, desired, {
    repairPrevious: allowStalePrevious,
  });
  writeJournal(options, journal);

  let committedJournal;
  try {
    stageAndInstallPair(options, desired, {
      expected: snapshot,
      allowStalePrevious,
    });
    verifyPair(options, desired);
    committedJournal = {
      ...journal,
      phase: 'committed',
      cleanupState: 'pending',
    };
    writeJournal(options, committedJournal);
  } catch (error) {
    if (error?.journalWrite?.phase === 'committed' && error?.journalWrite?.published === true) {
      throw recoverCommittedPublicationFailure(options, error, committedJournal);
    }
    const compensation = {
      attempted: true,
      succeeded: false,
    };
    try {
      recoverPreparedJournal(options, journal);
      compensation.succeeded = true;
    } catch (recoveryError) {
      compensation.error = recoveryError;
    }
    throw attachTransactionMetadata(error, {
      snapshot,
      desired,
      compensation,
    });
  }

  // Once committed, failed cleanup must retain the journal and never undo the switch.
  cleanupCommittedJournal(options, committedJournal);
  return verifyPair(options, desired);
}

export function readPointers(root, name, options = {}) {
  const normalized = normalizeOptions({ ...options, root, name });
  if (!componentDirectoryPresent(normalized, { allowMissing: true })) {
    return { current: null, previous: null };
  }

  return withComponentLock(normalized, () => {
    recoverComponentLocked(normalized);
    return readPairUnsafe(normalized).pointers;
  });
}

/**
 * Inspects a component pair without acquiring its lock or attempting journal
 * recovery. This is intentionally used by read-only status/report commands.
 */
export function readPointersReadOnly(root, name, options = {}) {
  const normalized = normalizeOptions({ ...options, root, name });
  if (!componentDirectoryPresent(normalized, { allowMissing: true })) {
    return { current: null, previous: null };
  }
  return readPairUnsafe(normalized).pointers;
}

export const inspectPointers = readPointersReadOnly;

export function restoreComponent({
  root,
  name,
  pointers,
  platform,
  fs = nodeFs,
  createJunction,
  runCommand = execFileSync,
  lock,
  durability,
}) {
  const desired = validatePair(pointers);
  const options = normalizeOptions({
    root,
    name,
    platform,
    fs,
    createJunction,
    runCommand,
    lock,
    durability,
  });

  if (!componentDirectoryPresent(options, { allowMissing: true })) {
    ensurePairDirectories(options, desired);
    return desired;
  }

  return withComponentLock(options, () => {
    recoverComponentLocked(options);
    ensurePairDirectories(options, desired);

    const before = readPairUnsafe(options, {
      allowStalePrevious: desired.previous === null,
    });
    if (samePair(before.pointers, desired) && !before.stalePrevious) {
      return before.pointers;
    }

    return executeTransaction(options, {
      snapshot: before.pointers,
      desired,
      allowStalePrevious: before.stalePrevious && desired.previous === null,
    });
  });
}

export function activateComponent({
  root,
  name,
  version,
  platform,
  fs = nodeFs,
  createJunction,
  runCommand = execFileSync,
  lock,
  durability,
}) {
  validateVersion(version);
  const options = normalizeOptions({
    root,
    name,
    platform,
    fs,
    createJunction,
    runCommand,
    lock,
    durability,
  });

  if (!componentDirectoryPresent(options, { allowMissing: true })) {
    ensureTargetDirectory(options, version);
  }

  return withComponentLock(options, () => {
    recoverComponentLocked(options);
    ensureTargetDirectory(options, version);
    const before = readPairUnsafe(options);
    if (before.pointers.current === version) return before.pointers;

    const desired = {
      current: version,
      previous: before.pointers.current,
    };
    return executeTransaction(options, {
      snapshot: before.pointers,
      desired,
    });
  });
}
