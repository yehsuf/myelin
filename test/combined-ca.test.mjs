import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, posix } from 'node:path';
import { buildCombinedCaCert, base64ToPem, certHasKeyCertSign, filterBundleForKeyUsage } from '../src/detect/combined-ca.mjs';

const HOME = '/home/testuser';
const COMBINED_PATH = join(HOME, '.myelin', 'ca-bundle.pem');
const ROOT_CA_PATH = '/etc/ssl/root-ca.pem';

// Valid PEM with body line 'ABCDEFGH' at index 1
const POSIX_PEM_OUTPUT = '-----BEGIN CERTIFICATE-----\nABCDEFGH\n-----END CERTIFICATE-----';

function makeMocks(overrides = {}) {
  const calls = {
    execSync: [],
    readFileSync: [],
    writeFileSync: [],
    detectOS: [],
  };
  const mocks = {
    execSyncImpl: (cmd, opts) => {
      calls.execSync.push({ cmd, opts });
      return Buffer.from('');
    },
    readFileSyncImpl: (p, enc) => {
      calls.readFileSync.push({ p, enc });
      return '';
    },
    writeFileSyncImpl: (p, content, enc) => {
      calls.writeFileSync.push({ p, content, enc });
    },
    detectOSImpl: () => {
      calls.detectOS.push(true);
      return 'linux';
    },
    ...overrides,
  };
  return { calls, mocks };
}

describe('base64ToPem', () => {
  it('wraps valid base64 with BEGIN/END markers and 64-char lines', () => {
    const input = 'A'.repeat(200);
    const pem = base64ToPem(input);
    assert.ok(pem.startsWith('-----BEGIN CERTIFICATE-----\n'), 'must start with BEGIN header');
    assert.ok(pem.endsWith('\n-----END CERTIFICATE-----'), 'must end with END footer');
    const body = pem.split('\n').slice(1, -1);
    for (const line of body) {
      assert.ok(line.length <= 64, `line too long: ${line.length}`);
    }
    // 200 chars / 64 => 4 lines
    assert.equal(body.length, 4);
  });

  it('returns empty string on empty input', () => {
    assert.equal(base64ToPem(''), '');
  });

  it('returns empty string on null/undefined input', () => {
    assert.equal(base64ToPem(null), '');
    assert.equal(base64ToPem(undefined), '');
  });

  it('strips whitespace before wrapping', () => {
    assert.equal(
      base64ToPem('AA BB\nCC\tDD'),
      '-----BEGIN CERTIFICATE-----\nAABBCCDD\n-----END CERTIFICATE-----',
    );
  });
});

describe('buildCombinedCaCert — guards', () => {
  it('returns null when rootCaPath is null', async () => {
    const { calls, mocks } = makeMocks();
    const result = await buildCombinedCaCert(null, HOME, mocks);
    assert.equal(result, null);
    assert.equal(calls.execSync.length, 0);
    assert.equal(calls.readFileSync.length, 0);
    assert.equal(calls.writeFileSync.length, 0);
  });
});

