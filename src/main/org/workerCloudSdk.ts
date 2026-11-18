// The cloud SDK calls behind workerCloud.ts and bedrockProxy.ts, kept apart
// so their logic loads and tests without the SDK. Loaded only on a server that
// turns worker roles on. Every call is made as the server, with whatever role
// it is hosted with.

import { createHash, createHmac, type Hash, type Hmac } from 'node:crypto';

import type { BedrockSigner } from './bedrockProxy';
import type { CloudCredentials } from './workerCloud';

/// How long a worker's role session lasts; renewed before it ends.
const SESSION_SECONDS = 3600;

export async function stsCalls(region?: string): Promise<{ assume(arn: string, session: string): Promise<CloudCredentials>; identity(): Promise<string | undefined> }> {
  const sdk = await import('@aws-sdk/client-sts');
  const client = new sdk.STSClient(region ? { region } : {});
  return {
    async assume(arn, session) {
      const res = await client.send(new sdk.AssumeRoleCommand({ RoleArn: arn, RoleSessionName: session, DurationSeconds: SESSION_SECONDS }));
      const c = res.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new Error('AssumeRole returned no credentials.');
      return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
    },
    async identity() {
      return (await client.send(new sdk.GetCallerIdentityCommand({}))).Arn;
    },
  };
}

type SourceData = string | ArrayBuffer | ArrayBufferView;

function bytes(data: SourceData): string | Uint8Array {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/// SHA-256 in the shape the signer wants, from node's own crypto.
class Sha256 {
  private h: Hash | Hmac;
  private readonly secret?: string | Uint8Array;
  constructor(secret?: SourceData) {
    this.secret = secret === undefined ? undefined : bytes(secret);
    this.h = this.fresh();
  }
  private fresh(): Hash | Hmac {
    return this.secret ? createHmac('sha256', this.secret) : createHash('sha256');
  }
  update(data: SourceData): void {
    this.h.update(bytes(data));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.h.digest());
  }
  reset(): void {
    this.h = this.fresh();
  }
}

export async function bedrockSigner(region: string): Promise<BedrockSigner> {
  const { SignatureV4 } = await import('@smithy/signature-v4');
  const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
  const signer = new SignatureV4({ service: 'bedrock', region, credentials: defaultProvider(), sha256: Sha256 });
  return {
    async sign({ method, hostname, path, headers, body }) {
      const signed = await signer.sign({ method, protocol: 'https:', hostname, path, headers: { ...headers, host: hostname }, body, query: {} });
      return Object.fromEntries(Object.entries(signed.headers).map(([k, v]) => [k, String(v)]));
    },
  };
}
