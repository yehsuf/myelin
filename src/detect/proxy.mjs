import { env } from 'node:process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CA_PATHS_LINUX = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/cert.pem',
];

const CA_FILENAMES_HOME = [
  'netfree-ca.pem', 'netfree_hot.crt', 'root_ca_x2_bundle.crt', 'cacert.pem',
];

export function detectCorporateProxy() {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? '';
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? '';
  return { proxy, noProxy };
}

export function detectCaBundles() {
  const bundles = [];
  if (env.HEADROOM_CA_BUNDLE && existsSync(env.HEADROOM_CA_BUNDLE)) {
    bundles.push({ path: env.HEADROOM_CA_BUNDLE, source: 'HEADROOM_CA_BUNDLE' });
  }
  if (env.REQUESTS_CA_BUNDLE && existsSync(env.REQUESTS_CA_BUNDLE)) {
    bundles.push({ path: env.REQUESTS_CA_BUNDLE, source: 'REQUESTS_CA_BUNDLE' });
  }
  if (env.SSL_CERT_FILE && existsSync(env.SSL_CERT_FILE)) {
    bundles.push({ path: env.SSL_CERT_FILE, source: 'SSL_CERT_FILE' });
  }
  const home = homedir();
  for (const name of CA_FILENAMES_HOME) {
    const p = join(home, name);
    if (existsSync(p)) bundles.push({ path: p, source: `~/${name}` });
  }
  for (const p of CA_PATHS_LINUX) {
    if (existsSync(p)) bundles.push({ path: p, source: 'system' });
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
    HEADROOM_CA_BUNDLE: caBundle,   // headroom proxy
    NODE_EXTRA_CA_CERTS: caBundle,  // Node.js (Claude Code, Copilot CLI)
    REQUESTS_CA_BUNDLE: caBundle,   // Python requests, huggingface_hub, pip
    SSL_CERT_FILE: caBundle,        // Python ssl module, openssl
    CURL_CA_BUNDLE: caBundle,       // curl
    GIT_SSL_CAINFO: caBundle,       // git
  };
}
