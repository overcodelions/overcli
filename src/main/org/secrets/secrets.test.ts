import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AwsSecretStore, type AwsSecretsApi } from './aws';
import { GcpSecretStore } from './gcp';
import { parseSecretsSpec } from './index';
import { SecretsService, checkSecretName, stripSecrets } from './service';
import { FileSecretStore, resolveFileKey, type SecretStore } from './store';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-secrets-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('the encrypted file', () => {
  it('keeps values only as ciphertext, and refuses the wrong key', async () => {
    const dir = tmp();
    const key = resolveFileKey(dir, { OVERCLI_SECRETS_KEY: 'correct horse' }, 'linux');
    expect(key.source).toBe('environment');
    const store = new FileSecretStore(path.join(dir, 'secrets.enc'), key);
    await store.set('GH_TOKEN', 'ghs_supersecret', 'Bo');
    expect(fs.readFileSync(path.join(dir, 'secrets.enc'), 'utf8')).not.toContain('ghs_supersecret');
    expect(await store.load()).toMatchObject({ values: { GH_TOKEN: 'ghs_supersecret' }, meta: [{ name: 'GH_TOKEN', updatedBy: 'Bo' }] });
    const wrong = new FileSecretStore(path.join(dir, 'secrets.enc'), resolveFileKey(dir, { OVERCLI_SECRETS_KEY: 'wrong' }, 'linux'));
    await expect(wrong.load()).rejects.toThrow(/key doesn't match/);
  });

  it('makes a key file only it can read when nothing better is there, and warns', () => {
    const dir = tmp();
    const key = resolveFileKey(dir, {}, 'linux');
    expect(key.source).toBe('file');
    expect(fs.statSync(path.join(dir, 'secrets.key')).mode & 0o777).toBe(0o600);
    expect(resolveFileKey(dir, {}, 'linux').key.equals(key.key)).toBe(true);
    expect(new FileSecretStore(path.join(dir, 'secrets.enc'), key).warning).toContain('same disk');
  });
});

function memoryStore(over: Partial<SecretStore> = {}): SecretStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    kind: 'file',
    where: 'memory',
    readOnly: false,
    data,
    load: async () => ({ values: { ...data }, meta: Object.keys(data).map((name) => ({ name })) }),
    set: async (name, value) => {
      data[name] = value;
    },
    remove: async (name) => {
      delete data[name];
    },
    ...over,
  };
}