describe('buildCombinedCaCert — Windows', () => {
  it('Windows happy path builds combined bundle', async () => {
    const b64 = 'AABB' + 'C'.repeat(60);
    const { calls, mocks } = makeMocks({
      detectOSImpl: () => 'windows',
      execSyncImpl: () => Buffer.from(b64),
      readFileSyncImpl: () => 'ROOT-CERT-CONTENT',
      writeFileSyncImpl: (p, content, enc) => {
        calls.writeFileSync.push({ p, content, enc });
      },
    });
    const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
    assert.equal(calls.writeFileSync.length, 1);
    assert.equal(calls.writeFileSync[0].p, COMBINED_PATH);
    const written = calls.writeFileSync[0].content;
    assert.ok(written.includes('ROOT-CERT-CONTENT'));
    assert.ok(written.includes('# Intermediate CA'));
    assert.ok(written.includes('-----BEGIN CERTIFICATE-----'));
    assert.equal(result, COMBINED_PATH);
  });

  it('Windows PowerShell throws → returns rootCaPath', async () => {
    const { calls, mocks } = makeMocks({
      detectOSImpl: () => 'windows',
      execSyncImpl: () => { throw new Error('powershell not found'); },
    });
    const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
    assert.equal(result, ROOT_CA_PATH);
    assert.equal(calls.writeFileSync.length, 0);
  });

  it('Windows PowerShell returns empty stdout → returns rootCaPath', async () => {
    const { calls, mocks } = makeMocks({
      detectOSImpl: () => 'windows',
      execSyncImpl: () => Buffer.from(''),
    });
    const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
    assert.equal(result, ROOT_CA_PATH);
    assert.equal(calls.writeFileSync.length, 0);
  });

  it('Windows PowerShell returns whitespace-only → returns rootCaPath', async () => {
    const { calls, mocks } = makeMocks({
      detectOSImpl: () => 'windows',
      execSyncImpl: () => Buffer.from('   \n  \r\n'),
    });
    const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
    assert.equal(result, ROOT_CA_PATH);
    assert.equal(calls.writeFileSync.length, 0);
  });

  it('Windows: PowerShell invoked with correct flags', async () => {
    const { calls, mocks } = makeMocks({
      detectOSImpl: () => 'windows',
      execSyncImpl: (cmd, opts) => {
        calls.execSync.push({ cmd, opts });
        return Buffer.from('');
      },
    });
    await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
    assert.equal(calls.execSync.length, 1);
    assert.match(
      calls.execSync[0].cmd,
      /powershell.*-NonInteractive.*-NoProfile.*-Command.*-/,
    );
  });

  it('Windows: script passed via stdin input option and contains X509Chain', async () => {
    const { calls, mocks } = makeMocks({
      detectOSImpl: () => 'windows',
      execSyncImpl: (cmd, opts) => {
        calls.execSync.push({ cmd, opts });
        return Buffer.from('');
      },
    });
    await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
    assert.equal(calls.execSync.length, 1);
    const opts = calls.execSync[0].opts;
    assert.equal(typeof opts.input, 'string');
    assert.ok(opts.input.includes('X509Chain'));
    assert.ok(opts.input.includes('ChainElements[1]'));
    assert.ok(opts.input.includes('$req.Proxy = $null'));
  });

  it('Windows: dedup skips write when intermediate body already in root', async () => {
    // base64 body of 'XYZ' padded to 64+ chars => body line will be 'XYZ...' char sequence
    const b64 = 'XYZ' + 'A'.repeat(61); // 64 chars total, one line
    const pem = base64ToPem(b64);
    const bodyLine = pem.split('\n')[1].trim();
    const { calls, mocks } = makeMocks({
      detectOSImpl: () => 'windows',
      execSyncImpl: () => Buffer.from(b64),
      readFileSyncImpl: () => `some root cert containing ${bodyLine} inline`,
    });
    const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
    assert.equal(calls.writeFileSync.length, 0);
    assert.equal(result, ROOT_CA_PATH);
  });

  it('Windows: force=true skips dedup and writes anyway', async () => {
    const b64 = 'XYZ' + 'A'.repeat(61);
    const pem = base64ToPem(b64);
    const bodyLine = pem.split('\n')[1].trim();
    const { calls, mocks } = makeMocks({
      detectOSImpl: () => 'windows',
      execSyncImpl: () => Buffer.from(b64),
      readFileSyncImpl: () => `some root cert containing ${bodyLine} inline`,
    });
    const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, { ...mocks, force: true });
    assert.equal(calls.writeFileSync.length, 1);
    assert.equal(result, COMBINED_PATH);
  });

  it('Windows: readFileSync throws → returns rootCaPath', async () => {
    const b64 = 'A'.repeat(64);
    const { calls, mocks } = makeMocks({
      detectOSImpl: () => 'windows',
      execSyncImpl: () => Buffer.from(b64),
      readFileSyncImpl: () => { throw new Error('EACCES'); },
    });
    const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
    assert.equal(result, ROOT_CA_PATH);
    assert.equal(calls.writeFileSync.length, 0);
  });

  it('Windows: writeFileSync throws → returns rootCaPath', async () => {
    const b64 = 'A'.repeat(64);
    const { calls, mocks } = makeMocks({
      detectOSImpl: () => 'windows',
      execSyncImpl: () => Buffer.from(b64),
      readFileSyncImpl: () => 'ROOT',
      writeFileSyncImpl: () => { throw new Error('EROFS'); },
    });
    const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
    assert.equal(result, ROOT_CA_PATH);
  });
});

