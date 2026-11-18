import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  cloudRoleChoices,
  isWorkerRoleSecret,
  lockedCloudEnv,
  normalizeCloudRole,
  parseRoleArn,
  relayToolCloudEnv,
  roleOfIdentity,
  roleSecretFor,
  sessionNameFor,
  WorkerCloudBroker,
  writeEmptyCloudConfig,
  type CloudCredentials,
  type WorkerCloudDeps,
} from './workerCloud';

// A made-up account, built here so no 12-digit id sits in the source.
const ACCT = '1'.repeat(12);
const HOSTING = `arn:aws:sts::${ACCT}:assumed-role/acme-server/i-0abc`;
const QA = `arn:aws:iam::${ACCT}:role/overgo-worker-acme-qa`;
const DEFAULT = `arn:aws:iam::${ACCT}:role/overgo-worker-acme`;

function creds(n: number, inMs = 3600_000, now = 0): CloudCredentials {
  return { accessKeyId: `AK${n}`, secretAccessKey: `SK${n}`, sessionToken: `ST${n}`, expiration: new Date(now + inMs) };
}

function harness(opts: Partial<Omit<WorkerCloudDeps, 'env'>> & { workers?: Record<string, { name: string; cloudRole?: string }>; env?: NodeJS.ProcessEnv } = {}) {
  const { workers, env, ...over } = opts;
  let n = 0;
  let clock = 0;
  const assume = vi.fn(async (_arn: string, _session: string) => creds(++n, 3600_000, clock));
  const deps: WorkerCloudDeps = {
    workerFor: (id) => (workers ?? { 'conv-ada': { name: 'Ada' }, 'conv-quinn': { name: 'Quinn QA', cloudRole: 'QA' }, 'conv-off': { name: 'Off', cloudRole: 'none' } })[id],
    env: () => env ?? { OVERGO_AWSWORKER_ROLE: DEFAULT, OVERGO_AWSWORKER_ROLE_QA: QA },
    assume,
    identity: async () => HOSTING,
    log: () => {},
    now: () => clock,
    ...over,
  };
  const broker = new WorkerCloudBroker(deps);
  return { broker, assume, tick: (ms: number) => (clock += ms) };
}

describe('worker role names', () => {
  it('maps a worker setting to its secret', () => {
    expect(roleSecretFor(undefined)).toBe('OVERGO_AWSWORKER_ROLE');
    expect(roleSecretFor('default')).toBe('OVERGO_AWSWORKER_ROLE');
    expect(roleSecretFor('qa')).toBe('OVERGO_AWSWORKER_ROLE_QA');
    expect(roleSecretFor('none')).toBeNull();
  });

  it('knows the secret names it reads', () => {
    expect(isWorkerRoleSecret('OVERGO_AWSWORKER_ROLE')).toBe(true);
    expect(isWorkerRoleSecret('OVERGO_AWSWORKER_ROLE_DEVOPS')).toBe(true);
    expect(isWorkerRoleSecret('OVERGO_AWSWORKER_ROLE_')).toBe(false);
    expect(isWorkerRoleSecret('OVERGO_AWSWORKER_ROLE_qa')).toBe(false);
  });

  it('normalises a patch', () => {
    expect(normalizeCloudRole(null)).toEqual({ ok: true, role: null });
    expect(normalizeCloudRole('default')).toEqual({ ok: true, role: null });
    expect(normalizeCloudRole('qa')).toEqual({ ok: true, role: 'QA' });
    expect(normalizeCloudRole('None')).toEqual({ ok: true, role: 'none' });
    expect(normalizeCloudRole('qa; rm -rf')).toMatchObject({ ok: false });
  });

  it('lists the roles set up, default first', () => {
    expect(cloudRoleChoices({ OVERGO_AWSWORKER_ROLE_QA: QA, OVERGO_AWSWORKER_ROLE: DEFAULT, OVERGO_AWSWORKER_ROLE_DEVOPS: ' ' }).map((c) => c.name)).toEqual(['default', 'QA']);
  });

  it('reads role ARNs and caller identities', () => {
    expect(parseRoleArn(QA)).toEqual({ account: ACCT, name: 'overgo-worker-acme-qa' });
    expect(parseRoleArn(`arn:aws:iam::${ACCT}:role/team/path/reader`)).toEqual({ account: ACCT, name: 'reader' });
    expect(parseRoleArn(`arn:aws:iam::${ACCT}:user/bob`)).toBeNull();
    expect(roleOfIdentity(HOSTING)).toEqual({ account: ACCT, name: 'acme-server' });
    expect(roleOfIdentity(`arn:aws:iam::${ACCT}:user/bob`)).toBeUndefined();
  });

  it('names sessions after the worker, in the characters STS allows', () => {
    expect(sessionNameFor('Quinn QA')).toBe('overgo-Quinn-QA');
    expect(sessionNameFor('Zoë/ops')).toBe('overgo-Zo-ops');
    expect(sessionNameFor('x'.repeat(80))).toHaveLength(64);
  });
});

