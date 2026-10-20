// GCP Secret Manager over its REST API: one secret per name, ids under a
// prefix (`overcli-acme-`). No client library — it would bring gRPC along for
// six calls. The access token comes from the metadata server on GCE, GKE or
// Cloud Run, or from `gcloud auth print-access-token` on a laptop.

import { execFile } from 'node:child_process';
import type { SecretMeta, SecretStore } from './store';

const API = 'https://secretmanager.googleapis.com/v1';
const METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const BY_ANNOTATION = 'overcli-updated-by';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/// A cached token from the metadata server, else gcloud.
export function gcpToken(fetchImpl: FetchLike = fetch): () => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached && Date.now() < cached.until) return cached.token;
    try {
      const res = await fetchImpl(METADATA_TOKEN, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2_000) });
      if (res.ok) {
        const body = (await res.json()) as { access_token: string; expires_in: number };
        cached = { token: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 };
        return body.access_token;
      }
    } catch {
      // not on Google Cloud: try gcloud
    }
    const token = await new Promise<string>((resolve, reject) =>
      execFile('gcloud', ['auth', 'print-access-token'], { timeout: 20_000 }, (err, stdout) => (err ? reject(new Error('No Google credentials: not on Google Cloud, and `gcloud auth print-access-token` failed.')) : resolve(stdout.trim()))),
    );
    cached = { token, until: Date.now() + 30 * 60_000 };
    return token;
  };
}

export class GcpSecretStore implements SecretStore {
  readonly kind = 'gcp' as const;
  readonly where: string;

  constructor(
    private readonly project: string,
    private readonly prefix: string,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: FetchLike = fetch,
    readonly readOnly = false,
  ) {
    this.where = `GCP Secret Manager in ${project}, ids starting ${prefix}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
    const res = await this.fetchImpl(`${API}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404) return { status: 404, data: null };
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GCP Secret Manager answered ${res.status}: ${text.slice(0, 300)}`);
    }
    const text = await res.text();
    return { status: res.status, data: text ? (JSON.parse(text) as T) : null };
  }

  /// A secret id holds letters, digits, _ and -; our names are A-Z, 0-9, _.
  private id(name: string): string {
    return `${this.prefix}${name}`;
  }

  async load(): Promise<{ values: Record<string, string>; meta: SecretMeta[] }> {
    const values: Record<string, string> = {};
    const meta: SecretMeta[] = [];
    let page = '';
    do {
      const q = new URLSearchParams({ filter: `name:${this.prefix}`, pageSize: '250', ...(page ? { pageToken: page } : {}) });
      const res = await this.call<{ secrets?: Array<{ name: string; createTime?: string; annotations?: Record<string, string> }>; nextPageToken?: string }>('GET', `projects/${this.project}/secrets?${q}`);
      for (const s of res.data?.secrets ?? []) {
        const id = s.name.split('/').pop() ?? '';
        if (!id.startsWith(this.prefix)) continue;
        const name = id.slice(this.prefix.length);
        const version = await this.call<{ payload?: { data?: string } }>('GET', `projects/${this.project}/secrets/${id}/versions/latest:access`);
        const data = version.data?.payload?.data;
        if (!name || data === undefined) continue;
        values[name] = Buffer.from(data, 'base64').toString('utf8');
        const by = s.annotations?.[BY_ANNOTATION];
        meta.push({ name, ...(by ? { updatedBy: by } : {}) });
      }
      page = res.data?.nextPageToken ?? '';
    } while (page);
    return { values, meta };
  }

  async set(name: string, value: string, by: string): Promise<void> {
    const id = this.id(name);
    const secret = `projects/${this.project}/secrets/${id}`;
    const payload = { payload: { data: Buffer.from(value, 'utf8').toString('base64') } };
    const added = await this.call('POST', `${secret}:addVersion`, payload);
    if (added.status === 404) {
      await this.call('POST', `projects/${this.project}/secrets?secretId=${encodeURIComponent(id)}`, { replication: { automatic: {} }, labels: { 'managed-by': 'overcli' } });
      await this.call('POST', `${secret}:addVersion`, payload);
    }
    await this.call('PATCH', `${secret}?updateMask=annotations`, { annotations: { [BY_ANNOTATION]: by.slice(0, 200) } });
  }

  async remove(name: string): Promise<void> {
    await this.call('DELETE', `projects/${this.project}/secrets/${this.id(name)}`);
  }
}
