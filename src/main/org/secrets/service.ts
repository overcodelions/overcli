// The secrets an admin manages on Setup → Secrets, applied to the running
// server: each one is set in the process environment, so the next worker run,
// git's credential helper and the Slack bridge pick it up without a restart.
//
// The environment the server started with wins. A secret injected by the
// task definition or deploy/.env is the operator's, shown as "set by the
// environment" and left alone.
//
// Names are held to a short list on purpose. Setting an arbitrary variable in
// the server's environment would let a console session redirect the model
// (ANTHROPIC_BASE_URL), git (GIT_SSH_COMMAND) or node (NODE_OPTIONS) — so a
// name must be one overcli knows, or look like a credential for a tool
// (…_TOKEN, …_API_KEY), and never one of the prefixes those live under.

import { SECRETS_KEY_ENV, type SecretMeta, type SecretStore } from './store';

export interface KnownSecret {
  name: string;
  label: string;
  /// What it unlocks, in a sentence.
  why: string;
  /// Where to get one.
  how: string;
  /// The page that makes one, where there is a direct one.
  link?: string;
}

export const KNOWN_SECRETS: KnownSecret[] = [
  {
    name: 'GH_TOKEN',
    label: 'GitHub token, for pushing to connected repos',
    why: 'Lets workers push their branches to the github.com repos connected on the Repos tab.',
    how: 'GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token. Give it access to only the connected repos, with Contents: read and write. Make it on a bot account rather than a person, so it outlives anyone leaving.',
    link: 'https://github.com/settings/personal-access-tokens/new',
  },
  {
    name: 'BITBUCKET_TOKEN',
    label: 'Bitbucket access token, for pushing to connected repos',
    why: 'Lets workers push their branches to the bitbucket.org repos connected on the Repos tab.',
    how: 'In Bitbucket, open the repo (or the workspace, for several repos) → Settings → Access tokens → Create access token, with Repositories: read and write. An access token acts as its own bot user, so it needs no user name.',
  },
  {
    name: 'BITBUCKET_USER',
    label: 'Bitbucket user name, when the token needs one (default x-token-auth)',
    why: 'Only for a Bitbucket token that signs in as a person, such as a personal API token. Access tokens need none.',
    how: 'For a personal API token, the Atlassian account email it belongs to. Leave it unset for access tokens.',
  },
  {
    name: 'GIT_TOKEN',
    label: 'Token for another git host (Bitbucket Data Center, GitLab, …)',
    why: 'Lets workers push to repos on a git host other than GitHub or bitbucket.org, over https.',
    how: 'Bitbucket Data Center: your profile → HTTP access tokens, with repository write. GitLab: the project → Settings → Access tokens, with write_repository. Set GIT_USER to the user name the host expects with it.',
  },
  {
    name: 'GIT_USER',
    label: 'User name for that git host',
    why: 'The user name that goes with GIT_TOKEN.',
    how: 'GitLab: oauth2 (the default, so it can stay unset). Bitbucket Data Center: the user name of the token’s owner.',
  },
  {
    name: 'OVERCLI_SLACK_BOT_TOKEN',
    label: 'Slack bot token (xoxb-…)',
    why: 'Workers ask their managers questions and approvals in Slack, and people ask workers for things with @overgo or a DM.',
    how: 'Connect → Slack in this console makes the app: it opens Slack with the manifest filled in. Then OAuth & Permissions → Install to Workspace, and copy the Bot User OAuth Token. Add the app-level token too.',
    link: 'https://api.slack.com/apps',
  },
  {
    name: 'OVERCLI_SLACK_APP_TOKEN',
    label: 'Slack app-level token (xapp-…)',
    why: 'Socket Mode: Slack reaches this server over a connection the server opens, so no inbound port or public address is needed.',
    how: 'In the same Slack app: Basic Information → App-Level Tokens → Generate Token and Scopes, with the connections:write scope.',
    link: 'https://api.slack.com/apps',
  },
  {
    name: 'OVERCLI_SSO_CLIENT_SECRET',
    label: 'Company sign-in client secret',
    why: 'Company sign-in (Okta, Entra ID, Google Workspace) with a confidential client. A public client using PKCE needs none.',
    how: 'In your identity provider, the app registration made for overcli → its client secret. The issuer and client ID go on Setup → Sign-in.',
  },
  {
    name: 'GOOGLE_OAUTH_CLIENT_ID',
    label: 'Google sign-in client ID, for saving to people’s own Google Drive',
    why: 'Lets each person connect their own Google account, so “Save to Google Drive” on a team task saves into their Drive, as them.',
    how: 'Google Cloud console → APIs & Services → enable the Google Drive API → Credentials → Create credentials → OAuth client ID, type Web application. Add the redirect URI the console shows on Connections as an authorized redirect URI. Copy the client ID here and the client secret into GOOGLE_OAUTH_CLIENT_SECRET.',
    link: 'https://console.cloud.google.com/apis/credentials',
  },
  {
    name: 'GOOGLE_OAUTH_CLIENT_SECRET',
    label: 'Google sign-in client secret',
    why: 'Goes with GOOGLE_OAUTH_CLIENT_ID: the server uses it to keep each person’s Drive connection working.',
    how: 'The same OAuth client in the Google Cloud console → its client secret.',
    link: 'https://console.cloud.google.com/apis/credentials',
  },
  {
    name: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API key, when not using Bedrock or Vertex',
    why: 'Workers think with Claude through the Anthropic API.',
    how: 'console.anthropic.com → Settings → API keys → Create key, in a workspace with a spend limit you are comfortable with. Not needed when the server uses Bedrock or Vertex.',
    link: 'https://console.anthropic.com/settings/keys',
  },
  {
    name: 'AWS_BEARER_TOKEN_BEDROCK',
    label: 'Bedrock API key, for a server using Bedrock without an AWS role (not on AWS, say)',
    why: 'Workers use Claude on Bedrock from a server that has no AWS role, such as one not running on AWS.',
    how: 'AWS console → Amazon Bedrock → API keys → Generate. The server also needs CLAUDE_CODE_USE_BEDROCK=1 and AWS_REGION in its environment. On AWS, give the instance or task role Bedrock access instead and skip this.',
  },
  {
    name: 'OPENAI_API_KEY',
    label: 'OpenAI API key, for Codex',
    why: 'Workers that run on Codex instead of Claude.',
    how: 'platform.openai.com → API keys → Create new secret key. Only useful if the image was built with INSTALL_CODEX=1.',
    link: 'https://platform.openai.com/api-keys',
  },
];

