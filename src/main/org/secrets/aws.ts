// AWS Secrets Manager: one secret per name, under a prefix (`overcli/acme/`).
// Reached with whatever credentials the SDK finds — the Fargate or ECS task
// role, the EC2 instance role, or a developer's profile (SSO included) when
// trying it from a laptop. The SDK is loaded only when this store is picked.

import type { SecretMeta, SecretStore } from './store';

/// The handful of calls the store makes, so tests needn't load the SDK.
export interface AwsSecretsApi {
  list(prefix: string): Promise<Array<{ name: string; updatedAt?: number; description?: string }>>;
  get(id: string): Promise<string | null>;
  update(id: string, value: string, description: string): Promise<'ok' | 'missing' | 'deleting'>;
  create(id: string, value: string, description: string): Promise<void>;
  restore(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

const BY = /^Set by (.+) in overcli$/;

export class AwsSecretStore implements SecretStore {
  readonly kind = 'aws' as const;
  readonly where: string;

  constructor(
    private readonly prefix: string,
    private readonly api: AwsSecretsApi,
    readonly readOnly = false,
    region?: string,
  ) {
    this.where = `AWS Secrets Manager, under ${prefix}${region ? ` in ${region}` : ''}`;
  }

  async load(): Promise<{ values: Record<string, string>; meta: SecretMeta[] }> {
    const found = (await this.api.list(this.prefix)).filter((s) => s.name.startsWith(this.prefix));
    const values: Record<string, string> = {};
    const meta: SecretMeta[] = [];
    for (const s of found) {
      const name = s.name.slice(this.prefix.length);
      if (!name) continue;
      const value = await this.api.get(s.name);
      if (value === null) continue;
      values[name] = value;
      const by = s.description ? BY.exec(s.description)?.[1] : undefined;
      meta.push({ name, ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}), ...(by ? { updatedBy: by } : {}) });
    }
    return { values, meta };
  }

  async set(name: string, value: string, by: string): Promise<void> {
    const id = `${this.prefix}${name}`;
    const description = `Set by ${by} in overcli`;
    const updated = await this.api.update(id, value, description);
    if (updated === 'ok') return;
    // Removed recently: Secrets Manager holds the name for its recovery
    // window, so bring it back rather than fail to create it.
    if (updated === 'deleting') {
      await this.api.restore(id);
      await this.api.update(id, value, description);
      return;
    }
    await this.api.create(id, value, description);
  }

  async remove(name: string): Promise<void> {
    await this.api.remove(`${this.prefix}${name}`);
  }
}

/// The real calls, over the SDK. Errors keep AWS's own words: an access
/// denied names the action the task role is missing.
export async function awsSecretsApi(region?: string): Promise<AwsSecretsApi> {
  const sdk = await import('@aws-sdk/client-secrets-manager');
  const client = new sdk.SecretsManagerClient(region ? { region } : {});
  const code = (err: unknown) => (err as { name?: string })?.name ?? '';
  return {
    async list(prefix) {
      const out: Array<{ name: string; updatedAt?: number; description?: string }> = [];
      let token: string | undefined;
      do {
        const page = await client.send(new sdk.ListSecretsCommand({ Filters: [{ Key: 'name', Values: [prefix] }], MaxResults: 100, ...(token ? { NextToken: token } : {}) }));
        for (const s of page.SecretList ?? []) {
          if (s.Name && !s.DeletedDate) out.push({ name: s.Name, ...(s.LastChangedDate ? { updatedAt: s.LastChangedDate.getTime() } : {}), ...(s.Description ? { description: s.Description } : {}) });
        }
        token = page.NextToken;
      } while (token);
      return out;
    },
    async get(id) {
      try {
        const res = await client.send(new sdk.GetSecretValueCommand({ SecretId: id }));
        return res.SecretString ?? null;
      } catch (err) {
        if (code(err) === 'ResourceNotFoundException') return null;
        throw err;
      }
    },
    async update(id, value, description) {
      try {
        await client.send(new sdk.UpdateSecretCommand({ SecretId: id, SecretString: value, Description: description }));
        return 'ok';
      } catch (err) {
        if (code(err) === 'ResourceNotFoundException') return 'missing';
        if (code(err) === 'InvalidRequestException' && /deletion/i.test(String((err as Error).message))) return 'deleting';
        throw err;
      }
    },
    async create(id, value, description) {
      await client.send(new sdk.CreateSecretCommand({ Name: id, SecretString: value, Description: description, Tags: [{ Key: 'managed-by', Value: 'overcli' }] }));
    },
    async restore(id) {
      await client.send(new sdk.RestoreSecretCommand({ SecretId: id }));
    },
    async remove(id) {
      try {
        await client.send(new sdk.DeleteSecretCommand({ SecretId: id, RecoveryWindowInDays: 7 }));
      } catch (err) {
        if (code(err) !== 'ResourceNotFoundException') throw err;
      }
    },
  };
}
