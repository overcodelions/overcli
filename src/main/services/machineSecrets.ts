// The secret half of the machine values, encrypted at rest.
//
// `machine.json` is plain text and stays that way for the values that are not
// credentials — an SQS prefix, a path — because being able to read and diff
// that file is worth something. Anything marked secret lives here instead,
// each value encrypted with the OS keychain (`safeStorage` under Electron), so
// a copied data directory, a backup or a stray `cat` shows ciphertext.
//
// The cipher arrives from the host rather than being imported, for the same
// reason `host.ts` exists: this module must not import electron, and a test
// needs to hand it something deterministic.
//
// There is deliberately NO plain-text fallback. `hostElectron`'s registry
// store degrades to base64 when the keychain is unavailable; for these values
// that would be the exact file this module exists to avoid, so a machine
// without a keychain refuses to store a secret and says so.

import fs from 'node:fs';
import path from 'node:path';

import { servicesRoot } from './store';

export interface SecretCipher {
  /// False when this machine has no usable keychain.
  available(): boolean;
  /// Plain text in, base64 ciphertext out.
  encrypt(plain: string): string;
  /// Throws when the ciphertext cannot be read — a different user's keychain,
  /// a corrupted file.
  decrypt(cipher: string): string;
}

export function machineSecretsFile(dataDir: string): string {
  return path.join(servicesRoot(dataDir), 'machine-secrets.json');
}

/// Names and their ciphertext, without decrypting anything. The pane only ever
/// needs to know that a secret exists.
export function loadSecretCiphertext(dataDir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(machineSecretsFile(dataDir), 'utf8'));
    const entries = (parsed as { entries?: unknown })?.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return {};
    return Object.fromEntries(
      Object.entries(entries as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

/// Every secret, decrypted. One that cannot be decrypted is left out rather
/// than thrown: the service that needs it then fails with "Missing machine
/// value: NAME", which names the fix, instead of the whole pane going down.
export function loadSecretValues(dataDir: string, cipher: SecretCipher | undefined): Record<string, string> {
  if (!cipher?.available()) return {};
  const out: Record<string, string> = {};
  for (const [name, enc] of Object.entries(loadSecretCiphertext(dataDir))) {
    try {
      out[name] = cipher.decrypt(enc);
    } catch {
      // See above.
    }
  }
  return out;
}

export function saveSecretCiphertext(dataDir: string, entries: Record<string, string>): void {
  fs.mkdirSync(servicesRoot(dataDir), { recursive: true });
  const file = machineSecretsFile(dataDir);
  const tmp = `${file}.tmp`;
  // 0600 on top of the encryption: nobody else on the machine needs to see
  // even the ciphertext or the names.
  fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}
