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
    assert.equal(COMPONENTS.headroomLite.version, '0.31.0');
    assert.equal(COMPONENTS.headroomLite.ref, 'v0.31.0');
  });

  it('matches the released component pins from the brief', () => {
    assert.deepEqual(COMPONENTS, {
      headroomLite: {
        kind: 'npm-git',
        package: 'github:yehsuf/headroom-lite',
        version: '0.31.0',
        ref: 'v0.31.0',
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
        version: '1.5.4.dev0',
        ref: 'e08e964d0c8703401f7ad419b9bf69d85d35188d',
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
        repository: 'winsw/winsw',
        version: '3.0.0-alpha.11',
        ref: 'v3.0.0-alpha.11',
        bin: 'WinSW.exe',
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
});
