// The desktop app's host. The only file in the headless seam that imports
// electron, so `src/cli/*` can be proven free of it by never importing this.
//
// The secret store used to live in `flows/registryAuth.ts`. It moved here
// because "encrypt with safeStorage, fall back to base64 when the platform has
// no keychain" is a statement about THIS host, not about registry tokens —
// the headless host answers the same question with an environment variable.

import fs from 'node:fs';
import path from 'node:path';
import { app, Notification, safeStorage } from 'electron';

import { log } from './diagnostics';
import { setHost, type HostEnv, type HostSecrets } from './host';

function authFilePath(): string {
  return path.join(app.getPath('userData'), 'flows-registry-auth.json');
}

interface Stored {
  entries: Record<string, string>; // registryId -> base64(encrypted)
}

function readStore(): Stored {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFilePath(), 'utf-8'));
    return { entries: parsed.entries ?? {} };
  } catch {
    return { entries: {} };
  }
}

function writeStore(s: Stored): void {
  const p = authFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

const electronSecrets: HostSecrets = {
  get(key) {
    const enc = readStore().entries[key];
    if (!enc) return null;
    const buf = Buffer.from(enc, 'base64');
    try {
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf-8');
    } catch {
      return null;
    }
  },
  set(key, value) {
    const s = readStore();
    if (value == null || value === '') {
      delete s.entries[key];
    } else if (safeStorage.isEncryptionAvailable()) {
      s.entries[key] = safeStorage.encryptString(value).toString('base64');
    } else {
      s.entries[key] = Buffer.from(value, 'utf-8').toString('base64');
    }
    writeStore(s);
    return true;
  },
};

/// Build the Electron host. `onNotifyClick` is how index.ts brings its window
/// forward when the user clicks the notification — the host cannot know about
/// `mainWindow`, and a notification the user clicks that does nothing is worse
/// than no notification.
export function electronHost(onNotifyClick?: () => void): HostEnv {
  return {
    dataDir: () => app.getPath('userData'),
    secrets: electronSecrets,
    notify(args) {
      try {
        if (!Notification.isSupported()) return;
        const n = new Notification({ title: args.title, body: args.body });
        if (onNotifyClick) n.on('click', onNotifyClick);
        n.show();
      } catch (err) {
        log('warn', 'host.notify', `Notification failed: ${String(err)}`);
      }
    },
  };
}

export function installElectronHost(onNotifyClick?: () => void): void {
  setHost(electronHost(onNotifyClick));
}
