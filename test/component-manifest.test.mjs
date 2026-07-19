import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPONENTS,
  validateComponentManifest,
} from '../src/update/component-manifest.mjs';

function cloneComponents() {
  return structuredClone(COMPONENTS);
}

describe('component manifest', () => {
  it('contains no ranges or moving refs', () => {
    assert.equal(validateComponentManifest(COMPONENTS), true);

    for (const component of Object.values(COMPONENTS)) {
      assert.doesNotMatch(component.version ?? '', /[~^*<>=]/);
      assert.notEqual(component.ref, 'main');
      assert.notEqual(component.ref, 'master');
    }
  });

  it('pins the selected deterministic backend release', () => {
    assert.equal(COMPONENTS.headroomLite.version, '0.31.0-4');
    assert.equal(COMPONENTS.headroomLite.ref, 'v0.31.0-4');
  });

  it('matches the released component pins from the brief', () => {
    assert.deepEqual(COMPONENTS, {
      headroomLite: {
        kind: 'npm-git',
        package: 'github:yehsuf/headroom-lite',
        version: '0.31.0-4',
        ref: 'v0.31.0-4',
        bin: 'headroom-lite',
      },
      headroomOriginal: {
        kind: 'uv-venv',
        package: 'headroom-ai[proxy]',
        version: '0.31.0',
        bin: 'headroom',
        optional: true,
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
    });
  });

  it('rejects missing versions', () => {
    const manifest = cloneComponents();
    delete manifest.serena.version;

    assert.throws(
      () => validateComponentManifest(manifest),
      /serena\.version.*required/i,
    );
  });

  it('rejects nonexact versions', () => {
    const caretManifest = cloneComponents();
    caretManifest.serena.version = '^1.5.4';

    assert.throws(
      () => validateComponentManifest(caretManifest),
      /serena\.version.*exact/i,
    );

    const wildcardManifest = cloneComponents();
    wildcardManifest.serena.version = '1.x';

    assert.throws(
      () => validateComponentManifest(wildcardManifest),
      /serena\.version.*exact/i,
    );

    const partialWildcardManifest = cloneComponents();
    partialWildcardManifest.serena.version = '1.2.x';

    assert.throws(
      () => validateComponentManifest(partialWildcardManifest),
      /serena\.version.*exact/i,
    );
  });

  it('rejects partial npm semver versions', () => {
    const manifest = cloneComponents();
    manifest.astGrep.version = '0.44';

    assert.throws(
      () => validateComponentManifest(manifest),
      /astGrep\.version.*exact/i,
    );
  });

  it('rejects moving branch refs', () => {
    const manifest = cloneComponents();
    manifest.headroomLite.ref = 'main';

    assert.throws(
      () => validateComponentManifest(manifest),
      /headroomLite\.ref.*git ref pin/i,
    );
  });

  it('rejects arbitrary moving branch refs for git installs', () => {
    for (const ref of ['develop', 'staging', 'release']) {
      const manifest = cloneComponents();
      manifest.serena.ref = ref;

      assert.throws(
        () => validateComponentManifest(manifest),
        /serena\.ref.*git ref pin/i,
      );
    }
  });

  it('rejects nonsha refs for git checkouts', () => {
    const manifest = cloneComponents();
    manifest.tokenOptimizer.ref = 'c8f8609';

    assert.throws(
      () => validateComponentManifest(manifest),
      /tokenOptimizer\.ref.*git ref pin/i,
    );
  });

  it('rejects release tags that do not match the pinned version', () => {
    const manifest = cloneComponents();
    manifest.rtk.ref = 'v0.43.1';

    assert.throws(
      () => validateComponentManifest(manifest),
      /rtk\.ref.*git ref pin/i,
    );
  });

  it('rejects unknown kinds', () => {
    const manifest = cloneComponents();
    manifest.astGrep.kind = 'tarball';

    assert.throws(
      () => validateComponentManifest(manifest),
      /astGrep\.kind.*unknown/i,
    );
  });

  it('rejects malformed git refs', () => {
    const manifest = cloneComponents();
    manifest.rtk.ref = 'v0.43.0^{}';

    assert.throws(
      () => validateComponentManifest(manifest),
      /rtk\.ref.*valid git ref/i,
    );
  });

  it('rejects missing executable binary identifiers', () => {
    const manifest = cloneComponents();
    delete manifest.winsw.bin;

    assert.throws(
      () => validateComponentManifest(manifest),
      /winsw\.bin.*required/i,
    );
  });

  it('rejects a non-string or malformed pythonVersion override', () => {
    const manifest = cloneComponents();

    // non-string
    manifest.semble.pythonVersion = 312;
    assert.throws(
      () => validateComponentManifest(manifest),
      /pythonVersion.*major\.minor/i,
    );

    // semver patch — must be major.minor only
    manifest.semble.pythonVersion = '3.12.0';
    assert.throws(
      () => validateComponentManifest(manifest),
      /pythonVersion.*major\.minor/i,
    );
  });

  it('accepts a valid pythonVersion override', () => {
    const manifest = cloneComponents();
    manifest.semble.pythonVersion = '3.11';
    assert.ok(validateComponentManifest(manifest));
  });
});
