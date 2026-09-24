import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSecretValues, saveSecretCiphertext, unreadableSecretNames } from './machineSecrets';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-secrets-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/// Opens what it wrote, and refuses anything another keychain wrote.
const cipher = {
  available: () => true,
  encrypt: (plain: string) => Buffer.from(`enc:${plain}`).toString('base64'),
  decrypt: (enc: string) => {
    const text = Buffer.from(enc, 'base64').toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    return text.slice(4);
  },
};

describe('machine secrets the keychain will not open', () => {
  beforeEach(() => {
    saveSecretCiphertext(dataDir, {
      DB_PASSWORD: cipher.encrypt('hunter2hunter2'),
      // Written by another build of the app: same file, different key.
      REDSHIFT_PASSWORD: Buffer.from('another-keychain').toString('base64'),
    });
  });

  it('are left out of the values and named as unreadable', () => {
    expect(loadSecretValues(dataDir, cipher)).toEqual({ DB_PASSWORD: 'hunter2hunter2' });
    expect(unreadableSecretNames(dataDir, cipher)).toEqual(['REDSHIFT_PASSWORD']);
  });

  it('are all of them when there is no keychain at all', () => {
    const none = { ...cipher, available: () => false };
    expect(loadSecretValues(dataDir, none)).toEqual({});
    expect(unreadableSecretNames(dataDir, none).sort()).toEqual(['DB_PASSWORD', 'REDSHIFT_PASSWORD']);
  });

  it('are reported by name and reason, never by value or ciphertext', async () => {
    // Fresh module: the report is once per name per process, and the tests
    // above have already made it.
    vi.resetModules();
    const fresh = await import('./machineSecrets');
    fresh.unreadableSecretNames(dataDir, cipher);
    const logged = vi.mocked(console.warn).mock.calls.flat().join('\n');
    expect(logged).toContain('REDSHIFT_PASSWORD');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain(Buffer.from('another-keychain').toString('base64'));
  });
});
