import { createServer } from 'node:net';

export function isPortFree(port) {
  if (!port || port < 1) return Promise.resolve(false);
  return new Promise(resolve => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

export async function findFreePort(start = 8787, end = 8900) {
  for (let p = start; p <= end; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free port found in range ${start}-${end}`);
}