describe('buildCombinedCaCert — POSIX', () => {
  it('POSIX happy path (regression guard)', async () => {
    const { calls, mocks } = makeMocks({
      detectOSImpl: () => 'linux',
      execSyncImpl: () => POSIX_PEM_OUTPUT,
      readFileSyncImpl: () => 'ROOT',
    });
    const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
    assert.equal(calls.writeFileSync.length, 1);
    const written = calls.writeFileSync[0].content;
    assert.ok(written.includes('ROOT'));
    assert.ok(written.includes('-----BEGIN CERTIFICATE-----'));
    assert.equal(result, COMBINED_PATH);
  });

  it('POSIX: non-PEM output → returns rootCaPath', async () => {
    const { calls, mocks } = makeMocks({
      detectOSImpl: () => 'linux',
      execSyncImpl: () => 'connection refused',
    });
    const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
    assert.equal(result, ROOT_CA_PATH);
    assert.equal(calls.writeFileSync.length, 0);
  });
});

describe('buildCombinedCaCert — honors MYELIN_DIR', () => {
  it('writes the combined bundle beneath MYELIN_DIR when set', async () => {
    const prev = process.env.MYELIN_DIR;
    process.env.MYELIN_DIR = '/custom/managed-root';
    try {
      const { calls, mocks } = makeMocks({
        detectOSImpl: () => 'linux',
        execSyncImpl: () => POSIX_PEM_OUTPUT,
        readFileSyncImpl: () => 'ROOT',
      });
      const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
      const expected = posix.join('/custom/managed-root', 'ca-bundle.pem');
      assert.equal(calls.writeFileSync[0].p, expected);
      assert.equal(result, expected);
    } finally {
      if (prev === undefined) delete process.env.MYELIN_DIR;
      else process.env.MYELIN_DIR = prev;
    }
  });

  it('treats a blank/whitespace MYELIN_DIR as absent and falls back to home/.myelin', async () => {
    const prev = process.env.MYELIN_DIR;
    process.env.MYELIN_DIR = '   \t ';
    try {
      const { calls, mocks } = makeMocks({
        detectOSImpl: () => 'linux',
        execSyncImpl: () => POSIX_PEM_OUTPUT,
        readFileSyncImpl: () => 'ROOT',
      });
      const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
      assert.equal(calls.writeFileSync[0].p, COMBINED_PATH);
      assert.equal(result, COMBINED_PATH);
    } finally {
      if (prev === undefined) delete process.env.MYELIN_DIR;
      else process.env.MYELIN_DIR = prev;
    }
  });

  it('honors an injected env.MYELIN_DIR without touching process.env', async () => {
    const prev = process.env.MYELIN_DIR;
    delete process.env.MYELIN_DIR;
    try {
      const { calls, mocks } = makeMocks({
        env: { MYELIN_DIR: '/injected/managed-root' },
        detectOSImpl: () => 'linux',
        execSyncImpl: () => POSIX_PEM_OUTPUT,
        readFileSyncImpl: () => 'ROOT',
      });
      const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
      const expected = posix.join('/injected/managed-root', 'ca-bundle.pem');
      assert.equal(calls.writeFileSync[0].p, expected);
      assert.equal(result, expected);
      // Injected env must not leak into the ambient process env.
      assert.equal(process.env.MYELIN_DIR, undefined);
    } finally {
      if (prev === undefined) delete process.env.MYELIN_DIR;
      else process.env.MYELIN_DIR = prev;
    }
  });

  it('injected env overrides the ambient process.env.MYELIN_DIR', async () => {
    const prev = process.env.MYELIN_DIR;
    process.env.MYELIN_DIR = '/ambient/managed-root';
    try {
      const { calls, mocks } = makeMocks({
        env: { MYELIN_DIR: '/injected/wins' },
        detectOSImpl: () => 'linux',
        execSyncImpl: () => POSIX_PEM_OUTPUT,
        readFileSyncImpl: () => 'ROOT',
      });
      const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
      const expected = posix.join('/injected/wins', 'ca-bundle.pem');
      assert.equal(calls.writeFileSync[0].p, expected);
      assert.equal(result, expected);
    } finally {
      if (prev === undefined) delete process.env.MYELIN_DIR;
      else process.env.MYELIN_DIR = prev;
    }
  });
});