describe('lockedCloudEnv', () => {
  it('takes out the server\'s identity and every way back to it', () => {
    const out = lockedCloudEnv({
      PATH: '/bin',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AK',
      AWS_SECRET_ACCESS_KEY: 'SK',
      AWS_PROFILE: 'server',
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/x',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/token',
      OVERGO_AWSWORKER_ROLE: DEFAULT,
      OVERGO_AWSWORKER_ROLE_QA: QA,
      AWS_BEARER_TOKEN_BEDROCK: 'kept: a model key',
    }, '/data/worker-cloud/worker-cloud-config');
    expect(out).toEqual({
      PATH: '/bin',
      AWS_REGION: 'us-east-1',
      AWS_BEARER_TOKEN_BEDROCK: 'kept: a model key',
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_CONFIG_FILE: '/data/worker-cloud/worker-cloud-config',
      AWS_SHARED_CREDENTIALS_FILE: '/data/worker-cloud/worker-cloud-config',
    });
  });

  it('writes a config with the region and nothing else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-'));
    const file = writeEmptyCloudConfig(dir, 'eu-west-2');
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^\[default\]\nregion = eu-west-2\n$/m);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(writeEmptyCloudConfig(dir, 'x\n[profile evil]'), 'utf8')).not.toContain('evil');
  });
});

