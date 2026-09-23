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
/// than thrown, so the whole pane does not go down over one value —
/// `unreadableSecretNames` is how the pane and the launch error say which.
export function loadSecretValues(dataDir: string, cipher: SecretCipher | undefined): Record<string, string> {
  return decryptAll(dataDir, cipher).values;
}

/// Secrets that are stored but this keychain cannot open — written by another
/// build or signature of the app, from another machine, or after the keychain
/// prompt was denied. They exist, so "missing" is the wrong word for them, and
/// the only fix is retyping the value so it is encrypted with the key this
/// app can read.
export function unreadableSecretNames(dataDir: string, cipher: SecretCipher | undefined): string[] {
  return decryptAll(dataDir, cipher).unreadable;
}

/// Names already reported, so a keychain that will not open does not repeat
/// itself on every launch and every pane refresh.
const warned = new Set<string>();

function decryptAll(
  dataDir: string,
  cipher: SecretCipher | undefined,
): { values: Record<string, string>; unreadable: string[] } {
  const stored = loadSecretCiphertext(dataDir);
  if (!cipher?.available()) {
    const unreadable = Object.keys(stored);
    warnOnce(unreadable, 'no keychain is available');
    return { values: {}, unreadable };
  }
  const values: Record<string, string> = {};
  const unreadable: string[] = [];
  let reason = '';
  for (const [name, enc] of Object.entries(stored)) {
    try {
      values[name] = cipher.decrypt(enc);
    } catch (error: unknown) {
      unreadable.push(name);
      reason ||= error instanceof Error ? error.message : String(error);
    }
  }
  warnOnce(unreadable, reason);
  return { values, unreadable };
}

/// The names and why, never a value or its ciphertext.
function warnOnce(names: readonly string[], reason: string): void {
  const fresh = names.filter((name) => !warned.has(name));
  if (fresh.length === 0) return;
  for (const name of fresh) warned.add(name);
  console.warn(`[services] keychain could not unlock machine value(s) ${fresh.join(', ')}: ${reason}`);
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
