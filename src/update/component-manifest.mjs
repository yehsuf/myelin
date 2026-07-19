export const COMPONENT_MANIFEST_VERSION = 1;

/**
 * Python version used for all managed uv venvs. mitmproxy and agentcairn both
 * require >=3.12; 3.12 is the minimum that satisfies all managed components and
 * is the version uv downloads when no system Python is available.
 */
export const MANAGED_PYTHON_VERSION = '3.12';

const COMPONENT_KINDS = Object.freeze([
  'npm-git',
  'uv-venv',
  'uv-git',
  'github-binary',
  'npm',
  'git-checkout',
]);

const GIT_REF_KINDS = new Set([
  'npm-git',
  'uv-git',
  'github-binary',
  'git-checkout',
]);

const EXECUTABLE_KINDS = new Set([
  'npm-git',
  'uv-venv',
  'uv-git',
  'github-binary',
  'npm',
]);

const REQUIRE_PACKAGE_KINDS = new Set([
  'npm-git',
  'uv-venv',
  'uv-git',
  'npm',
]);

const REQUIRE_REPOSITORY_KINDS = new Set([
  'uv-git',
  'github-binary',
  'git-checkout',
]);

const FULL_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const SHORT_SHA_PATTERN = /^[0-9a-f]{7,40}$/iu;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function validatePinnedVersionString(value) {
  return isNonEmptyString(value)
    && !/[\s~^*<>=]/u.test(value)
    && !/^latest$/iu.test(value)
    && !/(^|\.)x$/iu.test(value)
    && !/(^|\.)\*$/u.test(value);
}

function validateSemverVersion(value) {
  return isNonEmptyString(value) && FULL_SEMVER_PATTERN.test(value);
}

function validateVersionForKind(component) {
  switch (component.kind) {
    case 'npm':
    case 'npm-git':
    case 'github-binary':
      return validateSemverVersion(component.version);
    case 'git-checkout':
      return validatePinnedVersionString(component.version)
        && SHORT_SHA_PATTERN.test(component.version);
    default:
      return validatePinnedVersionString(component.version);
  }
}

function validateGitRefForKind(component) {
  if (!isNonEmptyString(component.ref)) return false;

  // Keep this switch exhaustive for every kind listed in GIT_REF_KINDS.
  switch (component.kind) {
    case 'uv-git':
      return FULL_SHA_PATTERN.test(component.ref);
    case 'git-checkout':
      return FULL_SHA_PATTERN.test(component.ref)
        && component.ref.toLowerCase().startsWith(component.version.toLowerCase());
    case 'npm-git':
    case 'github-binary':
      return validateSemverVersion(component.version)
        && component.ref === `v${component.version}`;
    default:
      return false;
  }
}

function requireField(componentName, fieldName, value) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${componentName}.${fieldName} is required.`);
  }
}

function freezeManifest(manifest) {
  for (const component of Object.values(manifest)) {
    Object.freeze(component);
  }
  return Object.freeze(manifest);
}

export function validateComponentManifest(manifest) {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('component manifest must be an object.');
  }

  for (const [componentName, component] of Object.entries(manifest)) {
    if (typeof component !== 'object' || component === null || Array.isArray(component)) {
      throw new Error(`${componentName} must be an object.`);
    }

    if (!COMPONENT_KINDS.includes(component.kind)) {
      throw new Error(`${componentName}.kind is unknown: ${component.kind}`);
    }

    requireField(componentName, 'version', component.version);
    if (!validateVersionForKind(component)) {
      throw new Error(`${componentName}.version must be an exact pinned version.`);
    }

    if (REQUIRE_PACKAGE_KINDS.has(component.kind)) {
      requireField(componentName, 'package', component.package);
    }

    if (REQUIRE_REPOSITORY_KINDS.has(component.kind)) {
      requireField(componentName, 'repository', component.repository);
    }

    if (GIT_REF_KINDS.has(component.kind)) {
      if (!validateGitRefForKind(component)) {
        throw new Error(`${componentName}.ref must be a valid git ref pin.`);
      }
    }

    if (EXECUTABLE_KINDS.has(component.kind)) {
      requireField(componentName, 'bin', component.bin);
    }

    if (component.pythonVersion !== undefined) {
      if (typeof component.pythonVersion !== 'string'
        || !/^\d+\.\d+$/u.test(component.pythonVersion.trim())) {
        throw new Error(
          `${componentName}.pythonVersion must be a "major.minor" string (e.g. "3.12").`,
        );
      }
    }
  }

  return true;
}

const RELEASED_COMPONENTS = {
  headroomLite: {
    kind: 'npm-git',
    package: 'github:yehsuf/headroom-lite',
    version: '0.31.0-3',
    ref: 'v0.31.0-3',
    bin: 'headroom-lite',
  },
  headroomOriginal: {
    kind: 'uv-venv',
    package: 'headroom-ai[proxy]',
    version: '0.31.0',
    bin: 'headroom',
  },
  serena: {
    kind: 'uv-git',
    package: 'serena-agent',
    repository: 'https://github.com/oraios/serena.git',
    version: '1.6.0',
    ref: '93b9544ea9def8e93cb6a90f8ea67befe3c8fee4',
    bin: 'serena',
  },
  semble: {
    kind: 'uv-venv',
    package: 'semble[mcp]',
    version: '0.4.2',
    bin: 'semble',
  },
  agentcairn: {
    kind: 'uv-venv',
    package: 'agentcairn',
    version: '0.23.0',
    bin: 'cairn',
  },
  rtk: {
    kind: 'github-binary',
    repository: 'rtk-ai/rtk',
    version: '0.43.0',
    ref: 'v0.43.0',
    bin: 'rtk',
  },
  astGrep: {
    kind: 'npm',
    package: '@ast-grep/cli',
    version: '0.44.1',
    bin: 'ast-grep',
  },
  mitmproxy: {
    kind: 'uv-venv',
    package: 'mitmproxy',
    version: '12.2.3',
    bin: 'mitmdump',
  },
  winsw: {
    kind: 'github-binary',
    platforms: ['win32'],
    repository: 'winsw/winsw',
    version: '3.0.0-alpha.11',
    ref: 'v3.0.0-alpha.11',
    bin: 'WinSW.exe',
    requireVerifiedChecksum: true,
    checksums: {
      'WinSW-x64.exe': 'a2daa6a33a9c2b791ae31d9092e7935c339d1e03e89bfb747618ce2f4e819e20',
      'WinSW-x86.exe': '3201432b44825b0dc763eb4052dc84b179314e2a338794c9f5f797e8fe2bb0fc',
      'WinSW-net461.exe': '91bce26b4fa3a7534e7967c1804d7417737b7169014435e5b3b31924bf19f3ee',
    },
  },
  codegraph: {
    kind: 'npm',
    package: '@optave/codegraph',
    version: '3.15.0',
    bin: 'codegraph',
    optional: true,
  },
  tokenOptimizer: {
    kind: 'git-checkout',
    repository: 'https://github.com/alexgreensh/token-optimizer.git',
    version: 'c8f8609',
    ref: 'c8f860993fd813575fc7ba6a8e73fcee16ca0493',
    optional: true,
  },
};

validateComponentManifest(RELEASED_COMPONENTS);

export const COMPONENTS = freezeManifest(RELEASED_COMPONENTS);
