import { env } from 'node:process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CA_PATHS_LINUX = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/cert.pem',
];

// Generic CA filenames that may appear in the user's home directory.
// Only includes broadly-used names — no ISP or vendor-specific filenames.
const CA_FILENAMES_HOME = [
  'cacert.pem',
  'ca-bundle.pem',
  'ca-certificates.crt',
  'corporate-ca.pem',
  'enterprise-ca.pem',
];

export function detectCorporateProxy() {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? '';
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? '';
  return { proxy, noProxy };
}

export function detectCaBundles() {
  const bundles = [];
  // Standard env vars — checked in preference order
  const envVars = [
    'HEADROOM_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE',
    'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO',
  ];
  const seen = new Set();
  for (const v of envVars) {
    const p = env[v];
    if (p && !seen.has(p) && existsSync(p)) {
      bundles.push({ path: p, source: v });
      seen.add(p);
    }
  }
  // Home-directory fallback for well-known CA bundle names
  const home = homedir();
  for (const name of CA_FILENAMES_HOME) {
    const p = join(home, name);
    if (!seen.has(p) && existsSync(p)) {
      bundles.push({ path: p, source: `~/${name}` });
      seen.add(p);
    }
  }
  // System CA bundle (Linux)
  for (const p of CA_PATHS_LINUX) {
    if (!seen.has(p) && existsSync(p)) {
      bundles.push({ path: p, source: 'system' });
      seen.add(p);
    }
  }
  return bundles;
}

export function buildCorporateSslEnv(caBundle = null) {
  if (!caBundle) {
    const bundles = detectCaBundles();
    if (bundles.length === 0) return {};
    caBundle = bundles[0].path;
  }
  return {
    NODE_EXTRA_CA_CERTS: caBundle,  // Node.js (Claude Code, Copilot CLI, npm)
    REQUESTS_CA_BUNDLE:  caBundle,  // Python requests, huggingface_hub, pip
    SSL_CERT_FILE:       caBundle,  // Python ssl module, openssl
    CURL_CA_BUNDLE:      caBundle,  // curl
    GIT_SSL_CAINFO:      caBundle,  // git
    HEADROOM_CA_BUNDLE:  caBundle,  // headroom proxy
  };
}