describe('the secrets service', () => {
  it('hides a custom secret from workers as soon as it is set', async () => {
    const env: NodeJS.ProcessEnv = {};
    const svc = new SecretsService({ store: memoryStore(), env, log: () => {} });
    expect(await svc.set('JIRA_API_TOKEN', 'abc', 'Bo')).toEqual({ ok: true });
    const out = stripSecrets({ JIRA_API_TOKEN: 'abc', GH_TOKEN: 'g', ANTHROPIC_API_KEY: 'k', PATH: '/bin' });
    expect(out).toEqual({ ANTHROPIC_API_KEY: 'k', PATH: '/bin' });
  });
  it('hides the keys to the server\'s own stores, even when only the environment set them', () => {
    const out = stripSecrets({ OVERCLI_SECRETS_KEY: 's', OVERCLI_CONNECTIONS_KEY: 'c', OVERCLI_ORG_TOKEN: 'o', PATH: '/bin' });
    // The org token is a person's own sign-in, which their codex config can name; it stays.
    expect(out).toEqual({ OVERCLI_ORG_TOKEN: 'o', PATH: '/bin' });
  });
  it('applies what is stored, leaves what the environment set, and says what needs a missing one', async () => {
    const env: NodeJS.ProcessEnv = { OVERCLI_SLACK_BOT_TOKEN: 'xoxb-from-env' };
    const store = memoryStore();
    store.data.GH_TOKEN = 'ghs_1';
    store.data.OVERCLI_SLACK_BOT_TOKEN = 'xoxb-stored';
    const changes: string[][] = [];
    const svc = new SecretsService({ store, env, log: () => {} });
    svc.onChange((n) => changes.push(n));
    await svc.load();
    expect(env.GH_TOKEN).toBe('ghs_1');
    expect(env.OVERCLI_SLACK_BOT_TOKEN).toBe('xoxb-from-env');
    expect(changes).toEqual([['GH_TOKEN']]);
    const status = svc.status((n) => (n === 'BITBUCKET_TOKEN' ? ['pushing to site'] : []));
    expect(status.secrets.find((s) => s.name === 'OVERCLI_SLACK_BOT_TOKEN')?.state).toBe('environment');
    expect(status.secrets.find((s) => s.name === 'BITBUCKET_TOKEN')).toMatchObject({ state: 'missing', neededBy: ['pushing to site'] });
    expect((await svc.set('OVERCLI_SLACK_BOT_TOKEN', 'x', 'Bo')).ok).toBe(false);
  });

  it('sets and removes at once, and picks up a change made in the store', async () => {
    const env: NodeJS.ProcessEnv = {};
    const store = memoryStore();
    const svc = new SecretsService({ store, env, log: () => {} });
    await svc.load();
    expect(await svc.set('BITBUCKET_TOKEN', '  bb_1  ', 'Bo')).toEqual({ ok: true });
    expect(env.BITBUCKET_TOKEN).toBe('bb_1');
    store.data.BITBUCKET_TOKEN = 'bb_rotated';
    await svc.load();
    expect(env.BITBUCKET_TOKEN).toBe('bb_rotated');
    expect(await svc.remove('BITBUCKET_TOKEN')).toEqual({ ok: true });
    expect(env.BITBUCKET_TOKEN).toBeUndefined();
  });

  it('keeps the last good values when the store cannot be read', async () => {
    const env: NodeJS.ProcessEnv = {};
    let fail = false;
    const store = memoryStore();
    store.data.GH_TOKEN = 'ghs_1';
    const svc = new SecretsService({ store: { ...store, load: async () => (fail ? Promise.reject(new Error('throttled')) : store.load()) }, env, log: () => {} });
    await svc.load();
    fail = true;
    expect(await svc.load()).toMatchObject({ ok: false });
    expect(env.GH_TOKEN).toBe('ghs_1');
    expect(svc.status().error).toBe('throttled');
  });

  it('says which model provider the server uses, and which model secrets it then needs', async () => {
    const svc = new SecretsService({ store: memoryStore(), env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' }, log: () => {} });
    await svc.load();
    const { model, secrets } = svc.status();
    expect(model).toEqual({ provider: 'bedrock', detail: "Bedrock in us-east-1, through the server's AWS role" });
    expect(secrets.find((x) => x.name === 'ANTHROPIC_API_KEY')?.state).toBe('notNeeded');
    expect(secrets.find((x) => x.name === 'AWS_BEARER_TOKEN_BEDROCK')).toMatchObject({ state: 'missing', why: expect.stringContaining('no AWS role') });
    expect(checkSecretName('AWS_BEARER_TOKEN_BEDROCK')).toBeNull();
    const plain = new SecretsService({ store: memoryStore(), env: {}, log: () => {} });
    expect(plain.status().secrets.find((x) => x.name === 'AWS_BEARER_TOKEN_BEDROCK')?.state).toBe('notNeeded');
  });

  it('allows known names and credential-shaped ones, not ones that steer the server', async () => {
    expect(checkSecretName('GH_TOKEN')).toBeNull();
    expect(checkSecretName('JIRA_API_TOKEN')).toBeNull();
    expect(checkSecretName('ANTHROPIC_BASE_URL')).not.toBeNull();
    expect(checkSecretName('NODE_OPTIONS')).not.toBeNull();
    expect(checkSecretName('GIT_SSH_COMMAND')).not.toBeNull();
    expect(checkSecretName('AWS_SECRET_ACCESS_KEY')).not.toBeNull();
    expect(checkSecretName('lowercase_token')).not.toBeNull();
    const ro = new SecretsService({ store: memoryStore({ readOnly: true, where: 'AWS Secrets Manager' }), env: {}, log: () => {} });
    expect(await ro.set('GH_TOKEN', 'x', 'Bo')).toMatchObject({ ok: false, error: expect.stringContaining('managed in AWS Secrets Manager') });
  });

  it("keeps overcli's own key in the store but out of the environment, the page and the admin's reach", async () => {
    const store = memoryStore();
    const env: NodeJS.ProcessEnv = {};
    const svc = new SecretsService({ store, env, log: () => {} });
    expect(await svc.setPrivate('OVERCLI_CONNECTIONS_KEY', 'ab'.repeat(32))).toBe(true);
    expect(await svc.setPrivate('GH_TOKEN', 'x')).toBe(false);
    await svc.load();
    expect(env.OVERCLI_CONNECTIONS_KEY).toBeUndefined();
    expect(await svc.getPrivate('OVERCLI_CONNECTIONS_KEY')).toBe('ab'.repeat(32));
    expect(svc.status().secrets.map((s) => s.name)).not.toContain('OVERCLI_CONNECTIONS_KEY');
    expect(svc.status().secrets.map((s) => s.name)).toEqual(expect.arrayContaining(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']));
    expect((await svc.remove('OVERCLI_CONNECTIONS_KEY')).ok).toBe(false);
    expect(await svc.set('GOOGLE_OAUTH_CLIENT_ID', 'acme.apps.googleusercontent.com', 'Bo')).toEqual({ ok: true });
    expect(env.GOOGLE_OAUTH_CLIENT_ID).toBe('acme.apps.googleusercontent.com');
    const ro = new SecretsService({ store: memoryStore({ readOnly: true }), env: {}, log: () => {} });
    expect(await ro.setPrivate('OVERCLI_CONNECTIONS_KEY', 'ab'.repeat(32))).toBe(false);
  });
});

describe('AWS Secrets Manager', () => {
  it('keeps each name under the prefix, records who set it, and brings back a recently removed name', async () => {
    const secrets = new Map<string, { value: string; description: string; deleting?: boolean }>();
    const calls: string[] = [];
    const api: AwsSecretsApi = {
      list: async (prefix) => [...secrets].filter(([id, s]) => id.startsWith(prefix) && !s.deleting).map(([name, s]) => ({ name, description: s.description, updatedAt: 5 })),
      get: async (id) => secrets.get(id)?.value ?? null,
      update: async (id, value, description) => {
        calls.push(`update ${id}`);
        const s = secrets.get(id);
        if (!s) return 'missing';
        if (s.deleting) return 'deleting';
        secrets.set(id, { value, description });
        return 'ok';
      },
      create: async (id, value, description) => {
        calls.push(`create ${id}`);
        secrets.set(id, { value, description });
      },
      restore: async (id) => {
        calls.push(`restore ${id}`);
        secrets.set(id, { ...secrets.get(id)!, deleting: false });
      },
      remove: async (id) => {
        secrets.set(id, { ...secrets.get(id)!, deleting: true });
      },
    };
    const store = new AwsSecretStore('overcli/acme/', api, false, 'us-east-1');
    await store.set('GH_TOKEN', 'ghs_1', 'Bo');
    expect(calls).toEqual(['update overcli/acme/GH_TOKEN', 'create overcli/acme/GH_TOKEN']);
    expect(await store.load()).toEqual({ values: { GH_TOKEN: 'ghs_1' }, meta: [{ name: 'GH_TOKEN', updatedAt: 5, updatedBy: 'Bo' }] });
    await store.remove('GH_TOKEN');
    expect((await store.load()).values).toEqual({});
    await store.set('GH_TOKEN', 'ghs_2', 'Sam');
    expect(calls.slice(-3)).toEqual(['update overcli/acme/GH_TOKEN', 'restore overcli/acme/GH_TOKEN', 'update overcli/acme/GH_TOKEN']);
    expect((await store.load()).values).toEqual({ GH_TOKEN: 'ghs_2' });
    expect(store.where).toBe('AWS Secrets Manager, under overcli/acme/ in us-east-1');
  });
});

describe('GCP Secret Manager', () => {
  it('creates the secret on first use, adds versions, and reads the latest', async () => {
    const secrets = new Map<string, { versions: string[]; annotations?: Record<string, string> }>();
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const u = new URL(url);
      const p = u.pathname.replace('/v1/projects/acme-ops/secrets', '');
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
      if (init?.method === 'GET' && p === '') return json({ secrets: [...secrets.keys()].map((id) => ({ name: `projects/acme-ops/secrets/${id}`, annotations: secrets.get(id)!.annotations })) });
      if (init?.method === 'POST' && p === '') {
        secrets.set(u.searchParams.get('secretId')!, { versions: [] });
        return json({});
      }
      const [, id, rest] = /^\/([^/:]+)(.*)$/.exec(p)!;
      const s = secrets.get(id);
      if (!s) return new Response('', { status: 404 });
      if (rest === ':addVersion') {
        s.versions.push(Buffer.from(body.payload.data, 'base64').toString());
        return json({});
      }
      if (rest === '/versions/latest:access') return json({ payload: { data: Buffer.from(s.versions.at(-1)!).toString('base64') } });
      if (init?.method === 'PATCH') {
        s.annotations = body.annotations;
        return json({});
      }
      if (init?.method === 'DELETE') {
        secrets.delete(id);
        return json({});
      }
      return new Response('', { status: 400 });
    };
    const store = new GcpSecretStore('acme-ops', 'overcli-', async () => 'tok', fetchImpl);
    await store.set('BITBUCKET_TOKEN', 'bb_1', 'Bo');
    await store.set('BITBUCKET_TOKEN', 'bb_2', 'Sam');
    expect(secrets.get('overcli-BITBUCKET_TOKEN')!.versions).toEqual(['bb_1', 'bb_2']);
    expect(await store.load()).toEqual({ values: { BITBUCKET_TOKEN: 'bb_2' }, meta: [{ name: 'BITBUCKET_TOKEN', updatedBy: 'Sam' }] });
    await store.remove('BITBUCKET_TOKEN');
    expect((await store.load()).values).toEqual({});
  });
});

describe('choosing a store', () => {
  it('reads $OVERCLI_SECRETS', () => {
    expect(parseSecretsSpec(undefined)).toEqual({ ok: true, spec: { kind: 'file' } });
    expect(parseSecretsSpec('aws:overcli/acme')).toEqual({ ok: true, spec: { kind: 'aws', prefix: 'overcli/acme/' } });
    expect(parseSecretsSpec('gcp:acme-ops/overcli-acme-')).toEqual({ ok: true, spec: { kind: 'gcp', project: 'acme-ops', prefix: 'overcli-acme-' } });
    expect(parseSecretsSpec('vault:x').ok).toBe(false);
  });
});
