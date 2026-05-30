import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

function authFilePath(): string {
  return path.join(app.getPath('userData'), 'flows-registry-auth.json');
}

interface Stored { entries: Record<string, string> }  // registryId -> base64(encrypted)

function readStore(): Stored {
  try {
    const raw = fs.readFileSync(authFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
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

export function setAuthHeader(registryId: string, value: string | null): void {
  const s = readStore();
  if (value == null || value === '') { delete s.entries[registryId]; }
  else if (safeStorage.isEncryptionAvailable()) {
    s.entries[registryId] = safeStorage.encryptString(value).toString('base64');
  } else {
    s.entries[registryId] = Buffer.from(value, 'utf-8').toString('base64');
  }
  writeStore(s);
}

export function getAuthHeader(registryId: string): string | undefined {
  const enc = readStore().entries[registryId];
  if (!enc) return undefined;
  const buf = Buffer.from(enc, 'base64');
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf-8');
  } catch {
    return undefined;
  }
}

export function removeAuthHeader(registryId: string): void {
  setAuthHeader(registryId, null);
}
