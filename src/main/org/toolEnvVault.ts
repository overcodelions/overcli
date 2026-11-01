// Command (stdio) tools' environment, sealed in the server.
//
// A command tool's tokens live in its `env` in ~/.claude.json, and every
// worker's CLI reads that file, so a worker that runs shell commands could
// read them. With the tool gateway on (OVERCLI_TOOL_GATEWAY=1), the server
// keeps that env here instead, sealed under the gateway's key:
//
//   config   ~/.claude.json keeps each command tool's command and args, with
//            no env. A CLI that started one from there would start it without
//            its credentials: it fails, it doesn't leak.
//   reads    the server's own reads of the config (readClaudeMcpServers) get
//            the env back, so health checks, settings and overdb work as before.
//   runs     every run gets each sealed tool as a relay descriptor
//            (runToolRelay.ts), which wins over the config's entry of the same
//            name. The server starts the real tool, with its env, as its own
//            user; the worker's CLI talks to it through the relay.
//
// Turning the gateway off puts the env back in the config on the next start.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { toolGatewayRootKey } from './toolGateway';

const AAD = Buffer.from('overcli-tool-env-v1');

type Doc = { env: Record<string, Record<string, string>> };

export const TOOL_ENV_FILE = 'tool-env.json';

export class ToolEnvVault {
  private readonly key: Buffer;
  private doc: Doc;

  constructor(private readonly dir: string) {
    this.key = Buffer.from(hkdfSync('sha256', toolGatewayRootKey(dir), Buffer.alloc(0), 'tool-env seal', 32));
    this.doc = this.read();
  }

  private file(): string {
    return path.join(this.dir, TOOL_ENV_FILE);
  }

  private read(): Doc {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file(), 'utf8');
    } catch {
      return { env: {} };
    }
    const sealed = JSON.parse(raw) as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const doc = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8')) as Doc;
    return { env: doc.env ?? {} };
  }

  private write(): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify(this.doc), 'utf8'), cipher.final()]);
    const tmp = `${this.file()}.${process.pid}.tmp`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
    fs.renameSync(tmp, this.file());
  }

  /// Keep a tool's env. An empty env forgets the tool.
  seal(name: string, env: Record<string, string>): void {
    if (!Object.keys(env).length) return this.forget(name);
    this.doc = { env: { ...this.doc.env, [name]: { ...env } } };
    this.write();
  }

  envFor(name: string): Record<string, string> | undefined {
    const env = this.doc.env[name];
    return env ? { ...env } : undefined;
  }

  has(name: string): boolean {
    return name in this.doc.env;
  }

  forget(name: string): void {
    if (!(name in this.doc.env)) return;
    const { [name]: _gone, ...rest } = this.doc.env;
    this.doc = { env: rest };
    this.write();
  }

  names(): string[] {
    return Object.keys(this.doc.env);
  }
}

/// Whether a vault file exists in `dir`, without making a key.
export function toolEnvVaultExists(dir: string): boolean {
  return fs.existsSync(path.join(dir, TOOL_ENV_FILE));
}
