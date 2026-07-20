/**
 * Build a combined CA bundle: detected root CA + intermediate CA extracted
 * from the live TLS chain at api.github.com:443.
 * Required when a corporate SSL interceptor uses an intermediate CA that
 * isn't in the standard trust store.
 *
 * Extracted from src/install.mjs for testability (DI via options object).
 * Supports Mac/Linux (openssl s_client) and Windows (PowerShell X509Chain).
 *
 * Also filters out CA certificates that lack the Key Usage extension, which
 * Python 3.13+ requires (ssl.SSLCertVerificationError: CA cert does not include
 * key usage extension). Old corporate root CAs (e.g. NetFree v1) predate this
 * requirement and cause connection failures with newer Python runtimes.
 */
import { execSync as _execSync } from 'node:child_process';
import { readFileSync as _readFileSync, writeFileSync as _writeFileSync } from 'node:fs';
import { managedPaths } from '../shared/myelin-paths.mjs';
import { detectOS as _detectOS } from './os.mjs';

// PowerShell script: build X509Chain to api.github.com and print intermediate
// cert as base64 to stdout. Prints empty on any failure.
// $req.Proxy = $null forces a direct connection, bypassing mitmproxy/corp proxy
// so we see the REAL TLS chain (same behaviour as the POSIX unset HTTPS_PROXY).
const PS_INTERMEDIATE_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $req = [Net.HttpWebRequest]::Create('https://api.github.com')
  $req.Method = 'HEAD'
  $req.Timeout = 12000
  $req.Proxy = $null
  try { $resp = $req.GetResponse(); $resp.Close() } catch { }
  $leaf = $req.ServicePoint.Certificate
  if (-not $leaf) { exit 0 }
  $chain = New-Object Security.Cryptography.X509Certificates.X509Chain
  $chain.ChainPolicy.RevocationMode = 'NoCheck'
  $null = $chain.Build((New-Object Security.Cryptography.X509Certificates.X509Certificate2 $leaf))
  if ($chain.ChainElements.Count -lt 2) { exit 0 }
  $inter = $chain.ChainElements[1].Certificate
  $bytes = $inter.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)
  Write-Output ([Convert]::ToBase64String($bytes))
} catch { exit 0 }
`.trim();

/**
 * Wrap a raw base64 DER blob as a PEM certificate (64-char line wrap).
 * @param {string} b64
 * @returns {string} PEM string or '' if input is empty/null
 */
export function base64ToPem(b64) {
  const clean = (b64 || '').replace(/\s+/g, '');
  if (!clean) return '';
  const lines = [];
  for (let i = 0; i < clean.length; i += 64) lines.push(clean.slice(i, i + 64));
  return '-----BEGIN CERTIFICATE-----\n' + lines.join('\n') + '\n-----END CERTIFICATE-----';
}

// Key Usage extension OID: 2.5.29.15 (encoded in DER as three bytes 55 1d 0f)
const KEY_USAGE_OID_B0 = 0x55;
const KEY_USAGE_OID_B1 = 0x1d;
const KEY_USAGE_OID_B2 = 0x0f;

/**
 * Return true if the PEM-encoded certificate contains the Key Usage extension.
 * Uses a direct DER byte scan — no ASN.1 library needed.
 * The OID 2.5.29.15 (hex 55:1d:0f) uniquely identifies the extension.
 * @param {string} pem
 * @returns {boolean}
 */
export function certHasKeyUsageExtension(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  if (!b64) return false;
  const der = Buffer.from(b64, 'base64');
  for (let i = 0; i < der.length - 2; i++) {
    if (der[i] === KEY_USAGE_OID_B0 && der[i + 1] === KEY_USAGE_OID_B1 && der[i + 2] === KEY_USAGE_OID_B2) return true;
  }
  return false;
}

/**
 * Remove CA certificates that lack the Key Usage extension from a PEM bundle.
 *
 * Python 3.13+ requires every CA cert in the verified chain to have the
 * keyUsage extension with the keyCertSign bit set. Legacy corporate root CAs
 * (e.g. NetFree v1 roots, old per-ISP signing certs) were issued before this
 * extension was mandatory and will cause ssl.SSLCertVerificationError on
 * Python 3.13+. Modern CAs (certifi bundle, mitmproxy, NetFree X2) all include
 * the extension, so filtering out certs without it is safe.
 *
 * If the filter would remove ALL certificates, returns the original content
 * unchanged (fail-open: better to have old certs than an empty bundle).
 *
 * @param {string} bundleContent  PEM bundle, may contain comments/blank lines
 * @returns {string} filtered bundle
 */
export function filterBundleForKeyUsage(bundleContent) {
  const pemRe = /(-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----)/g;
  const kept = [];
  let match;
  while ((match = pemRe.exec(bundleContent)) !== null) {
    if (certHasKeyUsageExtension(match[1])) kept.push(match[1]);
  }
  if (kept.length === 0) return bundleContent; // fail-open: never produce an empty bundle
  return kept.join('\n') + '\n';
}

/**
 * Build a combined CA bundle (root + intermediate).
 * Returns the combined path on success, rootCaPath on any failure (fail-open).
 *
 * @param {string|null} rootCaPath
 * @param {string} home  home directory
 * @param {object} opts
 * @param {boolean} [opts.force=false]  skip dedup check
 * @param {object} [opts.env]  environment used to resolve the managed root (MYELIN_DIR)
 * @param {function} [opts.execSyncImpl]
 * @param {function} [opts.readFileSyncImpl]
 * @param {function} [opts.writeFileSyncImpl]
 * @param {function} [opts.detectOSImpl]
 */
export async function buildCombinedCaCert(
  rootCaPath,
  home,
  {
    force = false,
    env = process.env,
    execSyncImpl = _execSync,
    readFileSyncImpl = _readFileSync,
    writeFileSyncImpl = _writeFileSync,
    detectOSImpl = _detectOS,
  } = {},
) {
  if (!rootCaPath) return null;
  const combinedPath = managedPaths({ home, env }).caBundlePath;
  const os = detectOSImpl();

  try {
    let intermediate = '';

    if (os === 'windows') {
      let b64;
      try {
        b64 = execSyncImpl(
          'powershell -NonInteractive -NoProfile -Command -',
          { input: PS_INTERMEDIATE_SCRIPT, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
        ).toString().trim();
      } catch {
        return rootCaPath;
      }
      if (!b64) {
        // PS ran but couldn't build a chain long enough to extract an intermediate
        // (e.g. Windows X509Chain.Build returns only the leaf cert when the MITM
        // proxy's root CA isn't yet in the Windows cert store).
        // Still attempt to filter the existing ca-bundle.pem so that stale v1
        // root CA certs (no keyUsage) are removed — Python 3.13+ rejects them.
        try {
          const existing = readFileSyncImpl(combinedPath, 'utf8');
          if (!existing) return rootCaPath; // no existing bundle to fix
          const filtered = filterBundleForKeyUsage(existing);
          if (!filtered.includes('-----BEGIN CERTIFICATE-----') || filtered.trimEnd() === existing.trimEnd()) {
            // Already clean or nothing to filter
            return existing ? combinedPath : rootCaPath;
          }
          writeFileSyncImpl(combinedPath, filtered, 'utf8');
          return combinedPath;
        } catch {
          return rootCaPath;
        }
      }
      intermediate = base64ToPem(b64);
      if (!intermediate.includes('BEGIN CERTIFICATE')) return rootCaPath;
    } else {
      // POSIX path — unchanged from install.mjs
      intermediate = execSyncImpl(
        `unset HTTPS_PROXY https_proxy; echo | openssl s_client -connect api.github.com:443 -showcerts 2>/dev/null | ` +
        `awk '/-----BEGIN CERTIFICATE-----/{i++} i==2{print} /-----END CERTIFICATE-----/ && i==2{exit}'`,
        { shell: true, timeout: 12000 },
      ).toString().trim();
      if (!intermediate.includes('BEGIN CERTIFICATE')) return rootCaPath;
    }

    const rootContent = readFileSyncImpl(rootCaPath, 'utf8');
    const bodyLine = intermediate.split(/\r?\n/)[1]?.trim() ?? '';
    if (!force && bodyLine && rootContent.includes(bodyLine)) return rootCaPath;

    writeFileSyncImpl(
      combinedPath,
      filterBundleForKeyUsage(rootContent + '\n# Intermediate CA (auto-extracted from live TLS chain)\n' + intermediate + '\n'),
      'utf8',
    );
    return combinedPath;
  } catch {
    return rootCaPath;
  }
}
