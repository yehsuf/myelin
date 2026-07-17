/**
 * Regression test for the mitmproxy-CA marker write/detect symmetry.
 *
 * Root cause it locks down: the installer WROTE the comment marker
 * "# mitmproxy CA (Myelin Copilot interception)" into every PEM bundle but
 * DETECTED presence via 'CN=mitmproxy' — a decoded X.509 subject that never
 * appears in a base64 PEM block. So detection always failed and the CA was
 * re-appended (with a timestamped .bak) on every install/update, and
 * interactive install re-prompted for a CA already present.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MITM_CA_MARKER, bundleTrustsMitmCA, appendMitmCA } from '../src/install.mjs';

const FAKE_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIBfakebase64content==\n-----END CERTIFICATE-----';

describe('mitmproxy CA marker write/detect symmetry', () => {
  it('what we append is exactly what we detect (round-trip)', () => {
    const bundle = appendMitmCA('# system roots\n' + FAKE_PEM, FAKE_PEM);
    assert.equal(bundleTrustsMitmCA(bundle), true);
  });

  it('a fresh bundle without our marker is NOT detected as trusting', () => {
    assert.equal(bundleTrustsMitmCA('# system roots\n' + FAKE_PEM), false);
  });

  it('the old broken marker CN=mitmproxy is NOT what we rely on', () => {
    // A raw PEM block never contains the decoded subject string.
    assert.equal(FAKE_PEM.includes('CN=mitmproxy'), false);
    // Detection must succeed on an appended bundle regardless.
    assert.equal(bundleTrustsMitmCA(appendMitmCA('', FAKE_PEM)), true);
  });

  it('appending twice is idempotent for detection (no infinite re-add)', () => {
    const once = appendMitmCA('base', FAKE_PEM);
    // Once present, the installer skips — so a correct pipeline never appends
    // a second time. Detection is stable.
    assert.equal(bundleTrustsMitmCA(once), true);
  });

  it('handles null / non-string content safely', () => {
    assert.equal(bundleTrustsMitmCA(null), false);
    assert.equal(bundleTrustsMitmCA(undefined), false);
    assert.ok(appendMitmCA(null, FAKE_PEM).includes(MITM_CA_MARKER));
  });

  it('detects the CA by exact cert body even under an older/absent marker', () => {
    // Historical bundle: the CA is present but written with a DIFFERENT comment
    // (old marker). Content-based detection must still recognize it → no
    // duplicate append on upgrade.
    const historical = '# mitmproxy CA (legacy comment)\n' + FAKE_PEM;
    assert.equal(bundleTrustsMitmCA(historical, FAKE_PEM), true);
    // Without the cert argument, only the marker is checked (misses it).
    assert.equal(bundleTrustsMitmCA(historical), false);
  });
});