/// What a credential a person added is for.
const CUSTOM_WHY = 'A credential for a tool. Tools and workers on this server read it from the environment by this name.';

const KNOWN = new Set(KNOWN_SECRETS.map((s) => s.name));
/// Secrets overcli keeps for itself in the same store, never set in the
/// environment (a worker could read them there) and not on the Secrets page:
/// the key people's connected accounts are encrypted with.
export const PRIVATE_SECRETS = new Set(['OVERCLI_CONNECTIONS_KEY']);
const CREDENTIAL_SHAPE = /^[A-Z][A-Z0-9_]{1,62}_(?:TOKEN|API_KEY|KEY|SECRET|PASSWORD)$/;
const RESERVED = /^(?:OVERCLI_|ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|AWS_|GOOGLE_|GCP_|GIT_|GH_|NODE_|NPM_|LD_|DYLD_|SSH_)/;
const MAX_VALUE = 16_000;

/// Null when the name is fine; otherwise why not.
export function checkSecretName(name: string): string | null {
  if (KNOWN.has(name)) return null;
  if (!CREDENTIAL_SHAPE.test(name)) return 'Use one of the listed names, or a credential name like JIRA_API_TOKEN (capitals, ending _TOKEN, _API_KEY, _KEY, _SECRET or _PASSWORD).';
  if (RESERVED.test(name)) return 'That name is reserved: it could change how overcli, git or the model run. Use one of the listed names.';
  return null;
}

export interface SecretStatus {
  name: string;
  label?: string;
  why: string;
  how?: string;
  link?: string;
  /// `notNeeded`: unset, and the server doesn't use it (an Anthropic key
  /// while the model is on Bedrock).
  state: 'environment' | 'stored' | 'missing' | 'notNeeded';
  updatedAt?: number;
  updatedBy?: string;
  /// What needs it, e.g. "pushing to app".
  neededBy: string[];
}

export interface ModelProvider {
  provider: 'anthropic' | 'bedrock' | 'vertex';
  detail: string;
}

