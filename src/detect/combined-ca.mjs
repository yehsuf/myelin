/**
 * Build a combined CA bundle: detected root CA + intermediate CA extracted
 * from the live TLS chain at api.github.com:443.
 * Required when a corporate SSL interceptor uses an intermediate CA that
 * isn't in the standard trust store.
 *
 * Extracted from src/install.mjs for testability (DI via options object).
 * Supports Mac/Linux (openssl s_client) and Windows (PowerShell X509Chain).
 */
import { execSync as _execSync } from 'node:child_process';
import { readFileSync as _readFileSync, writeFileSync as _writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Build a combined CA bundle (root + intermediate).
 * Returns the combined path on success, rootCaPath on any failure (fail-open).
 *
 * @param {string|null} rootCaPath
 * @param {string} home  home directory
 * @param {object} opts
 * @param {boolean} [opts.force=false]  skip dedup check
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
    execSyncImpl = _execSync,
    readFileSyncImpl = _readFileSync,
    writeFileSyncImpl = _writeFileSync,
    detectOSImpl = _detectOS,
  } = {},
) {
  if (!rootCaPath) return null;
  const combinedPath = join(home, '.myelin', 'ca-bundle.pem');
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
      if (!b64) return rootCaPath;
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
      rootContent + '\n# Intermediate CA (auto-extracted from live TLS chain)\n' + intermediate + '\n',
      'utf8',
    );
    return combinedPath;
  } catch {
    return rootCaPath;
  }
}