describe('buildCombinedCaCert — combined path invariant', () => {
  it('combined path is always join(home, ".myelin", "ca-bundle.pem") for both OSes', async () => {
    // windows
    const b64 = 'A'.repeat(64);
    const win = makeMocks({
      detectOSImpl: () => 'windows',
      execSyncImpl: () => Buffer.from(b64),
      readFileSyncImpl: () => 'ROOT',
    });
    await buildCombinedCaCert(ROOT_CA_PATH, HOME, win.mocks);
    assert.equal(win.calls.writeFileSync[0].p, COMBINED_PATH);

    // linux
    const lin = makeMocks({
      detectOSImpl: () => 'linux',
      execSyncImpl: () => POSIX_PEM_OUTPUT,
      readFileSyncImpl: () => 'ROOT',
    });
    await buildCombinedCaCert(ROOT_CA_PATH, HOME, lin.mocks);
    assert.equal(lin.calls.writeFileSync[0].p, COMBINED_PATH);
  });
});

// Helper PEM fixtures for testing certHasKeyCertSign and filterBundleForKeyUsage.
// These encode minimal DER structures — not valid X.509 certs, just enough for the scanner.

// DER: SEQUENCE { OID 2.5.29.15, BOOL critical=true, OCTET STRING { BIT STRING { 01 pad, 0x86=keyCertSign+cRLSign+digitalSig } } }
// Structure: 30 0d 06 03 55 1d 0f 01 01 ff 04 04 03 02 01 86
const PEM_WITH_KEY_CERT_SIGN = (() => {
  const der = Buffer.from([0x30, 0x0d, 0x06, 0x03, 0x55, 0x1d, 0x0f, 0x01, 0x01, 0xff, 0x04, 0x04, 0x03, 0x02, 0x01, 0x86]);
  const b64 = der.toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return '-----BEGIN CERTIFICATE-----\n' + lines.join('\n') + '\n-----END CERTIFICATE-----';
})();

// DER: keyUsage present (OID found) but keyCertSign bit NOT set (bits = 0xa0 = digitalSignature + keyEncipherment)
// Structure: 30 0d 06 03 55 1d 0f 01 01 ff 04 04 03 02 01 a0
const PEM_WITH_KEY_USAGE_NO_CERT_SIGN = (() => {
  const der = Buffer.from([0x30, 0x0d, 0x06, 0x03, 0x55, 0x1d, 0x0f, 0x01, 0x01, 0xff, 0x04, 0x04, 0x03, 0x02, 0x01, 0xa0]);
  const b64 = der.toString('base64');
  return '-----BEGIN CERTIFICATE-----\n' + b64 + '\n-----END CERTIFICATE-----';
})();

// DER: no keyUsage extension at all (only basicConstraints OID 55 1d 13)
const PEM_WITHOUT_KEY_USAGE = (() => {
  const der = Buffer.from([0x30, 0x06, 0x06, 0x03, 0x55, 0x1d, 0x13]);
  const b64 = der.toString('base64');
  return '-----BEGIN CERTIFICATE-----\n' + b64 + '\n-----END CERTIFICATE-----';
})();

// Keep backward-compatible alias
const PEM_WITH_KEY_USAGE = PEM_WITH_KEY_CERT_SIGN;

describe('certHasKeyCertSign', () => {
  it('returns true when keyUsage extension has keyCertSign bit set (critical, 0x86)', () => {
    assert.equal(certHasKeyCertSign(PEM_WITH_KEY_CERT_SIGN), true);
  });

  it('returns false when keyUsage extension is present but keyCertSign bit is NOT set (0xa0 = digitalSig + keyEncipher)', () => {
    assert.equal(certHasKeyCertSign(PEM_WITH_KEY_USAGE_NO_CERT_SIGN), false);
  });

  it('returns false when keyUsage OID is absent entirely', () => {
    assert.equal(certHasKeyCertSign(PEM_WITHOUT_KEY_USAGE), false);
  });

  it('returns false for empty string', () => {
    assert.equal(certHasKeyCertSign(''), false);
  });

  it('returns false for a non-PEM string', () => {
    assert.equal(certHasKeyCertSign('not a cert'), false);
  });

  it('handles non-critical keyUsage extension (no BOOLEAN 01 01 ff)', () => {
    // Non-critical: 30 0b 06 03 55 1d 0f 04 04 03 02 01 86 (no critical BOOLEAN)
    const der = Buffer.from([0x30, 0x0b, 0x06, 0x03, 0x55, 0x1d, 0x0f, 0x04, 0x04, 0x03, 0x02, 0x01, 0x86]);
    const b64 = der.toString('base64');
    const pem = '-----BEGIN CERTIFICATE-----\n' + b64 + '\n-----END CERTIFICATE-----';
    assert.equal(certHasKeyCertSign(pem), true);
  });
});