export interface SecretsServiceDeps {
  store: SecretStore;
  env?: NodeJS.ProcessEnv;
  log(message: string): void;
  /// After a change applies, with the names that changed (Slack reconnects
  /// when its tokens do).
  onChange?(names: string[]): void;
}

export class SecretsService {
  private readonly env: NodeJS.ProcessEnv;
  /// Names the operator set before we started: theirs, never touched.
  private readonly pinned: Set<string>;
  private applied = new Map<string, string>();
  private meta: SecretMeta[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;
  private listeners: Array<(names: string[]) => void> = [];

  constructor(private readonly deps: SecretsServiceDeps) {
    this.env = deps.env ?? process.env;
    this.pinned = new Set(Object.keys(this.env).filter((k) => !!this.env[k]?.trim()));
  }

  get store(): Pick<SecretStore, 'kind' | 'where' | 'readOnly' | 'warning'> {
    return this.deps.store;
  }

  /// Told the names after a change applies.
  onChange(listener: (names: string[]) => void): void {
    this.listeners.push(listener);
  }

  private changed(names: string[]): void {
    this.deps.onChange?.(names);
    for (const l of this.listeners) l(names);
  }

  /// Read the store and apply it. A failure keeps what was applied before:
  /// a blip in Secrets Manager must not sign Slack out.
  async load(): Promise<{ ok: true } | { ok: false; error: string }> {
    let got: { values: Record<string, string>; meta: SecretMeta[] };
    try {
      got = await this.deps.store.load();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.deps.log(`secrets: could not read ${this.deps.store.where}: ${this.lastError}`);
      return { ok: false, error: this.lastError };
    }
    this.lastError = null;
    this.meta = got.meta;
    const changed: string[] = [];
    for (const [name, value] of Object.entries(got.values)) {
      if (this.pinned.has(name) || checkSecretName(name)) continue;
      if (this.applied.get(name) !== value) changed.push(name);
      this.env[name] = value;
      this.applied.set(name, value);
      applied.add(name);
    }
    for (const name of [...this.applied.keys()]) {
      if (name in got.values) continue;
      delete this.env[name];
      this.applied.delete(name);
      changed.push(name);
    }
    if (changed.length) this.changed(changed);
    return { ok: true };
  }

  /// Re-read every few minutes, so a secret rotated in the cloud console (or
  /// by Terraform) applies without a redeploy.
  start(everyMs = 5 * 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.load(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /// Which model provider the server's environment selects, for the top of
  /// the Secrets page: it decides which model secrets matter.
  model(): ModelProvider {
    const on = (name: string) => /^(1|true|yes)$/i.test(this.env[name]?.trim() ?? '');
    if (on('CLAUDE_CODE_USE_BEDROCK')) {
      const region = this.env.AWS_REGION || this.env.AWS_DEFAULT_REGION;
      return { provider: 'bedrock', detail: `Bedrock${region ? ` in ${region}` : ''}, through the server's AWS role${this.env.AWS_BEARER_TOKEN_BEDROCK ? ' or its Bedrock API key' : ''}` };
    }
    if (on('CLAUDE_CODE_USE_VERTEX')) {
      const where = [this.env.ANTHROPIC_VERTEX_PROJECT_ID, this.env.CLOUD_ML_REGION].filter(Boolean).join(', ');
      return { provider: 'vertex', detail: `Vertex AI${where ? ` (${where})` : ''}, through the server's Google service account` };
    }
    return { provider: 'anthropic', detail: 'The Anthropic API, with ANTHROPIC_API_KEY' };
  }

  status(neededBy: (name: string) => string[] = () => []): { secrets: SecretStatus[]; error: string | null; model: ModelProvider } {
    const meta = new Map(this.meta.map((m) => [m.name, m]));
    const model = this.model();
    // Model secrets the chosen provider doesn't read.
    const unused = new Set(model.provider === 'anthropic' ? ['AWS_BEARER_TOKEN_BEDROCK'] : model.provider === 'bedrock' ? ['ANTHROPIC_API_KEY'] : ['ANTHROPIC_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK']);
    const names = [...new Set([...KNOWN_SECRETS.map((s) => s.name), ...this.applied.keys(), ...this.meta.map((m) => m.name)])].filter((n) => !PRIVATE_SECRETS.has(n));
    return {
      error: this.lastError,
      model,
      secrets: names.map((name) => {
        const m = meta.get(name);
        const known = KNOWN_SECRETS.find((s) => s.name === name);
        return {
          name,
          ...(known ? { label: known.label, why: known.why, how: known.how, ...(known.link ? { link: known.link } : {}) } : { why: CUSTOM_WHY }),
          state: this.pinned.has(name) ? 'environment' : this.applied.has(name) ? 'stored' : unused.has(name) ? 'notNeeded' : 'missing',
          ...(m?.updatedAt ? { updatedAt: m.updatedAt } : {}),
          ...(m?.updatedBy ? { updatedBy: m.updatedBy } : {}),
          neededBy: neededBy(name),
        };
      }),
    };
  }

  async set(name: string, value: string, by: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const bad = checkSecretName(name);
    if (bad) return { ok: false, error: bad };
    if (this.deps.store.readOnly) return { ok: false, error: `Secrets are managed in ${this.deps.store.where}. Change it there; this server picks it up within a few minutes.` };
    if (this.pinned.has(name)) return { ok: false, error: `${name} is set in this server's environment (the task definition or deploy/.env), which wins. Change it there.` };
    const clean = value.trim();
    if (!clean) return { ok: false, error: 'Paste the value.' };
    if (clean.length > MAX_VALUE) return { ok: false, error: 'That value is too long for a secret.' };
    try {
      await this.deps.store.set(name, clean, by);
    } catch (err) {
      return { ok: false, error: `Could not save it to ${this.deps.store.where}: ${err instanceof Error ? err.message : String(err)}` };
    }
    this.env[name] = clean;
    this.applied.set(name, clean);
    applied.add(name);
    this.meta = [...this.meta.filter((m) => m.name !== name), { name, updatedAt: Date.now(), updatedBy: by }];
    this.changed([name]);
    return { ok: true };
  }

  /// One of overcli's own secrets (PRIVATE_SECRETS), read from the store
  /// directly. A failed read throws: the caller must not mistake it for none.
  async getPrivate(name: string): Promise<string | undefined> {
    if (!PRIVATE_SECRETS.has(name)) return undefined;
    return (await this.deps.store.load()).values[name];
  }

  /// Keep one of overcli's own secrets. False when the store can't take it.
  async setPrivate(name: string, value: string): Promise<boolean> {
    if (!PRIVATE_SECRETS.has(name) || this.deps.store.readOnly) return false;
    try {
      await this.deps.store.set(name, value, 'overcli');
      return true;
    } catch (err) {
      this.deps.log(`secrets: could not keep ${name} in ${this.deps.store.where}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async remove(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
    // Removing it would make every connected account unreadable.
    if (PRIVATE_SECRETS.has(name)) return { ok: false, error: 'No secret by that name.' };
    if (this.deps.store.readOnly) return { ok: false, error: `Secrets are managed in ${this.deps.store.where}. Remove it there.` };
    if (this.pinned.has(name)) return { ok: false, error: `${name} is set in this server's environment. Remove it there.` };
    if (!this.applied.has(name) && !this.meta.some((m) => m.name === name)) return { ok: false, error: 'No secret by that name.' };
    try {
      await this.deps.store.remove(name);
    } catch (err) {
      return { ok: false, error: `Could not remove it from ${this.deps.store.where}: ${err instanceof Error ? err.message : String(err)}` };
    }
    delete this.env[name];
    this.applied.delete(name);
    this.meta = this.meta.filter((m) => m.name !== name);
    this.changed([name]);
    return { ok: true };
  }
}

const MODEL_KEYS = new Set(['ANTHROPIC_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'OPENAI_API_KEY']);
const applied = new Set<string>();
/// Names a spawned worker must never see: every stored secret except the model
/// keys, and the keys that unlock the server's own stores, however they were set.
export function workerHiddenSecretNames(): Set<string> {
  return new Set([...KNOWN_SECRETS.map((s) => s.name), ...applied, SECRETS_KEY_ENV, ...PRIVATE_SECRETS].filter((n) => !MODEL_KEYS.has(n)));
}
export function stripSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const hidden = workerHiddenSecretNames();
  return Object.fromEntries(Object.entries(env).filter(([k]) => !hidden.has(k)));
}
