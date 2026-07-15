function backendFromValue(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'headroom-lite' || normalized.includes('headroom-lite')) {
    return 'headroom-lite';
  }
  if (
    normalized === 'headroom-original'
    || normalized === 'headroom'
    || normalized.includes('headroom-ai')
  ) {
    return 'headroom-original';
  }
  return null;
}

function reportedBackend(response) {
  for (const value of [
    response?.backend,
    response?.service,
    response?.name,
    response?.component,
  ]) {
    const backend = backendFromValue(value);
    if (backend) return backend;
  }
  if (String(response?.status ?? '').toLowerCase() === 'healthy') {
    return 'headroom-original';
  }
  return null;
}

export function evaluateCompressionHealth(runtime, response, httpOk = true) {
  const backend = reportedBackend(response) ?? 'unknown';
  const status = String(response?.status ?? '').toLowerCase();
  const healthy = response?.healthy === true
    || ['ok', 'healthy', 'ready', 'running'].includes(status);
  return {
    ok: Boolean(httpOk) && healthy && backend === runtime.backend,
    backend,
    response,
  };
}

export async function probeCompressionHealth(runtime, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 3000,
} = {}) {
  if (!runtime?.enabled || !runtime.healthUrl) {
    return {
      ok: runtime?.backend === 'disabled',
      backend: runtime?.backend ?? 'disabled',
      response: null,
    };
  }

  try {
    const response = await fetchImpl(runtime.healthUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {}
    return evaluateCompressionHealth(runtime, payload, response.ok);
  } catch {
    return {
      ok: false,
      backend: runtime.backend,
      response: null,
    };
  }
}
