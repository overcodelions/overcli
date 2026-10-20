// Where the org server keeps the secrets admins set on Setup → Secrets: a
// git host's token, the Slack tokens, the SSO client secret.
//
// One interface, three places: an encrypted file on the data volume (a VM, a
// laptop, plain Docker), AWS Secrets Manager (Fargate, ECS, EC2 — reached
// with the task's role), and GCP Secret Manager. See ./index.ts for how one
// is picked. The desktop app never uses this; it has the OS keychain.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface SecretMeta {
  name: string;
  updatedAt?: number;
  updatedBy?: string;
}

export interface SecretStore {
  kind: 'file' | 'aws' | 'gcp';
  /// Where they live, in words for the Secrets page.
  where: string;
  /// Managed elsewhere (Terraform, say): listed here, changed there.
  readOnly: boolean;
  /// Set when the file store's key sits on the same disk as the file.
  warning?: string;
  load(): Promise<{ values: Record<string, string>; meta: SecretMeta[] }>;
  set(name: string, value: string, by: string): Promise<void>;
  remove(name: string): Promise<void>;
}

interface FileDoc {
  version: 1;
  iv: string;
  tag: string;
  data: string;
}

type Entries = Record<string, { value: string; updatedAt: number; updatedBy: string }>;

/// The file store's key: 32 bytes, from where it's safest to have it.
export interface FileKey {
  key: Buffer;
  /// How it was found, and what to warn about.
  source: 'environment' | 'keychain' | 'file';
}

export const SECRETS_KEY_ENV = 'OVERCLI_SECRETS_KEY';
const KEYCHAIN_SERVICE = 'overcli server secrets';

/// $OVERCLI_SECRETS_KEY (any string; stretched to a key), else the macOS
/// login keychain, else a key file beside the secrets that only this user
/// can read — which the Secrets page warns about.
export function resolveFileKey(dataDir: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): FileKey {
  const fromEnv = env[SECRETS_KEY_ENV]?.trim();
  if (fromEnv) return { key: scryptSync(fromEnv, 'overcli-secrets', 32), source: 'environment' };
  if (platform === 'darwin') {
    try {
      const found = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', dataDir, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (/^[0-9a-f]{64}$/.test(found)) return { key: Buffer.from(found, 'hex'), source: 'keychain' };
    } catch {
      // not there yet
    }
    try {
      const fresh = randomBytes(32);
      execFileSync('security', ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', dataDir, '-w', fresh.toString('hex'), '-U'], { stdio: 'ignore' });
      return { key: fresh, source: 'keychain' };
    } catch {
      // no keychain (a headless Mac): the key file below
    }
  }
  const keyFile = path.join(dataDir, 'secrets.key');
  try {
    const existing = fs.readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return { key: Buffer.from(existing, 'hex'), source: 'file' };
  } catch {
    // first run
  }
  const fresh = randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyFile, fresh.toString('hex'), { mode: 0o600 });
  return { key: fresh, source: 'file' };
}

/// AES-256-GCM over the whole set, written atomically. Tampering or the wrong
/// key fails loudly rather than reading as "no secrets".
export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly readOnly = false;
  readonly where: string;
  readonly warning?: string;

  constructor(
    private readonly file: string,
    private readonly key: FileKey,
  ) {
    this.where =
      key.source === 'keychain'
        ? 'An encrypted file on this server, its key in the login keychain'
        : key.source === 'environment'
          ? `An encrypted file on this server, its key in $${SECRETS_KEY_ENV}`
          : 'An encrypted file on this server';
    if (key.source === 'file') {
      this.warning = `The key is in a file beside the secrets, on the same disk. Set $${SECRETS_KEY_ENV} (from your cloud's secret manager) to keep them apart, or use AWS or GCP Secret Manager.`;
    }
  }

  private read(): Entries {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return {};
    }
    const doc = JSON.parse(raw) as FileDoc;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key.key, Buffer.from(doc.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(doc.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(doc.data, 'base64')), decipher.final()]).toString('utf8');
      return JSON.parse(plain) as Entries;
    } catch {
      throw new Error(`Could not read ${this.file}: the key doesn't match it, or it was changed.`);
    }
  }

  private write(entries: Entries): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(entries), 'utf8'), cipher.final()]);
    const doc: FileDoc = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(doc), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  async load(): Promise<{ values: Record<string, string>; meta: SecretMeta[] }> {
    const entries = this.read();
    return {
      values: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.value])),
      meta: Object.entries(entries).map(([name, v]) => ({ name, updatedAt: v.updatedAt, updatedBy: v.updatedBy })),
    };
  }

  async set(name: string, value: string, by: string): Promise<void> {
    const entries = this.read();
    entries[name] = { value, updatedAt: Date.now(), updatedBy: by };
    this.write(entries);
  }

  async remove(name: string): Promise<void> {
    const entries = this.read();
    delete entries[name];
    this.write(entries);
  }
}