describe('filterBundleForKeyUsage', () => {
  it('keeps certs with keyUsage.keyCertSign set', () => {
    const bundle = PEM_WITH_KEY_CERT_SIGN + '\n' + PEM_WITHOUT_KEY_USAGE;
    const filtered = filterBundleForKeyUsage(bundle);
    assert.ok(filtered.includes('BEGIN CERTIFICATE'));
    assert.ok(filtered.length < bundle.length, 'bundle should be shorter after removing no-keyCertSign cert');
  });

  it('removes certs where keyUsage is absent', () => {
    const bundle = PEM_WITH_KEY_CERT_SIGN + '\n' + PEM_WITHOUT_KEY_USAGE;
    const filtered = filterBundleForKeyUsage(bundle);
    const count = (filtered.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
    assert.equal(count, 1, 'only one cert should remain');
  });

  it('also removes certs where keyUsage is present but keyCertSign bit is NOT set', () => {
    const bundle = PEM_WITH_KEY_CERT_SIGN + '\n' + PEM_WITH_KEY_USAGE_NO_CERT_SIGN;
    const filtered = filterBundleForKeyUsage(bundle);
    const count = (filtered.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
    assert.equal(count, 1, 'cert without keyCertSign should be removed even if keyUsage OID present');
  });

  it('returns original content unchanged when no certs have keyCertSign (fail-open)', () => {
    const bundle = PEM_WITHOUT_KEY_USAGE + '\n' + PEM_WITH_KEY_USAGE_NO_CERT_SIGN;
    const filtered = filterBundleForKeyUsage(bundle);
    assert.equal(filtered, bundle, 'fail-open: never produce an empty bundle');
  });

  it('returns original content for empty input (fail-open)', () => {
    assert.equal(filterBundleForKeyUsage(''), '');
  });
});

describe('buildCombinedCaCert — keyUsage filter on Windows empty PS output', () => {
  it('when PS returns empty AND no existing ca-bundle → returns rootCaPath, no write', async () => {
    const { calls, mocks } = makeMocks({
      detectOSImpl: () => 'windows',
      execSyncImpl: () => Buffer.from(''),
      // readFileSyncImpl default returns '' → existing bundle is empty
    });
    const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
    assert.equal(result, ROOT_CA_PATH);
    assert.equal(calls.writeFileSync.length, 0);
  });

  it('when PS returns empty AND existing bundle has certs lacking keyUsage → rewrites filtered, returns combinedPath', async () => {
    const { calls, mocks } = makeMocks({
      detectOSImpl: () => 'windows',
      execSyncImpl: () => Buffer.from(''),
      readFileSyncImpl: (p) => {
        // Simulate: combinedPath has a mix of good and bad certs
        if (p === COMBINED_PATH) return PEM_WITH_KEY_USAGE + '\n' + PEM_WITHOUT_KEY_USAGE;
        return ''; // rootCaPath
      },
    });
    const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
    assert.equal(result, COMBINED_PATH);
    assert.equal(calls.writeFileSync.length, 1, 'should have rewritten the filtered bundle');
    const written = calls.writeFileSync[0].content;
    assert.ok(written.includes('BEGIN CERTIFICATE'), 'written bundle must have certs');
    // The cert without keyUsage must be absent
    const withoutB64 = PEM_WITHOUT_KEY_USAGE.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    assert.ok(!written.includes(withoutB64.slice(0, 10)), 'cert lacking keyUsage should be removed');
  });

  it('when PS returns empty AND existing bundle is already clean → returns combinedPath, no write', async () => {
    const { calls, mocks } = makeMocks({
      detectOSImpl: () => 'windows',
      execSyncImpl: () => Buffer.from(''),
      readFileSyncImpl: (p) => {
        if (p === COMBINED_PATH) return PEM_WITH_KEY_USAGE; // already fully clean
        return '';
      },
    });
    const result = await buildCombinedCaCert(ROOT_CA_PATH, HOME, mocks);
    assert.equal(result, COMBINED_PATH);
    assert.equal(calls.writeFileSync.length, 0, 'already clean → no write');
  });
});