describe('WorkerCloudBroker', () => {
  it('hands a worker its role, under its own session name', async () => {
    const { broker, assume } = harness();
    const a = await broker.answer(broker.tokenFor('conv-quinn'));
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ AccessKeyId: 'AK1', SecretAccessKey: 'SK1', Token: 'ST1', RoleArn: QA });
    expect(assume).toHaveBeenCalledWith(QA, 'overgo-Quinn-QA');
    expect((await broker.answer(broker.tokenFor('conv-ada'))).body).toMatchObject({ RoleArn: DEFAULT });
  });

  it('refuses a token it did not give, or one changed to name another run', async () => {
    const { broker, assume } = harness();
    expect((await broker.answer('')).status).toBe(403);
    const [, mac] = broker.tokenFor('conv-quinn').split('.');
    expect((await broker.answer(`${Buffer.from('conv-ada').toString('base64url')}.${mac}`)).status).toBe(403);
    expect((await broker.answer(new WorkerCloudBroker({ ...harness().broker['deps'] }).tokenFor('conv-ada'))).status).toBe(403);
    expect(assume).not.toHaveBeenCalled();
  });

  it('gives nothing to a run that is not a worker\'s, or a worker set to none', async () => {
    const { broker, assume } = harness();
    expect((await broker.answer(broker.tokenFor('conv-someone'))).body.message).toMatch(/Only a worker/);
    expect((await broker.answer(broker.tokenFor('conv-off'))).body.message).toMatch(/no cloud access/);
    expect(assume).not.toHaveBeenCalled();
  });

  it('gives nothing when the role it names is not set up', async () => {
    const { broker } = harness({ env: { OVERGO_AWSWORKER_ROLE_QA: QA } });
    const a = await broker.answer(broker.tokenFor('conv-ada'));
    expect(a.status).toBe(403);
    expect(a.body.message).toMatch(/OVERGO_AWSWORKER_ROLE is not set/);
  });

  it('never hands out the role the server is hosted with', async () => {
    const { broker, assume } = harness({ env: { OVERGO_AWSWORKER_ROLE: `arn:aws:iam::${ACCT}:role/acme-server` } });
    const a = await broker.answer(broker.tokenFor('conv-ada'));
    expect(a.status).toBe(403);
    expect(a.body.message).toMatch(/hosted with/);
    expect(assume).not.toHaveBeenCalled();
  });

  it('hands out nothing when it cannot tell who it is', async () => {
    const { broker, assume } = harness({ identity: async () => { throw new Error('no route to STS'); } });
    expect((await broker.answer(broker.tokenFor('conv-ada'))).body.message).toMatch(/could not check its own identity/);
    expect(assume).not.toHaveBeenCalled();
  });

  it('follows a change of role at once', async () => {
    const workers: Record<string, { name: string; cloudRole?: string }> = { c: { name: 'Ada' } };
    const { broker } = harness({ workers });
    expect((await broker.answer(broker.tokenFor('c'))).body).toMatchObject({ RoleArn: DEFAULT });
    workers.c = { name: 'Ada', cloudRole: 'QA' };
    expect((await broker.answer(broker.tokenFor('c'))).body).toMatchObject({ RoleArn: QA });
    delete workers.c;
    expect((await broker.answer(broker.tokenFor('c'))).status).toBe(403);
  });

  it('reuses a session until it is near its end, then renews it', async () => {
    const { broker, assume, tick } = harness();
    const t = broker.tokenFor('conv-ada');
    await Promise.all([broker.answer(t), broker.answer(t)]);
    expect(assume).toHaveBeenCalledTimes(1);
    tick(45 * 60_000);
    expect((await broker.answer(t)).body).toMatchObject({ AccessKeyId: 'AK1' });
    tick(10 * 60_000);
    expect((await broker.answer(t)).body).toMatchObject({ AccessKeyId: 'AK2' });
  });

  it('says why when the role refuses it, and tries again next time', async () => {
    const assume = vi.fn().mockRejectedValueOnce(new Error('not authorized to perform: sts:AssumeRole')).mockResolvedValue(creds(9));
    const { broker } = harness({ assume });
    const a = await broker.answer(broker.tokenFor('conv-ada'));
    expect(a.status).toBe(403);
    expect(a.body.message).toMatch(/sts:AssumeRole/);
    expect((await broker.answer(broker.tokenFor('conv-ada'))).status).toBe(200);
  });

  it('serves the container credentials endpoint on loopback', async () => {
    const { broker } = harness();
    expect(broker.envFor('conv-ada')).toEqual({});
    await broker.start();
    try {
      const env = broker.envFor('conv-ada');
      expect(env.AWS_CONTAINER_CREDENTIALS_FULL_URI).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/credentials$/);
      const ok = await fetch(env.AWS_CONTAINER_CREDENTIALS_FULL_URI, { headers: { authorization: env.AWS_CONTAINER_AUTHORIZATION_TOKEN } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ AccessKeyId: 'AK1', Expiration: expect.any(String) });
      const no = await fetch(env.AWS_CONTAINER_CREDENTIALS_FULL_URI);
      expect(no.status).toBe(403);
    } finally {
      broker.stop();
    }
  });
});

describe('relayToolCloudEnv', () => {
  const opts = { serverTools: ['overdb', 'test-systems'], emptyConfig: '/data/worker-cloud/worker-cloud-config', worker: { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://127.0.0.1:9/credentials', AWS_CONTAINER_AUTHORIZATION_TOKEN: 't' } };
  const server = { PATH: '/bin', AWS_REGION: 'us-east-1', AWS_PROFILE: 'server', HOME: '/data/tool-home' };

  it('gives a saved tool the worker\'s role, not the server\'s', () => {
    expect(relayToolCloudEnv('cloudwatch', server, {}, opts)).toEqual({
      PATH: '/bin', AWS_REGION: 'us-east-1', HOME: '/data/tool-home', AWS_EC2_METADATA_DISABLED: 'true',
      AWS_CONFIG_FILE: opts.emptyConfig, AWS_SHARED_CREDENTIALS_FILE: opts.emptyConfig, ...opts.worker,
    });
  });

  it('leaves the server\'s own tools, and a tool whose settings name its credentials', () => {
    expect(relayToolCloudEnv('overdb', server, {}, opts)).toBe(server);
    const chosen = { ...server, AWS_PROFILE: 'logs-reader' };
    expect(relayToolCloudEnv('cloudwatch', chosen, { AWS_PROFILE: 'logs-reader' }, opts)).toBe(chosen);
  });
});
