// Repos the org's workers may change: connected once by an admin, then any
// worker given one works in it and lands its changes as a pushed branch, with
// the link to open a pull request from it. A person opens the PR — the review
// starts with someone deciding the change is worth one.
//
// Connecting clones the repo onto the server's disk and registers it as a
// project. Three things keep the work reviewable:
//   - a pre-push hook in the clone refuses pushes to the default branch, so a
//     change can only arrive as a branch (branch protection on the host is
//     the real guard; this stops the honest mistake on the server's side);
//   - the token never touches disk: git asks a credential helper that reads
//     it from the environment ($GH_TOKEN, $BITBUCKET_TOKEN, $GIT_TOKEN), and
//     only for this clone;
//   - the worker's flow pushes in a step marked external, so a worker on
//     probation stops for its manager's yes before anything leaves.
//
// GitHub, Bitbucket Cloud, and any other git host over https or ssh. Over
// ssh the server's own key (in ~/.ssh) is used and no token is needed.

import fs from 'node:fs';
import path from 'node:path';
import { stripSecrets } from './secrets';
import { isSafeIdSegment } from '../../shared/flows/safeId';
import { DEFAULT_PR_MODE, PR_MODES, type PrMode } from './prOpen';

export type RepoHost = 'github' | 'bitbucket' | 'other';

/// A token rather than an account name: a known token shape, a stand-in
/// user for tokens, or simply too long to be a name.
function looksLikeToken(name: string): boolean {
  return name.length >= 30 || /^(gh[pousr]_|github_pat_|glpat-|ATBB|ATAT|ATCTT|xox[abp]-)/.test(name) || /^(x-token-auth|x-access-token|oauth2|x-bitbucket-api-token-auth)$/i.test(name);
}

export const LOCAL_REPOS_ENV = 'OVERCLI_ALLOW_LOCAL_REPOS';

export interface ConnectedRepo {
  name: string;
  url: string;
  path: string;
  defaultBranch: string;
  /// Absent on repos connected before hosts were told apart: read from url.
  host?: RepoHost;
  /// The repo's test command, run before the branch is pushed. Absent: none.
  testCommand?: string;
  addedBy: string;
  at: number;
}

/// Connected repos grouped so one worker or team can change them together —
/// "the storefront: app, api and infra". On the server it is a real
/// workspace: a folder with a link to each clone (the worker plans from it),
/// and every run forks one worktree per repo (runtime.ts, forkWorktrees).
export interface OrgWorkspace {
  /// `ws-<slug>`: the workspace's id in the store, and its folder's name.
  id: string;
  name: string;
  /// Connected repos' names, in the order shown.
  repos: string[];
  /// Read by every run in it (written as its context files): which repo owns
  /// what, how they fit together, what to keep in step.
  instructions?: string;
  rootPath: string;
  addedBy: string;
  at: number;
}

export interface RepoState {
  repos: ConnectedRepo[];
  workspaces?: OrgWorkspace[];
  /// Left by a build whose Repos page could turn repo tests on. Cleared, with
  /// the test commands set beside it, when the server starts (RepoService).
  testsAsServer?: boolean;
  /// How many times a red CI build goes back to the worker before its
  /// manager hears (ciWatch.ts). Absent: DEFAULT_CI_ROUNDS. 0: tell at once.
  ciRounds?: number;
  /// Whether the server opens the pull request for a pushed branch
  /// (prOpen.ts). Absent: a draft.
  prMode?: PrMode;
}

export const DEFAULT_CI_ROUNDS = 3;

