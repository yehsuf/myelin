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

export async function installMitmService(opts) {
  const os = detectOS();
  if (os === 'darwin') {
    const { installMitmService } = await import('./launchd.mjs');
    return installMitmService(opts);
  } else if (os === 'linux') {
    const { installMitmService } = await import('./systemd.mjs');
    return installMitmService(opts);
  } else {
    const { installMitmService } = await import('./windows.mjs');
    return installMitmService(opts);
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

export async function mitmServiceStatus() {
  const os = detectOS();
  if (os === 'darwin') {
    const { mitmServiceStatus } = await import('./launchd.mjs');
    return mitmServiceStatus();
  } else if (os === 'linux') {
    const { mitmServiceStatus } = await import('./systemd.mjs');
    return mitmServiceStatus();
  } else {
    const { mitmServiceStatus } = await import('./windows.mjs');
    return mitmServiceStatus();
  }
}
