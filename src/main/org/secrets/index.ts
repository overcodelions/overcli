// Which store the org server keeps its secrets in, from $OVERCLI_SECRETS:
//
//   (unset) or file          an encrypted file in the data directory — a
//                            laptop, a VM, plain Docker
//   aws:<prefix>             AWS Secrets Manager, names under <prefix>
//                            (e.g. aws:overcli/acme/), region from $AWS_REGION
//   gcp:<project>[/<prefix>] GCP Secret Manager in <project>, ids starting
//                            <prefix> (default overcli-)
//
// $OVERCLI_SECRETS_READONLY=1: secrets are managed elsewhere (Terraform);
// the Secrets page lists them and says where to change them.

import path from 'node:path';
import { AwsSecretStore, awsSecretsApi } from './aws';
import { GcpSecretStore, gcpToken } from './gcp';
import { FileSecretStore, resolveFileKey, type SecretStore } from './store';

export const SECRETS_ENV = 'OVERCLI_SECRETS';
export const SECRETS_READONLY_ENV = 'OVERCLI_SECRETS_READONLY';

export type SecretsSpec = { kind: 'file' } | { kind: 'aws'; prefix: string } | { kind: 'gcp'; project: string; prefix: string };

export function parseSecretsSpec(raw: string | undefined): { ok: true; spec: SecretsSpec } | { ok: false; error: string } {
  const v = raw?.trim() ?? '';
  if (!v || v === 'file') return { ok: true, spec: { kind: 'file' } };
  const aws = /^aws:(.+)$/.exec(v);
  if (aws) {
    const prefix = aws[1].trim();
    if (!/^[\w/+=.@-]+$/.test(prefix)) return { ok: false, error: `$${SECRETS_ENV}: an AWS prefix is letters, digits and /_+=.@- (e.g. aws:overcli/acme/).` };
    return { ok: true, spec: { kind: 'aws', prefix: prefix.endsWith('/') ? prefix : `${prefix}/` } };
  }
  const gcp = /^gcp:([a-z][a-z0-9-]{4,29})(?:\/([A-Za-z0-9_-]+))?$/.exec(v);
  if (gcp) return { ok: true, spec: { kind: 'gcp', project: gcp[1], prefix: gcp[2] ?? 'overcli-' } };
  return { ok: false, error: `$${SECRETS_ENV} is "file", "aws:<prefix>" or "gcp:<project>[/<prefix>]".` };
}

export async function createSecretStore(spec: SecretsSpec, dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<SecretStore> {
  const readOnly = env[SECRETS_READONLY_ENV] === '1';
  if (spec.kind === 'aws') {
    const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined;
    return new AwsSecretStore(spec.prefix, await awsSecretsApi(region), readOnly, region);
  }
  if (spec.kind === 'gcp') return new GcpSecretStore(spec.project, spec.prefix, gcpToken(), fetch, readOnly);
  return new FileSecretStore(path.join(dataDir, 'secrets.enc'), resolveFileKey(dataDir, env));
}

export { SecretsService, KNOWN_SECRETS, stripSecrets, workerHiddenSecretNames, checkSecretName, type SecretStatus } from './service';
export type { SecretStore } from './store';