export interface RepoDeps {
  store: { load(): RepoState; save(state: RepoState): void };
  /// Where clones go: <data dir>/repos.
  reposDir: string;
  git(args: string[], cwd?: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;
  registerProject(projectPath: string, name: string): void;
  /// Build (or rebuild) a workspace's folder of links, and put it in the
  /// store so runs fork a worktree per repo. Null removes it.
  registerWorkspace(ws: { id: string; name: string; repos: Array<{ name: string; path: string }>; instructions?: string } | { id: string; remove: true }): { ok: true; rootPath: string } | { ok: false; error: string };
  env(name: string): string | undefined;
  log?(message: string): void;
  now?(): number;
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/// Where each host's token comes from, and the user name it goes with.
export const HOST_CREDENTIALS: Record<RepoHost, { tokenEnv: string; userEnv: string; defaultUser: string; label: string }> = {
  github: { tokenEnv: 'GH_TOKEN', userEnv: 'GH_USER', defaultUser: 'x-access-token', label: 'a GitHub token that can read and push to this repo' },
  bitbucket: { tokenEnv: 'BITBUCKET_TOKEN', userEnv: 'BITBUCKET_USER', defaultUser: 'x-token-auth', label: 'a Bitbucket access token with read and write on this repo' },
  other: { tokenEnv: 'GIT_TOKEN', userEnv: 'GIT_USER', defaultUser: 'oauth2', label: 'a token for this git host that can read and push' },
};

export interface ParsedRepoUrl {
  url: string;
  name: string;
  host: RepoHost;
  /// The host name, for the credential helper's scope.
  hostname: string;
  ssh: boolean;
  /// The repo's web page, for the link to open a pull request.
  web: string;
}

function hostKind(hostname: string): RepoHost {
  return hostname === 'github.com' ? 'github' : hostname === 'bitbucket.org' ? 'bitbucket' : 'other';
}

/// https://github.com/acme/app(.git), git@bitbucket.org:acme/app.git, or any
/// https or ssh git remote. The repo's own name comes from the last segment.
export function parseRepoUrl(raw: string, opts: { allowLocal?: boolean } = {}): ({ ok: true } & ParsedRepoUrl) | { ok: false; error: string } {
  const url = raw.trim();
  // A repo on this machine's disk: for trying Repos on a laptop, and tests.
  // Off unless $OVERCLI_ALLOW_LOCAL_REPOS=1 — a server has no business
  // cloning from its own filesystem.
  const local = /^file:\/\/(\/[^?#]+?)\/?$/.exec(url);
  if (local) {
    if (!opts.allowLocal) return { ok: false, error: 'Use an https:// or git@ address.' };
    const parts = local[1].replace(/\.git$/, '').split('/').filter(Boolean);
    return { ok: true, url, name: parts[parts.length - 1] ?? 'repo', host: 'other', hostname: '', ssh: true, web: '' };
  }
  const ssh = /^git@([\w.-]+):([\w./-]+?)(?:\.git)?$/.exec(url);
  if (ssh) {
    const parts = ssh[2].split('/').filter(Boolean);
    if (parts.length < 2) return { ok: false, error: 'That address names no repo. It looks like git@github.com:acme/app.git' };
    return { ok: true, url, name: parts[parts.length - 1], host: hostKind(ssh[1]), hostname: ssh[1], ssh: true, web: `https://${ssh[1]}/${parts.join('/')}` };
  }
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return { ok: false, error: 'Use an https:// or git@ address.' };
    // A host's own "clone" address carries the account name
    // (https://pat@bitbucket.org/…): dropped, since the token signs in. A
    // password, or a token pasted where the name goes, is a secret.
    if (u.password || looksLikeToken(decodeURIComponent(u.username))) return { ok: false, error: 'Leave the token out of the address — set it on the server instead.' };
    const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (parts.length < 2) return { ok: false, error: 'That address names no repo. It looks like https://github.com/acme/app' };
    const web = `${u.origin}/${parts.join('/')}`;
    return { ok: true, url: `${web}.git`, name: parts[parts.length - 1], host: hostKind(u.hostname), hostname: u.hostname, ssh: false, web };
  } catch {
    return { ok: false, error: 'That is not a repo address. It looks like https://github.com/acme/app' };
  }
}

/// Why the server won't run a repo's test command, or undefined when it will.
/// By default it won't: tests would run as the server's own user, which can
/// read its secrets. An operator either names a user that can't
/// (OVERCLI_TEST_UID, a number, not root) or accepts the risk on purpose
/// (OVERCLI_TEST_AS_SERVER=1). Without either, a repo with a test command
/// pushes nothing.
export function testUserRefusal(env: NodeJS.ProcessEnv): string | undefined {
  const uid = env.OVERCLI_TEST_UID?.trim();
  const gid = env.OVERCLI_TEST_GID?.trim();
  if (uid) {
    if (!/^\d+$/.test(uid)) return `OVERCLI_TEST_UID is "${uid.slice(0, 40)}", not a number. Set it to the numeric id of a user that cannot read the server's data directory.`;
    if (Number(uid) === 0) return 'OVERCLI_TEST_UID is 0, which is root. Set it to a user that cannot read the server\'s data directory.';
    if (gid && !/^\d+$/.test(gid)) return `OVERCLI_TEST_GID is "${gid.slice(0, 40)}", not a number. Set it to a numeric group id, or leave it out to use the user's id.`;
    return undefined;
  }
  if (env.OVERCLI_TEST_AS_SERVER === '1') return undefined;
  return (
    'The server would run them as its own user, which can read its secrets. ' +
    'Set OVERCLI_TEST_UID (and OVERCLI_TEST_GID) to a user that cannot read the data directory, ' +
    'or OVERCLI_TEST_AS_SERVER=1 to run them as the server. See deploy/README.md.'
  );
}

/// A test command a worker may run: one line, no shell plumbing. It becomes
/// a narrowed grant, `Bash(<command>:*)`, so it must not smuggle in a second
/// command.
export function checkTestCommand(raw: string | undefined): { ok: true; command?: string } | { ok: false; error: string } {
  const command = raw?.trim();
  if (!command) return { ok: true };
  if (command.length > 80 || /[;&|`$<>(){}\n\\]/.test(command)) {
    return { ok: false, error: 'Give one plain command, like "npm test" — no ;, &&, pipes or redirects.' };
  }
  return { ok: true, command };
}

/// The clone's pre-push hook. Refuses a push to the default branch. The repo's
/// tests run before the server pushes (landBranches.ts), never here.
export function prePushHook(defaultBranch: string): string {
  return [
    '#!/bin/sh',
    '# Installed by overcli: workers push branches; people open the pull requests.',
    'while read local_ref local_sha remote_ref remote_sha; do',
    `  if [ "$remote_ref" = "refs/heads/${defaultBranch}" ]; then`,
    `    echo "overcli: pushes to ${defaultBranch} are refused here; push a branch instead." >&2`,
    '    exit 1',
    '  fi',
    'done',
    'exit 0',
    '',
  ].join('\n');
}

/// The credential helper git calls for this host: the token from the
/// environment, never written down.
export function credentialHelper(host: RepoHost): string {
  const c = HOST_CREDENTIALS[host];
  return `!f() { test "$1" = get && echo "username=\${${c.userEnv}:-${c.defaultUser}}" && echo "password=$${c.tokenEnv}"; }; f`;
}

/// The page that opens a pull request from `branch`, where the host has one
/// we know. Null: say the link git printed when it pushed, if any.
export function newPullRequestLink(repo: Pick<ConnectedRepo, 'url' | 'defaultBranch'>, branch: string): string | null {
  const parsed = parseRepoUrl(repo.url);
  if (!parsed.ok) return null;
  if (parsed.host === 'github') return `${parsed.web}/compare/${repo.defaultBranch}...${branch}?expand=1`;
  if (parsed.host === 'bitbucket') return `${parsed.web}/pull-requests/new?source=${branch}&dest=${repo.defaultBranch}`;
  return null;
}

/// The note every step of a run on a connected repo or workspace ends with:
/// a worker has no git credentials (the token stays in the server), so
/// without it a worker reaches for `git fetch`, fails, and asks its manager
/// for a token it was never meant to have.
export function serverGitNote(tests: string[]): string {
  return [
    'How git works for this run: overcli fetched origin, every branch, just before the run started, so',
    'origin/<branch> is current, including the branch of any open pull request. Do not run git fetch, pull',
    'or push, and do not ask for git credentials: this run has none on purpose. To build on an open pull',
    'request, start from its origin/ branch. When the run ends, overcli commits your change and pushes it.',
    tests.length ? `Before it pushes, it runs ${tests.join(', ')} and refuses a failing push, so run them yourself first if you can.` : '',
  ].filter(Boolean).join('\n');
}

export class RepoService {
  constructor(private readonly deps: RepoDeps) {
    // CI checks each push now (ciWatch.ts), so the Repos page no longer turns
    // repo tests on. What it turned on goes, test commands with it: left
    // alone, a command would hold every push back with "tests are off here".
    const state = deps.store.load();
    if (state.testsAsServer) {
      const had = state.repos.filter((x) => x.testCommand).map((x) => x.name);
      const { testsAsServer: _was, ...rest } = state;
      deps.store.save({ ...rest, repos: state.repos.map(({ testCommand: _cmd, ...x }) => x) });
      deps.log?.(`Repo tests are no longer turned on from the Repos page; CI checks pushes instead.${had.length ? ` Cleared the test commands of ${had.join(', ')}.` : ''}`);
    }
  }

  prMode(): PrMode {
    return this.deps.store.load().prMode ?? DEFAULT_PR_MODE;
  }

  setPrMode(mode: string): Result {
    if (!(PR_MODES as readonly string[]).includes(mode)) return { ok: false, error: 'Say link, draft or open.' };
    this.save({ prMode: mode as PrMode });
    return { ok: true };
  }

  ciRounds(): number {
    return this.deps.store.load().ciRounds ?? DEFAULT_CI_ROUNDS;
  }

  setCiRounds(n: number): Result {
    if (!Number.isInteger(n) || n < 0 || n > 10) return { ok: false, error: 'Pick 0 to 10 rounds.' };
    this.save({ ciRounds: n });
    return { ok: true };
  }

  list(): ConnectedRepo[] {
    return this.deps.store.load().repos;
  }

  get(name: string): ConnectedRepo | undefined {
    return this.list().find((r) => r.name === name);
  }

  /// Why this server won't run repo tests (so a repo with a test command
  /// pushes nothing), or undefined when it will.
  testsOff(): string | undefined {
    const env = (name: string) => this.deps.env(name);
    return testUserRefusal({ OVERCLI_TEST_UID: env('OVERCLI_TEST_UID'), OVERCLI_TEST_GID: env('OVERCLI_TEST_GID'), OVERCLI_TEST_AS_SERVER: env('OVERCLI_TEST_AS_SERVER') });
  }

  /// Whether the server can push to this repo: over ssh with its own key, or
  /// over https with the host's token set.
  canPush(repo: Pick<ConnectedRepo, 'url'>): boolean {
    const parsed = parseRepoUrl(repo.url, { allowLocal: true });
    if (!parsed.ok) return false;
    return parsed.ssh || !!this.deps.env(HOST_CREDENTIALS[parsed.host].tokenEnv)?.trim();
  }

  /// The secret a repo needs to push over https, or null (ssh needs none).
  tokenFor(repo: Pick<ConnectedRepo, 'url'>): string | null {
    const parsed = parseRepoUrl(repo.url, { allowLocal: true });
    return parsed.ok && !parsed.ssh ? HOST_CREDENTIALS[parsed.host].tokenEnv : null;
  }

  async connect(input: { url: string; name?: string; testCommand?: string }, by: string): Promise<Result<{ repo: ConnectedRepo }>> {
    const parsed = parseRepoUrl(input.url, { allowLocal: this.deps.env(LOCAL_REPOS_ENV) === '1' });
    if (!parsed.ok) return parsed;
    const test = checkTestCommand(input.testCommand);
    if (!test.ok) return test;
    const name = (input.name?.trim() || parsed.name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    if (!isSafeIdSegment(name)) return { ok: false, error: 'Give the repo a plain name: letters, digits, dashes.' };
    if (this.get(name)) return { ok: false, error: `${name} is already connected.` };
    const cred = HOST_CREDENTIALS[parsed.host];
    if (!parsed.ssh && parsed.host !== 'other' && !this.deps.env(cred.tokenEnv)?.trim()) {
      return { ok: false, error: `Add ${cred.tokenEnv} on Setup → Secrets first (${cred.label}). Or connect with the git@ address and the server's ssh key.` };
    }
    const dir = path.join(this.deps.reposDir, name);
    let reuse = false;
    if (fs.existsSync(dir)) {
      const origin = await this.deps.git(['remote', 'get-url', 'origin'], dir);
      if (origin.ok && origin.stdout.trim() === parsed.url) reuse = true;
      else return { ok: false, error: `${dir} already exists on the server. Remove it, or connect under another name.` };
    }
    fs.mkdirSync(this.deps.reposDir, { recursive: true });
    const helperKey = `credential.https://${parsed.hostname}.helper`;
    const helper = parsed.ssh ? [] : ['-c', `${helperKey}=${credentialHelper(parsed.host)}`];
    const cloned = reuse ? { ok: true as const, stdout: '' } : await this.deps.git([...helper, 'clone', parsed.url, dir]);
    if (!cloned.ok) {
      const hint = !parsed.ssh && !this.deps.env(cred.tokenEnv)?.trim() ? ` If it's private, add ${cred.tokenEnv} (and ${cred.userEnv} if your host wants a user name) on Setup → Secrets.` : '';
      return { ok: false, error: `Could not clone it: ${cloned.error.slice(0, 400)}${hint}` };
    }
    if (!parsed.ssh) await this.deps.git(['config', helperKey, credentialHelper(parsed.host)], dir);
    const head = await this.deps.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir);
    const defaultBranch = head.ok ? head.stdout.trim().replace(/^origin\//, '') || 'main' : 'main';
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-push'), prePushHook(defaultBranch), { mode: 0o755 });
    this.deps.registerProject(dir, name);
    const repo: ConnectedRepo = {
      name,
      url: parsed.url,
      path: dir,
      defaultBranch,
      host: parsed.host,
      ...(test.command ? { testCommand: test.command } : {}),
      addedBy: by,
      at: this.deps.now?.() ?? Date.now(),
    };
    this.save({ repos: [...this.list(), repo] });
    return { ok: true, repo };
  }

  /// Forget a repo. The clone stays on disk until someone deletes it: a
  /// worker's branch may still be in it.
  disconnect(name: string): Result {
    if (!this.get(name)) return { ok: false, error: 'No repo by that name.' };
    this.save({ repos: this.list().filter((r) => r.name !== name) });
    // A workspace it was in carries on with the rest; one left with a single
    // repo is no longer a workspace.
    for (const ws of this.workspaces().filter((w) => w.repos.includes(name))) {
      const rest = ws.repos.filter((r) => r !== name);
      if (rest.length < 2) this.removeWorkspace(ws.id);
      else this.updateWorkspace(ws.id, { repos: rest });
    }
    return { ok: true };
  }

  private save(patch: Partial<RepoState>): void {
    const state = this.deps.store.load();
    const ciRounds = patch.ciRounds ?? state.ciRounds;
    const prMode = patch.prMode ?? state.prMode;
    this.deps.store.save({ repos: patch.repos ?? state.repos, workspaces: patch.workspaces ?? state.workspaces ?? [], ...(ciRounds !== undefined ? { ciRounds } : {}), ...(prMode ? { prMode } : {}) });
  }

  // ---- WORKSPACES ----

  workspaces(): OrgWorkspace[] {
    return this.deps.store.load().workspaces ?? [];
  }

  workspace(idOrName: string): OrgWorkspace | undefined {
    const key = idOrName.trim().toLowerCase();
    return this.workspaces().find((w) => w.id === idOrName || w.name.toLowerCase() === key);
  }

  private members(names: string[]): Array<{ name: string; path: string }> {
    const repos = this.list();
    return names.map((n) => repos.find((r) => r.name === n)).filter((r): r is ConnectedRepo => !!r).map((r) => ({ name: r.name, path: r.path }));
  }

  createWorkspace(input: { name: string; repos: string[]; instructions?: string }, by: string): Result<{ workspace: OrgWorkspace }> {
    const name = input.name.trim().slice(0, 60);
    if (!name) return { ok: false, error: 'Give the workspace a name.' };
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    if (!slug) return { ok: false, error: 'Give the workspace a name with some letters in it.' };
    const id = `ws-${slug}`;
    if (this.workspaces().some((w) => w.id === id || w.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: `There is already a workspace called ${name}.` };
    const names = [...new Set(input.repos.map((r) => r.trim()).filter(Boolean))];
    const unknown = names.find((n) => !this.get(n));
    if (unknown) return { ok: false, error: `${unknown} isn't a connected repo.` };
    if (names.length < 2) return { ok: false, error: 'Pick at least two repos. One repo works on its own.' };
    const instructions = input.instructions?.trim().slice(0, 8000) || undefined;
    const made = this.deps.registerWorkspace({ id, name, repos: this.members(names), ...(instructions ? { instructions } : {}) });
    if (!made.ok) return made;
    const workspace: OrgWorkspace = { id, name, repos: names, ...(instructions ? { instructions } : {}), rootPath: made.rootPath, addedBy: by, at: this.deps.now?.() ?? Date.now() };
    this.save({ workspaces: [...this.workspaces(), workspace] });
    return { ok: true, workspace };
  }

  updateWorkspace(id: string, patch: { repos?: string[]; instructions?: string }): Result<{ workspace: OrgWorkspace }> {
    const ws = this.workspace(id);
    if (!ws) return { ok: false, error: 'No workspace by that name.' };
    const names = patch.repos ? [...new Set(patch.repos.map((r) => r.trim()).filter(Boolean))] : ws.repos;
    const unknown = names.find((n) => !this.get(n));
    if (unknown) return { ok: false, error: `${unknown} isn't a connected repo.` };
    if (names.length < 2) return { ok: false, error: 'A workspace needs at least two repos.' };
    const instructions = patch.instructions !== undefined ? patch.instructions.trim().slice(0, 8000) || undefined : ws.instructions;
    const made = this.deps.registerWorkspace({ id: ws.id, name: ws.name, repos: this.members(names), ...(instructions ? { instructions } : {}) });
    if (!made.ok) return made;
    const next: OrgWorkspace = { ...ws, repos: names, rootPath: made.rootPath };
    if (instructions) next.instructions = instructions;
    else delete next.instructions;
    this.save({ workspaces: this.workspaces().map((w) => (w.id === ws.id ? next : w)) });
    return { ok: true, workspace: next };
  }

  /// Rebuild every workspace from its repos' names: at startup, after a
  /// store repair, so each points at exactly the repos it was made with.
  rebuildWorkspaces(): void {
    for (const ws of this.workspaces()) {
      this.deps.registerWorkspace({ id: ws.id, name: ws.name, repos: this.members(ws.repos), ...(ws.instructions ? { instructions: ws.instructions } : {}) });
    }
  }

  removeWorkspace(id: string): Result {
    const ws = this.workspace(id);
    if (!ws) return { ok: false, error: 'No workspace by that name.' };
    this.deps.registerWorkspace({ id: ws.id, remove: true });
    this.save({ workspaces: this.workspaces().filter((w) => w.id !== ws.id) });
    return { ok: true };
  }

  /// Rewrite every clone's pre-push hook, at startup: a server upgraded to a
  /// newer hook (tests before pushing, say) applies it to repos connected
  /// before it.
  refreshHooks(): void {
    for (const r of this.list()) {
      try {
        fs.writeFileSync(path.join(r.path, '.git', 'hooks', 'pre-push'), prePushHook(r.defaultBranch), { mode: 0o755 });
      } catch {
        // the clone is gone; the Repos page shows it can't push
      }
    }
  }

  /// The narrowed grants a repo flow needs on this server, added to its
  /// allow-list: read-only git, for planning. Nothing that writes — the
  /// server commits and pushes (landBranches.ts), and the hook runs tests.
  codeTools(): string[] {
    if (!this.list().length) return [];
    return [...new Set([...READ_GIT_TOOLS, ...this.workspaces().flatMap((w) => workspaceGitTools(w.repos))])];
  }

  /// Bring the clones at these paths up to date with origin before a run
  /// forks its worktrees from them, so work starts from the default branch
  /// as it is now rather than as it was when the repo was connected. Paths
  /// that aren't connected repos are left alone. Returns what went wrong,
  /// for the log; a repo that can't be fetched forks from what its clone has.
  async freshen(paths: string[]): Promise<string[]> {
    const repos = this.list().filter((r) => paths.includes(r.path));
    const problems = await Promise.all(
      repos.map(async (r): Promise<string | null> => {
        const git = (args: string[]) => this.deps.git(args, r.path);
        // Every branch, not just the default: a follow-up on an open pull
        // request reads its branch from here, since a worker can't fetch.
        const fetched = await within(FRESHEN_MS, git(['fetch', '--prune', 'origin']));
        if (!fetched) return `${r.name}: fetching origin took too long; forking from the clone as it is.`;
        if (!fetched.ok) return `${r.name}: couldn't fetch origin (${fetched.error}); forking from the clone as it is.`;
        // The clone is the server's own and nobody works in it, so its
        // default branch simply moves to origin's. Checked out, it moves
        // with its files; otherwise only the branch moves.
        const head = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
        const moved =
          head.ok && head.stdout.trim() === r.defaultBranch
            ? await git(['merge', '--ff-only', `origin/${r.defaultBranch}`])
            : await git(['fetch', 'origin', `${r.defaultBranch}:${r.defaultBranch}`]);
        return moved.ok ? null : `${r.name}: couldn't move ${r.defaultBranch} to origin's (${moved.error}).`;
      }),
    );
    return problems.filter((p): p is string => !!p);
  }

  /// Commands that run without asking. None now that tests run in the hook;
  /// kept so the grants module has one place to ask.
  trustedCommands(): string[] {
    return [];
  }
}

/// Planning reads the most and decides the most; the rest is doing.
const PLAN_MODEL = 'claude-opus-5-5';
const WORK_MODEL = 'claude-sonnet-5-5';
const READ_GIT_TOOLS = ['Bash(git diff:*)', 'Bash(git status:*)', 'Bash(git log:*)'];
/// A workspace's run folder isn't a repo: git reaches each one by name.
const workspaceGitTools = (names: string[]) => names.flatMap((n) => ['status', 'diff', 'log'].map((c) => `Bash(git -C ${n} ${c}:*)`));
/// A fetch that hangs shouldn't hold a launch for long.
const FRESHEN_MS = 60_000;
const within = <T>(ms: number, p: Promise<T>): Promise<T | null> =>
  Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref?.())]);
const q = (tools: string[]) => tools.map((t) => (/[(]/.test(t) ? `"${t}"` : t)).join(', ');
const indent = (lines: string[]) => lines.map((l) => `      ${l}`).join('\n');

/// The last step of a repo or workspace flow: the pull request's words. It
/// runs nothing — once the run finishes, the server commits and pushes each
/// changed repo (landBranches.ts) with these as the commit message. External,
/// so on probation it waits for the manager's yes, and nothing is pushed
/// without it.
/// What the server's pull-request step is told: write the title and
/// description, nothing else; the server pushes after it.
export function pullRequestPrompt(what: string): string[] {
  return [
    'You write the pull request for a change that is already made. If the request above asks for',
    'commits, branches or pushes, that part is not yours: overcli does it after you, from your words.',
    'Write the pull request, and nothing else. The first line is its title: what',
    'changed, under 70 characters, no prefix. Then a blank line, then the description: what changed',
    `and why, which ${what} it touches, and how it was checked. When it fixes a bug, add a short "Root`,
    'cause" section: what was wrong and, if the run found it, when and in which commit it came in',
    '(from the git history it read). Plain markdown; no attribution lines.',
    'Run no commands. Once you finish and the change is approved, overcli commits it and pushes a',
    'branch in each repo that changed. Git runs each repo\'s tests first and refuses a push that',
    'fails, so say plainly if you expect a test to fail.',
  ];
}

function pullRequestStep(inputs: string, what: string): string[] {
  return [
    '  - id: pull-request',
    `    model: { backend: claude, model: ${WORK_MODEL} }`,
    // Not the shipper preset: that tells the model to commit, push and open
    // the PR itself, on top of anything said here.
    '    role: custom',
    '    effect: external',
    `    inputs: [${inputs}]`,
    `    tools: [${q(['Read', 'Grep', 'Glob'])}]`,
    '    system_prompt: |',
    indent(pullRequestPrompt(what)),
    '    output: pull-request.md',
  ];
}

/// The flow a worker uses on a connected repo: understand, change, then
/// push a branch and hand back the link to open a pull request. The push is
/// external, so it waits for a yes until the worker is trusted with it; the
/// clone's pre-push hook runs the repo's tests and refuses a failing push.
export function prFlowYaml(repo: ConnectedRepo): string {
  const test = repo.testCommand;
  return [
    `name: Change ${repo.name} and push a branch`,
    'description: |',
    `  Works in ${repo.name}: plans the change, makes it, then pushes a branch${test ? ` (git runs ${test} first and refuses a failing push)` : ''}`,
    `  and gives the link to open a pull request against ${repo.defaultBranch}. Never pushes to ${repo.defaultBranch}.`,
    'input: user_prompt',
    'steps:',
    '  - id: plan',
    `    model: { backend: claude, model: ${PLAN_MODEL} }`,
    '    role: planner',
    '    inputs: [user_prompt]',
    `    tools: [${q(['Read', 'Grep', 'Glob', ...READ_GIT_TOOLS])}]`,
    '    system_prompt: |',
    indent([
      `You are planning a change to the ${repo.name} repository, from a request someone made.`,
      'Read the request (and any screenshots), find the code involved, and write a short plan:',
      'which files change and how, and how you will know it works. Plan the change only — a later',
      'step branches, commits and pushes it. If the request is too vague to change code safely,',
      'say exactly what is missing instead of planning.',
    ]),
    '    output: plan.md',
    '  - id: build',
    `    model: { backend: claude, model: ${WORK_MODEL} }`,
    '    role: implementer',
    '    inputs: [user_prompt, plan.md]',
    `    tools: [${q(['Read', 'Edit', 'Write', 'Grep', 'Glob', ...READ_GIT_TOOLS])}]`,
    '    permission_mode: acceptEdits',
    '    system_prompt: |',
    indent([
      'Make the change the plan describes. Keep it small and in the style of the code around it.',
      'Add or update tests for it. Write only files that belong in the change: no notes or reports in',
      'the repo. Do not commit, branch or push: overcli does, once the change is approved.',
    ]),
    '    output: diff',
    ...pullRequestStep('user_prompt, plan.md, diff', 'files'),
    '',
  ].join('\n');
}

export function prFlowId(repo: Pick<ConnectedRepo, 'name'>): string {
  return `org-pr-${repo.name}`;
}

/// The flow a worker uses on a workspace: one change across its repos. Each
/// run works in its own worktree of every repo, side by side under the run's
/// folder and named after the repos. It plans across them, changes them, then
/// pushes a branch in every repo it changed — git runs each repo's tests
/// first — and hands back one link per repo to open its pull request.
export function workspaceFlowYaml(ws: OrgWorkspace, repos: ConnectedRepo[]): string {
  const members = ws.repos.map((n) => repos.find((r) => r.name === n)).filter((r): r is ConnectedRepo => !!r);
  const layout = members.map((r) => `- ${r.name}/: ${r.url}, pull requests against ${r.defaultBranch}${r.testCommand ? `, tests: ${r.testCommand}` : ''}`);
  const git = workspaceGitTools(members.map((r) => r.name));
  return [
    `name: Change the ${ws.name} workspace and push branches`,
    'description: |',
    `  One change across ${members.map((r) => r.name).join(', ')}: plans it, makes it in each repo it needs,`,
    '  then pushes a branch in every repo it changed (git runs each repo\'s tests first and refuses a',
    '  failing push) and gives one link per repo to open its pull request. Never pushes to a default branch.',
    'input: user_prompt',
    'steps:',
    '  - id: plan',
    `    model: { backend: claude, model: ${PLAN_MODEL} }`,
    '    role: planner',
    '    inputs: [user_prompt]',
    `    tools: [${q(['Read', 'Grep', 'Glob', ...git])}]`,
    '    system_prompt: |',
    indent([
      `You are planning one change across the ${ws.name} workspace, from a request someone made.`,
      'This folder holds a working copy of each repo, side by side, each already up to date with',
      'its default branch on origin:',
      ...layout,
      'This folder is not a repo itself. To see a repo\'s history or changes, name it with -C:',
      `git -C <repo> log, git -C <repo> diff, git -C <repo> status (for example git -C ${members[0]?.name ?? 'app'} log).`,
      'Those are the only commands you can run.',
      'Read the request (and any screenshots), find the code involved in each repo, and write a',
      'short plan: which repos change, which files in each and how, what must stay in step between',
      'them (an API field and the app that shows it), and how you will know it works. Leave out',
      'repos the change does not need. Plan the change only — a later step branches, commits and',
      'pushes it. If the request is too vague to change code safely, say exactly what is missing',
      'instead of planning.',
    ]),
    '    output: plan.md',
    '  - id: build',
    `    model: { backend: claude, model: ${WORK_MODEL} }`,
    '    role: implementer',
    '    inputs: [user_prompt, plan.md]',
    `    tools: [${q(['Read', 'Edit', 'Write', 'Grep', 'Glob', ...git])}]`,
    '    permission_mode: acceptEdits',
    '    system_prompt: |',
    indent([
      'Make the change the plan describes, in each repo it names. Keep each part small and in the',
      'style of the code around it, and keep the repos consistent with each other. Add or update',
      'tests. Write only files that belong in the change: no notes or reports in the repos. Do not',
      'commit, branch or push: overcli does, once the change is approved.',
    ]),
    '    output: diff',
    ...pullRequestStep('user_prompt, plan.md, diff', 'repos'),
    '',
  ].join('\n');
}

export function workspaceFlowId(ws: Pick<OrgWorkspace, 'id'>): string {
  return `org-pr-${ws.id}`;
}

/// The environment the server gives git: no stored secrets, only the host
/// tokens git needs to push.
export function credentialGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...stripSecrets(process.env), GIT_TERMINAL_PROMPT: '0' };
  for (const c of Object.values(HOST_CREDENTIALS)) {
    for (const k of [c.tokenEnv, c.userEnv]) if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}
