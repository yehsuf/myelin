import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMPONENTS } from '../src/update/component-manifest.mjs';
import {
  buildComponentInstallPlan,
  detectManagedComponent,
  selectGithubBinaryAsset,
  stageComponent,
} from '../src/update/component-installers.mjs';

const ROOT = '/components';

function destination(name, component) {
  return `${ROOT}/${name}/${component.version}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function makeRelease(asset, tag = COMPONENTS.rtk.ref) {
  return {
    tag_name: tag,
    assets: [asset],
  };
}

function makeFakeStatus(type = 'directory') {
  return {
    isDirectory() {
      return type === 'directory';
    },
    isFile() {
      return type === 'file';
    },
    isSymbolicLink() {
      return type === 'symlink';
    },
  };
}

function makeFakeFs(entries = {}) {
  const calls = [];
  const existing = new Map(Object.entries(entries));
  return {
    calls,
    existing,
    mkdirSync(...args) {
      calls.push(['mkdirSync', ...args]);
      existing.set(args[0], makeFakeStatus('directory'));
    },
    writeFileSync(...args) {
      calls.push(['writeFileSync', ...args]);
      existing.set(args[0], makeFakeStatus('file'));
    },
    chmodSync(...args) {
      calls.push(['chmodSync', ...args]);
    },
    lstatSync(...args) {
      calls.push(['lstatSync', ...args]);
      const status = existing.get(args[0]);
      if (status) return status;
      const error = new Error(`ENOENT: no such file or directory, lstat '${args[0]}'`);
      error.code = 'ENOENT';
      throw error;
    },
  };
}

function tarGzipEntries(entries) {
  const blocks = entries.flatMap(({ name, content }) => {
    const header = Buffer.alloc(512);
    header.write(name, 0, Math.min(Buffer.byteLength(name), 100), 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header[156] = '0'.charCodeAt(0);
    const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
    return [header, content, padding];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function tarGzip(name, content) {
  return tarGzipEntries([{ name, content }]);
}

function storedZip(name, content) {
  const filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(filename.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(filename.length, 28);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + content.length, 16);

  return Buffer.concat([local, filename, content, central, filename, end]);
}

describe('component install plans', () => {
  it('pins uv packages exactly', () => {
    const plan = buildComponentInstallPlan(
      COMPONENTS.semble,
      '/components/semble/0.4.2',
      'linux',
    );

    assert.deepEqual(plan.commands, [
      ['uv', 'venv', '--python', '3.12', '/components/semble/0.4.2'],
      [
        'uv', 'pip', 'install',
        '--python', '/components/semble/0.4.2',
        'semble[mcp]==0.4.2',
      ],
    ]);
  });

  it('pins Serena to an immutable commit', () => {
    const plan = buildComponentInstallPlan(
      COMPONENTS.serena,
      '/components/serena/e08e964d0c8703401f7ad419b9bf69d85d35188d',
      'linux',
    );

    assert.match(
      plan.commands[1].at(-1),
      /serena\.git@e08e964d0c8703401f7ad419b9bf69d85d35188d$/,
    );
  });

  it('plans exact npm, npm-git, and detached git checkout commands', () => {
    const npm = buildComponentInstallPlan(
      COMPONENTS.astGrep,
      destination('astGrep', COMPONENTS.astGrep),
      'linux',
    );
    const npmGit = buildComponentInstallPlan(
      COMPONENTS.headroomLite,
      destination('headroomLite', COMPONENTS.headroomLite),
      'linux',
    );
    const git = buildComponentInstallPlan(
      COMPONENTS.tokenOptimizer,
      destination('tokenOptimizer', COMPONENTS.tokenOptimizer),
      'linux',
    );

    assert.deepEqual(npm.commands, [[
      'npm', 'install', '--prefix', '/components/astGrep/0.44.1',
      '@ast-grep/cli@0.44.1',
    ]]);
    assert.deepEqual(npmGit.commands, [[
      'npm', 'install', '--prefix', '/components/headroomLite/0.31.0-1',
      'github:yehsuf/headroom-lite#v0.31.0-1',
    ]]);
    assert.deepEqual(git.commands, [
      [
        'git', 'clone', '--no-checkout', '--',
        'https://github.com/alexgreensh/token-optimizer.git',
        '/components/tokenOptimizer/c8f8609',
      ],
      [
        'git', '-C', '/components/tokenOptimizer/c8f8609',
        'fetch', '--depth', '1', 'origin',
        'c8f860993fd813575fc7ba6a8e73fcee16ca0493',
      ],
      [
        'git', '-C', '/components/tokenOptimizer/c8f8609',
        'checkout', '--detach', 'c8f860993fd813575fc7ba6a8e73fcee16ca0493',
      ],
    ]);
  });

  it('does not produce upgrades, latest releases, npm updates, or branch refs', () => {
    for (const [name, component] of Object.entries(COMPONENTS)) {
      const plan = buildComponentInstallPlan(component, destination(name, component), 'linux');
      for (const command of plan.commands) {
        const text = command.join(' ');
        assert.doesNotMatch(text, /\bupgrade\b/i);
        assert.doesNotMatch(text, /\blatest\b/i);
        assert.doesNotMatch(text, /\bbrew\s+upgrade\b/i);
        assert.doesNotMatch(text, /\bnpm\s+update\b/i);
      }
      for (const command of plan.commands.filter(([file]) => file === 'git')) {
        assert.doesNotMatch(command.at(-1), /^(?:main|master|develop|staging|release)$/i);
      }
    }
  });

  it('rejects unpinned git sources before command construction', () => {
    const movingRef = structuredClone(COMPONENTS.serena);
    movingRef.ref = 'main';
    assert.throws(
      () => buildComponentInstallPlan(movingRef, '/components/serena/unsafe', 'linux'),
      /valid git ref pin/i,
    );

    const localUrl = structuredClone(COMPONENTS.serena);
    localUrl.repository = 'file:///untrusted/repository.git';
    assert.throws(
      () => buildComponentInstallPlan(localUrl, '/components/serena/unsafe', 'linux'),
      /HTTPS git URL/i,
    );

    const localPackage = structuredClone(COMPONENTS.semble);
    localPackage.package = 'file:///untrusted/wheel';
    assert.throws(
      () => buildComponentInstallPlan(localPackage, '/components/semble/unsafe', 'linux'),
      /safe Python package/i,
    );
  });
});

describe('GitHub binary install plans', () => {
  const platform = { os: 'linux', arch: 'x64' };
  const rtkDestination = destination('rtk', COMPONENTS.rtk);

  it('queries the immutable release tag and selects one matching platform asset', () => {
    const plan = buildComponentInstallPlan(COMPONENTS.rtk, rtkDestination, platform);
    const release = {
      assets: [
        { name: 'rtk-aarch64-unknown-linux-musl.tar.gz', browser_download_url: 'https://downloads.example/arm' },
        { name: 'rtk-x86_64-unknown-linux-musl.tar.gz', browser_download_url: 'https://downloads.example/x64' },
        { name: 'rtk-x86_64-unknown-linux-musl.tar.gz.sha256', browser_download_url: 'https://downloads.example/checksum' },
      ],
    };

    assert.deepEqual(plan.commands, [[
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
      'Accept: application/vnd.github+json',
      'https://api.github.com/repos/rtk-ai/rtk/releases/tags/v0.43.0',
    ]]);
    assert.equal(
      selectGithubBinaryAsset(release, platform)?.name,
      'rtk-x86_64-unknown-linux-musl.tar.gz',
    );
  });

  it('selects the published WinSW architecture asset without a Windows filename token', () => {
    const plan = buildComponentInstallPlan(
      COMPONENTS.winsw,
      destination('winsw', COMPONENTS.winsw),
      { os: 'windows', arch: 'x64' },
    );
    const release = {
      assets: [
        { name: 'WinSW-net461.exe', browser_download_url: 'https://downloads.example/net461' },
        { name: 'WinSW-x64.exe', browser_download_url: 'https://downloads.example/x64' },
      ],
    };

    assert.equal(plan.release.tag, COMPONENTS.winsw.ref);
    assert.equal(
      selectGithubBinaryAsset(release, { os: 'windows', arch: 'x64' })?.name,
      'WinSW-x64.exe',
    );
    assert.equal(
      selectGithubBinaryAsset(release, { os: 'windows', arch: 'arm64' })?.name,
      'WinSW-x64.exe',
    );
  });

  it('stages a checksummed binary using only injected execution and filesystem adapters', () => {
    const binary = Buffer.from('rtk-windows-binary');
    const asset = {
      name: 'rtk-x86_64-pc-windows-msvc.exe',
      browser_download_url: 'https://downloads.example/rtk.exe',
      digest: `sha256:${sha256(binary)}`,
    };
    const calls = [];
    const fs = makeFakeFs();
    const result = stageComponent({
      name: 'rtk',
      component: COMPONENTS.rtk,
      root: 'C:\\components',
      platform: { os: 'windows', arch: 'x64' },
      fs,
      exec(file, args, options) {
        calls.push({ file, args, options });
        if (args.at(-1).includes('/releases/tags/')) return JSON.stringify(makeRelease(asset));
        if (args.at(-1) === asset.browser_download_url) return binary;
        throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
      },
    });

    assert.equal(result.checksum.verified, true);
    assert.equal(result.checksum.algorithm, 'sha256');
    assert.equal(result.asset.name, asset.name);
    assert.deepEqual(calls.map(({ file, args }) => [file, args]), [
      [
        'curl',
        [
          '--fail',
          '--silent',
          '--show-error',
          '--location',
          '--proto',
          '=https',
          '--proto-redir',
          '=https',
          '--header',
          'Accept: application/vnd.github+json',
          'https://api.github.com/repos/rtk-ai/rtk/releases/tags/v0.43.0',
        ],
      ],
      [
        'curl',
        [
          '--fail',
          '--silent',
          '--show-error',
          '--location',
          '--proto',
          '=https',
          '--proto-redir',
          '=https',
          'https://downloads.example/rtk.exe',
        ],
      ],
    ]);
    assert.equal(fs.calls.some(([method]) => method === 'writeFileSync'), true);
  });

  it('fails closed when an advertised checksum does not match', () => {
    const binary = Buffer.from('rtk-windows-binary');
    const asset = {
      name: 'rtk-x86_64-pc-windows-msvc.exe',
      browser_download_url: 'https://downloads.example/rtk.exe',
      digest: `sha256:${'0'.repeat(64)}`,
    };
    const fs = makeFakeFs();

    assert.throws(
      () => stageComponent({
        name: 'rtk',
        component: COMPONENTS.rtk,
        root: '/components',
        platform: { os: 'windows', arch: 'x64' },
        fs,
        exec(_file, args) {
          return args.at(-1).includes('/releases/tags/')
            ? JSON.stringify(makeRelease(asset))
            : binary;
        },
      }),
      /checksum.*mismatch/i,
    );
    assert.equal(fs.calls.some(([method]) => method === 'writeFileSync'), false);
  });

  it('fails closed when an advertised checksum is malformed', () => {
    const binary = Buffer.from('rtk-windows-binary');
    const asset = {
      name: 'rtk-x86_64-pc-windows-msvc.exe',
      browser_download_url: 'https://downloads.example/rtk.exe',
      digest: '',
    };
    const fs = makeFakeFs();

    assert.throws(
      () => stageComponent({
        name: 'rtk',
        component: COMPONENTS.rtk,
        root: '/components',
        platform: { os: 'windows', arch: 'x64' },
        fs,
        exec(_file, args) {
          return args.at(-1).includes('/releases/tags/')
            ? JSON.stringify(makeRelease(asset))
            : binary;
        },
      }),
      /checksum.*malformed/i,
    );
    assert.equal(fs.calls.some(([method]) => method === 'writeFileSync'), false);
  });

  it('rejects tar traversal before extraction writes', () => {
    const archive = tarGzip('../outside', Buffer.from('nope'));
    const asset = {
      name: 'rtk-x86_64-unknown-linux-musl.tar.gz',
      browser_download_url: 'https://downloads.example/rtk.tar.gz',
      digest: `sha256:${sha256(archive)}`,
    };
    const fs = makeFakeFs();

    assert.throws(
      () => stageComponent({
        name: 'rtk',
        component: COMPONENTS.rtk,
        root: '/components',
        platform,
        fs,
        exec(_file, args) {
          return args.at(-1).includes('/releases/tags/')
            ? JSON.stringify(makeRelease(asset))
            : archive;
        },
      }),
      /unsafe archive path/i,
    );
    assert.equal(fs.calls.some(([method]) => method === 'writeFileSync'), false);
  });

  it('rejects zip-slip paths before extraction writes', () => {
    const archive = storedZip('../outside', Buffer.from('nope'));
    const asset = {
      name: 'rtk-x86_64-unknown-linux-musl.zip',
      browser_download_url: 'https://downloads.example/rtk.zip',
      digest: `sha256:${sha256(archive)}`,
    };
    const fs = makeFakeFs();

    assert.throws(
      () => stageComponent({
        name: 'rtk',
        component: COMPONENTS.rtk,
        root: '/components',
        platform,
        fs,
        exec(_file, args) {
          return args.at(-1).includes('/releases/tags/')
            ? JSON.stringify(makeRelease(asset))
            : archive;
        },
      }),
      /unsafe archive path/i,
    );
    assert.equal(fs.calls.some(([method]) => method === 'writeFileSync'), false);
  });

  it('rejects an archive file that shadows another entry parent', () => {
    const archive = tarGzipEntries([
      { name: 'rtk/child', content: Buffer.from('nope') },
      { name: 'rtk', content: Buffer.from('rtk') },
    ]);
    const asset = {
      name: 'rtk-x86_64-unknown-linux-musl.tar.gz',
      browser_download_url: 'https://downloads.example/rtk.tar.gz',
      digest: `sha256:${sha256(archive)}`,
    };
    const fs = makeFakeFs();

    assert.throws(
      () => stageComponent({
        name: 'rtk',
        component: COMPONENTS.rtk,
        root: '/components',
        platform,
        fs,
        exec(_file, args) {
          return args.at(-1).includes('/releases/tags/')
            ? JSON.stringify(makeRelease(asset))
            : archive;
        },
      }),
      /shadows a directory/i,
    );
    assert.equal(fs.calls.some(([method]) => method === 'writeFileSync'), false);
  });

  it('extracts a valid Windows archive with Windows path operations', () => {
    const binary = Buffer.from('rtk-windows-binary');
    const archive = storedZip('rtk.exe', binary);
    const asset = {
      name: 'rtk-x86_64-pc-windows-msvc.zip',
      browser_download_url: 'https://downloads.example/rtk.zip',
      digest: `sha256:${sha256(archive)}`,
    };
    const fs = makeFakeFs();

    stageComponent({
      name: 'rtk',
      component: COMPONENTS.rtk,
      root: 'C:\\components',
      platform: { os: 'windows', arch: 'x64' },
      fs,
      exec(_file, args) {
        return args.at(-1).includes('/releases/tags/')
          ? JSON.stringify(makeRelease(asset))
          : archive;
      },
    });

    const binaryPath = 'C:\\components\\rtk\\0.43.0\\bin\\rtk.exe';
    assert.equal(
      fs.calls.some(([method, path]) => method === 'writeFileSync' && path === binaryPath),
      true,
    );
    assert.equal(
      fs.calls.some(([method, path]) => method === 'mkdirSync' && path === '.'),
      false,
    );
  });
});

describe('staging and managed detection', () => {
  it('runs every staged command as a file-and-argument invocation', () => {
    const calls = [];
    const fs = makeFakeFs();
    const result = stageComponent({
      name: 'semble',
      component: COMPONENTS.semble,
      root: ROOT,
      platform: { os: 'linux', arch: 'x64' },
      fs,
      exec(file, args, options) {
        calls.push({ file, args, options });
      },
    });

    assert.equal(result.destination, '/components/semble/0.4.2');
    assert.deepEqual(calls, [
      {
        file: 'uv',
        args: ['venv', '--python', '3.12', '/components/semble/0.4.2'],
        options: { stdio: 'inherit' },
      },
      {
        file: 'uv',
        args: [
          'pip', 'install',
          '--python', '/components/semble/0.4.2',
          'semble[mcp]==0.4.2',
        ],
        options: { stdio: 'inherit' },
      },
    ]);
  });

  it('creates the fresh git-checkout parent directory before clone without precreating the version directory', () => {
    const trace = [];
    const fs = makeFakeFs();
    const originalMkdirSync = fs.mkdirSync;
    const originalLstatSync = fs.lstatSync;
    fs.mkdirSync = (...args) => {
      trace.push(['mkdirSync', ...args]);
      originalMkdirSync(...args);
    };
    fs.lstatSync = (...args) => {
      trace.push(['lstatSync', ...args]);
      return originalLstatSync(...args);
    };

    stageComponent({
      name: 'tokenOptimizer',
      component: COMPONENTS.tokenOptimizer,
      root: ROOT,
      platform: { os: 'linux', arch: 'x64' },
      fs,
      exec(file, args, options) {
        trace.push(['exec', file, args, options]);
      },
    });

    assert.deepEqual(trace[0], ['mkdirSync', '/components/tokenOptimizer', { recursive: true }]);
    assert.deepEqual(trace[1], ['lstatSync', '/components/tokenOptimizer/c8f8609']);
    assert.deepEqual(trace[2], [
      'exec',
      'git',
      ['clone', '--no-checkout', '--', 'https://github.com/alexgreensh/token-optimizer.git', '/components/tokenOptimizer/c8f8609'],
      { stdio: 'inherit' },
    ]);
    assert.equal(
      fs.calls.some(([method, path]) => method === 'mkdirSync' && path === '/components/tokenOptimizer/c8f8609'),
      false,
    );
  });

  it('uses Windows dirname rules for the fresh git-checkout parent directory', () => {
    const trace = [];
    const fs = makeFakeFs();
    const originalMkdirSync = fs.mkdirSync;
    const originalLstatSync = fs.lstatSync;
    fs.mkdirSync = (...args) => {
      trace.push(['mkdirSync', ...args]);
      originalMkdirSync(...args);
    };
    fs.lstatSync = (...args) => {
      trace.push(['lstatSync', ...args]);
      return originalLstatSync(...args);
    };

    stageComponent({
      name: 'tokenOptimizer',
      component: COMPONENTS.tokenOptimizer,
      root: 'C:\\components',
      platform: { os: 'windows', arch: 'x64' },
      fs,
      exec(file, args, options) {
        trace.push(['exec', file, args, options]);
      },
    });

    assert.deepEqual(trace[0], ['mkdirSync', 'C:\\components\\tokenOptimizer', { recursive: true }]);
    assert.deepEqual(trace[1], ['lstatSync', 'C:\\components\\tokenOptimizer\\c8f8609']);
    assert.deepEqual(trace[2], [
      'exec',
      'git',
      ['clone', '--no-checkout', '--', 'https://github.com/alexgreensh/token-optimizer.git', 'C:\\components\\tokenOptimizer\\c8f8609'],
      { stdio: 'inherit' },
    ]);
    assert.equal(
      fs.calls.some(([method, path]) => method === 'mkdirSync' && path === 'C:\\components\\tokenOptimizer\\c8f8609'),
      false,
    );
  });

  it('executes the versioned binary and compares its parsed version to the manifest', () => {
    const calls = [];
    const state = detectManagedComponent({
      name: 'agentcairn',
      component: COMPONENTS.agentcairn,
      root: ROOT,
      platform: { os: 'linux', arch: 'x64' },
      exec(file, args, options) {
        calls.push({ file, args, options });
        return Buffer.from('cairn 0.23.0\n');
      },
    });

    assert.deepEqual(calls, [{
      file: '/components/agentcairn/0.23.0/bin/cairn',
      args: ['--version'],
      options: { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    }]);
    assert.equal(state.installed, true);
    assert.equal(state.parsedVersion, COMPONENTS.agentcairn.version);
    assert.equal(state.pinnedVersion, COMPONENTS.agentcairn.version);
    assert.equal(state.pinnedVersionMatches, true);
  });

  it('does not accept a prefix match as the pinned version', () => {
    const state = detectManagedComponent({
      name: 'semble',
      component: COMPONENTS.semble,
      root: ROOT,
      platform: { os: 'linux', arch: 'x64' },
      exec() {
        return Buffer.from('semble 0.4.20\n');
      },
    });

    assert.equal(state.parsedVersion, '0.4.20');
    assert.equal(state.pinnedVersionMatches, false);
  });

  it('probes Semble metadata through its versioned virtual environment', () => {
    const calls = [];
    const state = detectManagedComponent({
      name: 'semble',
      component: COMPONENTS.semble,
      root: ROOT,
      platform: { os: 'linux', arch: 'x64' },
      exec(file, args, options) {
        calls.push({ file, args, options });
        return Buffer.from('0.4.2\n');
      },
    });

    assert.equal(state.pinnedVersionMatches, true);
    assert.deepEqual(calls, [{
      file: '/components/semble/0.4.2/bin/python',
      args: ['-c', 'from importlib.metadata import version; print(version("semble"))'],
      options: { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    }]);
  });

  it('runs npm staging through a hardened Windows cmd.exe adapter', () => {
    const calls = [];
    const fs = makeFakeFs();
    stageComponent({
      name: 'astGrep',
      component: COMPONENTS.astGrep,
      root: 'C:\\components',
      platform: { os: 'windows', arch: 'x64' },
      fs,
      exec(file, args, options) {
        calls.push({ file, args, options });
      },
    });

    assert.deepEqual(calls, [{
      file: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'npm "install" "--prefix" "C:\\components\\astGrep\\0.44.1" "@ast-grep/cli@0.44.1"',
      ],
      options: { stdio: 'inherit', windowsVerbatimArguments: true },
    }]);
  });

  it('fails closed before any staged command when the immutable version destination already exists', () => {
    const trace = [];
    const fs = makeFakeFs({
      '/components/tokenOptimizer/c8f8609': makeFakeStatus('directory'),
      '/components/tokenOptimizer/c8f8609/.myelin-stage-complete': makeFakeStatus('file'),
    });
    const originalMkdirSync = fs.mkdirSync;
    fs.mkdirSync = (...args) => {
      trace.push(['mkdirSync', ...args]);
      originalMkdirSync(...args);
    };
    const originalLstatSync = fs.lstatSync;
    fs.lstatSync = (...args) => {
      trace.push(['lstatSync', ...args]);
      return originalLstatSync(...args);
    };

    assert.throws(
      () => stageComponent({
        name: 'tokenOptimizer',
        component: COMPONENTS.tokenOptimizer,
        root: ROOT,
        platform: 'linux',
        fs,
        exec(file, args, options) {
          trace.push(['exec', file, args, options]);
        },
      }),
      /immutable stage destination already exists/i,
    );
    assert.deepEqual(trace, [
      ['mkdirSync', '/components/tokenOptimizer', { recursive: true }],
      ['lstatSync', '/components/tokenOptimizer/c8f8609'],
      ['lstatSync', '/components/tokenOptimizer/c8f8609/.myelin-stage-complete'],
    ]);
  });

  it('fails closed before any GitHub download or write when the immutable binary destination already exists', () => {
    const binary = Buffer.from('rtk-windows-binary');
    const asset = {
      name: 'rtk-x86_64-pc-windows-msvc.exe',
      browser_download_url: 'https://downloads.example/rtk.exe',
      digest: `sha256:${sha256(binary)}`,
    };
    const calls = [];
    const fs = makeFakeFs({
      'C:\\components\\rtk\\0.43.0': makeFakeStatus('directory'),
      'C:\\components\\rtk\\0.43.0\\.myelin-stage-complete': makeFakeStatus('file'),
    });

    assert.throws(
      () => stageComponent({
        name: 'rtk',
        component: COMPONENTS.rtk,
        root: 'C:\\components',
        platform: { os: 'windows', arch: 'x64' },
        fs,
        exec(file, args, options) {
          calls.push({ file, args, options });
          if (args.at(-1).includes('/releases/tags/')) return JSON.stringify(makeRelease(asset));
          if (args.at(-1) === asset.browser_download_url) return binary;
          throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
        },
      }),
      /immutable stage destination already exists/i,
    );
    assert.deepEqual(calls, []);
    assert.equal(fs.calls.some(([method]) => method === 'writeFileSync'), false);
  });

  it('re-checks the immutable GitHub binary destination before follow-on downloads and writes', () => {
    const binary = Buffer.from('rtk-windows-binary');
    const asset = {
      name: 'rtk-x86_64-pc-windows-msvc.exe',
      browser_download_url: 'https://downloads.example/rtk.exe',
      digest: `sha256:${sha256(binary)}`,
    };
    const calls = [];
    const fs = makeFakeFs();

    assert.throws(
      () => stageComponent({
        name: 'rtk',
        component: COMPONENTS.rtk,
        root: 'C:\\components',
        platform: { os: 'windows', arch: 'x64' },
        fs,
        exec(file, args, options) {
          calls.push({ file, args, options });
          if (args.at(-1).includes('/releases/tags/')) {
            fs.existing.set('C:\\components\\rtk\\0.43.0', makeFakeStatus('directory'));
            return JSON.stringify(makeRelease(asset));
          }
          if (args.at(-1) === asset.browser_download_url) return binary;
          throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
        },
      }),
      /immutable stage destination already exists/i,
    );
    assert.deepEqual(calls.map(({ file, args }) => [file, args]), [[
      'curl',
      [
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--header',
        'Accept: application/vnd.github+json',
        'https://api.github.com/repos/rtk-ai/rtk/releases/tags/v0.43.0',
      ],
    ]]);
    assert.equal(fs.calls.some(([method]) => method === 'writeFileSync'), false);
  });

  it('runs a Windows npm .cmd shim through the hardened cmd.exe adapter', () => {
    const calls = [];
    const state = detectManagedComponent({
      name: 'astGrep',
      component: COMPONENTS.astGrep,
      root: 'C:\\components',
      platform: { os: 'windows', arch: 'x64' },
      exec(file, args, options) {
        calls.push({ file, args, options });
        return Buffer.from('ast-grep 0.44.1\n');
      },
    });

    assert.equal(state.pinnedVersionMatches, true);
    assert.equal(calls[0].file, 'cmd.exe');
    assert.deepEqual(calls[0].args, [
      '/d',
      '/s',
      '/c',
      'call "C:\\components\\astGrep\\0.44.1\\node_modules\\.bin\\ast-grep.cmd" "--version"',
    ]);
    assert.equal(calls[0].options.windowsVerbatimArguments, true);
  });
});
