import { detectOS } from '../detect/os.mjs';

export async function installService(opts) {
  const os = detectOS();
  if (os === 'darwin') {
    const { installService } = await import('./launchd.mjs');
    return installService(opts);
  } else if (os === 'linux') {
    const { installService } = await import('./systemd.mjs');
    return installService(opts);
  } else {
    const { installService } = await import('./windows.mjs');
    return installService(opts);
  }
}

export async function serviceStatus() {
  const os = detectOS();
  if (os === 'darwin') {
    const { serviceStatus } = await import('./launchd.mjs');
    return serviceStatus();
  } else if (os === 'linux') {
    const { serviceStatus } = await import('./systemd.mjs');
    return serviceStatus();
  } else {
    const { serviceStatus } = await import('./windows.mjs');
    return serviceStatus();
  }
}
