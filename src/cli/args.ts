// Argument parsing for `overcli`. Pure — no fs, no env reads, no engines — so
// every flag combination is a unit test rather than a subprocess.
//
// Deliberately hand-rolled rather than a dependency: the CLI ships inside the
// Electron app's package, and a arg-parser dependency would be a runtime dep
// for the desktop build too. The grammar is small enough that this is cheaper.

export type PermissionPolicy = 'deny' | 'allow-list' | 'auto-approve';

/// A worker's trust level, which decides how much a shift may launch without
/// an approval. Worker YAML deliberately does not carry it — see the header of
/// workerYaml.ts: trust is earned against the person who reviews the work, and
/// a file that arrived pre-trusted would be a way to hand someone a worker that
/// runs unattended on day one.
///
/// Headless that reasoning still holds, but the person is the pipeline author
/// and the declaration is the job file they committed. Without this flag a CI
/// worker is permanently on probation: it plans a shift, parks every proposal,
/// exits 2, and never does the work it was deployed to do.
export type WorkerTrust = 'probation' | 'trusted' | 'autonomous';

export const WORKER_TRUSTS: WorkerTrust[] = ['probation', 'trusted', 'autonomous'];

export const PERMISSION_POLICIES: PermissionPolicy[] = ['deny', 'allow-list', 'auto-approve'];

export interface RunOptions {
  /// Path to a flow or worker YAML file. Which one it is is decided by
  /// reading it, not by the flag — see `run.ts`.
  file: string;
  /// Project the run works in. Defaults, in order, to $GITHUB_WORKSPACE,
  /// $WORKSPACE (Jenkins), then the process cwd — see `defaultCwd`.
  cwd?: string;
  /// The run's `user_prompt`. Optional for a worker (a shift plans its own
  /// work); a flow with no prompt gets an empty one, which is legal.
  input?: string;
  permissions: PermissionPolicy;
  /// Tool names pre-approved under `allow-list`. Everything else is denied.
  allowTools: string[];
  /// Persistent state root. Absent means a throwaway directory, which is the
  /// honest default for CI: a worker with no journal is "shift 1" every time,
  /// and pretending otherwise would silently lose its memory.
  stateDir?: string;
  /// Where to copy the run's deliverables when it finishes.
  artifactsDir?: string;
  runIn?: 'cwd' | 'worktree';
  /// One JSON object on stdout at the end; progress as JSON lines on stderr.
  json: boolean;
  /// `ollama=claude:sonnet` — swap a backend out before preflight sees it, so
  /// a flow written against a local model can run on a hosted runner.
  modelOverrides: Array<{ from: string; to: string }>;
  branchPrefix?: string;
  /// Only meaningful for a worker file. Defaults to `probation`, which parks
  /// everything for review — the safe answer, and the one that makes an
  /// unconfigured job visibly do nothing rather than invisibly do something.
  trust: WorkerTrust;
  /// Seconds before the run is aborted. 0 disables the timer.
  timeoutSeconds: number;
}

/// `overcli serve`. Deliberately a different shape from `RunOptions` rather
/// than `RunOptions` with an empty `file`: a daemon has no file, no cwd, no
/// artifacts directory and no timeout, and a shared type would have to make
/// all of those optional for one caller and then re-check them for the other.
/// The three flags it does take mean exactly what they mean for `run`, and
/// share the same parsing helpers below so they cannot drift.
export interface ServeOptions {
  /// Persistent state root. Unlike `run`, absent does NOT mean a throwaway
  /// directory — it means `$OVERCLI_HOME` / `~/.overcli`, because a daemon
  /// whose schedules and workers vanished on restart would be pointless.
  stateDir?: string;
  permissions: PermissionPolicy;
  allowTools: string[];
  /// Serve the org control plane — MCP at /mcp and the web console at / —
  /// on this address. Absent: no listener at all, as before.
  control?: { host: string; port: number };
}

/// `overcli tokens`: who may call the control plane.
export interface TokensOptions {
  action: 'create' | 'list' | 'revoke';
  stateDir?: string;
  name?: string;
  slackUserId?: string;
  admin: boolean;
  /// For revoke: a token id or name.
  target?: string;
}

/// `overcli projects`: the folders workers on this box may work in.
export interface ProjectsOptions {
  action: 'add' | 'list';
  stateDir?: string;
  path?: string;
  name?: string;
}

/// `overcli workers push`: publish a worker to the org's server.
export interface WorkersPushOptions {
  /// A worker share file, or the name of a worker in --state-dir.
  target: string;
  to?: string;
  token?: string;
  stateDir?: string;
  visibility?: 'private' | 'team' | 'org';
}

/// `overcli org`: who this box's org is.
export interface OrgOptions {
  action: 'init' | 'show';
  stateDir?: string;
  name?: string;
  admins: string[];
  slackTeamId?: string;
  timezone?: string;
  publicUrl?: string;
  force: boolean;
}

/// `overcli mcp`. The same three flags as `serve` — they mean the same thing,
/// because a run an MCP client starts is just as unattended as a scheduled
/// one — plus `--cwd`, the project a `run_flow` call works in when the call
/// does not name one. Kept separate from `ServeOptions` for the same reason
/// that one is separate from `RunOptions`: the field sets diverge.
export interface McpOptions {
  /// Persistent state root. Like `serve`, absent means `$OVERCLI_HOME` /
  /// `~/.overcli`: the point is to reach the flows you already saved.
  stateDir?: string;
  permissions: PermissionPolicy;
  allowTools: string[];
  /// Default project for `run_flow`. Absent means `defaultCwd` at call time.
  cwd?: string;
}

/// `overcli workers audit`. Read-only, so it takes no permission policy.
export interface WorkersAuditOptions {
  /// Where the saved batches live. Absent means $OVERCLI_HOME, then the
  /// desktop app's data directory, then ~/.overcli — see
  /// `resolveAuditStateDir` in workers.ts for why the app's comes first.
  stateDir?: string;
  json: boolean;
}

export interface ParsedArgs {
  command: 'run' | 'serve' | 'mcp' | 'workers' | 'workersPush' | 'teamsPush' | 'tokens' | 'projects' | 'org' | 'help' | 'version';
  run?: RunOptions;
  serve?: ServeOptions;
  mcp?: McpOptions;
  workers?: WorkersAuditOptions;
  tokens?: TokensOptions;
  projects?: ProjectsOptions;
  org?: OrgOptions;
  workersPush?: WorkersPushOptions;
  /// `overcli teams push`: the same options; the target is a team's name.
  teamsPush?: WorkersPushOptions;
  /// Non-fatal complaints about the arguments themselves, printed before the
  /// run starts. A flag we accept but that cannot do anything in this context
  /// belongs here rather than in a failure.
  warnings: string[];
}

export interface ParseFailure {
  ok: false;
  error: string;
}

const FLAGS_WITH_VALUES = new Set([
  '--cwd',
  '--input',
  '--permissions',
  '--allow-tool',
  '--state-dir',
  '--artifacts-dir',
  '--run-in',
  '--model-override',
  '--branch-prefix',
  '--timeout',
  '--trust',
]);

/// Where the project comes from when nobody said. CI runners have already
/// checked the repo out by the time the job reaches us, and both major
/// systems advertise where: Actions sets $GITHUB_WORKSPACE, Jenkins sets
/// $WORKSPACE. Falling through to `cwd` keeps `overcli run flow.yaml` working
/// on a laptop.
export function defaultCwd(env: NodeJS.ProcessEnv, processCwd: string): string {
  return env.GITHUB_WORKSPACE?.trim() || env.WORKSPACE?.trim() || processCwd;
}

/// Shared by `run` and `serve` so the two can never disagree about what a
/// policy name is.
function parsePermissionPolicy(value: string): PermissionPolicy | ParseFailure {
  if (!PERMISSION_POLICIES.includes(value as PermissionPolicy)) {
    return {
      ok: false,
      error: `--permissions must be one of ${PERMISSION_POLICIES.join(', ')} (got "${value}").`,
    };
  }
  return value as PermissionPolicy;
}

/// Repeatable, and also comma-splittable so one CI variable can carry the
/// whole list.
function pushAllowTools(into: string[], value: string): void {
  into.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
}

/// The two complaints about `--allow-tool` that are worth making but not
/// worth failing over. Identical for `run` and `serve`.
function allowToolWarnings(permissions: PermissionPolicy, allowTools: string[]): string[] {
  const out: string[] = [];
  if (allowTools.length > 0 && permissions !== 'allow-list') {
    out.push(
      `--allow-tool only applies under --permissions allow-list; ignoring ${allowTools.length} of them.`,
    );
  }
  if (permissions === 'allow-list' && allowTools.length === 0) {
    out.push(
      '--permissions allow-list with no --allow-tool denies everything, same as --permissions deny.',
    );
  }
  return out;
}

/// The flags `serve` accepts. Everything else `run` takes is about a single
/// file-shaped run and has no meaning for a process that outlives every run
/// it starts, so those are refused by name rather than silently ignored.
const SERVE_FLAGS = new Set(['--state-dir', '--permissions', '--allow-tool', '--control']);

function parseServe(rest: string[]): { ok: true; args: ParsedArgs } | ParseFailure {
  const opts: ServeOptions = { permissions: 'deny', allowTools: [] };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      return { ok: false, error: `overcli serve takes no file arguments (got "${arg}").` };
    }
    let name = arg;
    let inlineValue: string | undefined;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }
    if (!SERVE_FLAGS.has(name)) {
      return {
        ok: false,
        error: FLAGS_WITH_VALUES.has(name) || name === '--json'
          ? `${name} is a "run" option; overcli serve takes ${[...SERVE_FLAGS].join(', ')}.`
          : `Unknown option "${name}".`,
      };
    }
    const value = inlineValue ?? rest[++i];
    if (value === undefined) return { ok: false, error: `${name} needs a value.` };

    switch (name) {
      case '--state-dir':
        opts.stateDir = value;
        break;
      case '--permissions': {
        const policy = parsePermissionPolicy(value);
        if (typeof policy !== 'string') return policy;
        opts.permissions = policy;
        break;
      }
      case '--allow-tool':
        pushAllowTools(opts.allowTools, value);
        break;
      case '--control': {
        const control = parseControlAddress(value);
        if ('error' in control) return { ok: false, error: control.error };
        opts.control = control;
        break;
      }
    }
  }

  return {
    ok: true,
    args: {
      command: 'serve',
      serve: opts,
      warnings: allowToolWarnings(opts.permissions, opts.allowTools),
    },
  };
}

/// The flags `mcp` accepts: `serve`'s, plus the project `run_flow` defaults to.
const MCP_FLAGS = new Set(['--state-dir', '--permissions', '--allow-tool', '--cwd']);

function parseMcp(rest: string[]): { ok: true; args: ParsedArgs } | ParseFailure {
  const opts: McpOptions = { permissions: 'deny', allowTools: [] };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      return { ok: false, error: `overcli mcp takes no file arguments (got "${arg}").` };
    }
    let name = arg;
    let inlineValue: string | undefined;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }
    if (!MCP_FLAGS.has(name)) {
      return {
        ok: false,
        error: FLAGS_WITH_VALUES.has(name) || name === '--json'
          ? `${name} is a "run" option; overcli mcp takes ${[...MCP_FLAGS].join(', ')}.`
          : `Unknown option "${name}".`,
      };
    }
    const value = inlineValue ?? rest[++i];
    if (value === undefined) return { ok: false, error: `${name} needs a value.` };

    switch (name) {
      case '--state-dir':
        opts.stateDir = value;
        break;
      case '--cwd':
        opts.cwd = value;
        break;
      case '--permissions': {
        const policy = parsePermissionPolicy(value);
        if (typeof policy !== 'string') return policy;
        opts.permissions = policy;
        break;
      }
      case '--allow-tool':
        pushAllowTools(opts.allowTools, value);
        break;
    }
  }

  return {
    ok: true,
    args: {
      command: 'mcp',
      mcp: opts,
      warnings: allowToolWarnings(opts.permissions, opts.allowTools),
    },
  };
}

const WORKERS_AUDIT_FLAGS = new Set(['--state-dir', '--json']);

function parseWorkersPush(rest: string[], what: 'workers' | 'teams' = 'workers'): { ok: true; args: ParsedArgs } | ParseFailure {
  let target: string | undefined;
  const opts: Partial<WorkersPushOptions> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      if (target) return { ok: false, error: `Unexpected argument "${arg}".` };
      target = arg;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? rest[++i] : arg.slice(eq + 1);
    if (value === undefined) return { ok: false, error: `${name} needs a value.` };
    if (name === '--to') opts.to = value;
    else if (name === '--token') opts.token = value;
    else if (name === '--state-dir') opts.stateDir = value;
    else if (name === '--visibility' && what === 'workers') {
      if (value !== 'private' && value !== 'team' && value !== 'org') return { ok: false, error: '--visibility is private, team or org.' };
      opts.visibility = value;
    } else return { ok: false, error: `Unknown option "${name}".` };
  }
  if (what === 'teams') {
    if (!target) return { ok: false, error: 'overcli teams push needs a team name.' };
    return { ok: true, args: { command: 'teamsPush', teamsPush: { ...opts, target }, warnings: [] } };
  }
  if (!target) return { ok: false, error: 'overcli workers push needs a worker name or a worker .yaml file.' };
  return { ok: true, args: { command: 'workersPush', workersPush: { ...opts, target }, warnings: [] } };
}

function parseTeams(rest: string[]): { ok: true; args: ParsedArgs } | ParseFailure {
  if (rest[0] === 'push') return parseWorkersPush(rest.slice(1), 'teams');
  return { ok: false, error: rest[0] ? `Unknown teams subcommand "${rest[0]}". Try: overcli teams push.` : 'overcli teams needs a subcommand. Try: overcli teams push.' };
}

function parseWorkers(rest: string[]): { ok: true; args: ParsedArgs } | ParseFailure {
  if (rest[0] === 'push') return parseWorkersPush(rest.slice(1));
  if (rest[0] !== 'audit') {
    return {
      ok: false,
      error: rest[0]
        ? `Unknown workers subcommand "${rest[0]}". Try: overcli workers audit.`
        : 'overcli workers needs a subcommand. Try: overcli workers audit.',
    };
  }
  const opts: WorkersAuditOptions = { json: false };
  const args = rest.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      return { ok: false, error: `overcli workers audit takes no arguments (got "${arg}").` };
    }
    let name = arg;
    let inlineValue: string | undefined;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }
    if (!WORKERS_AUDIT_FLAGS.has(name)) {
      return {
        ok: false,
        error: FLAGS_WITH_VALUES.has(name)
          ? `${name} is not an audit option; overcli workers audit takes ${[...WORKERS_AUDIT_FLAGS].join(', ')}.`
          : `Unknown option "${name}".`,
      };
    }
    if (name === '--json') {
      if (inlineValue !== undefined) return { ok: false, error: '--json takes no value.' };
      opts.json = true;
      continue;
    }
    const value = inlineValue ?? args[++i];
    if (value === undefined) return { ok: false, error: `${name} needs a value.` };
    opts.stateDir = value;
  }
  return { ok: true, args: { command: 'workers', workers: opts, warnings: [] } };
}

/// `7420`, `:7420` or `host:7420`. A bare port listens on loopback only: a
/// control plane open to the network is a choice someone types, not a default.
export function parseControlAddress(raw: string): { host: string; port: number } | { error: string } {
  const value = raw.trim();
  const at = value.lastIndexOf(':');
  const host = at > 0 ? value.slice(0, at).replace(/^\[|\]$/g, '') : '127.0.0.1';
  const port = Number(at >= 0 ? value.slice(at + 1) : value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: `--control wants a port or host:port, e.g. 7420 or 0.0.0.0:7420 (got "${raw}").` };
  }
  return { host, port };
}

const TOKENS_FLAGS = new Set(['--state-dir', '--name', '--slack', '--admin']);

function parseTokens(rest: string[]): { ok: true; args: ParsedArgs } | ParseFailure {
  const action = rest[0];
  if (action !== 'create' && action !== 'list' && action !== 'revoke') {
    return { ok: false, error: 'overcli tokens needs create, list or revoke.' };
  }
  const opts: TokensOptions = { action, admin: false };
  const args = rest.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      if (action === 'revoke' && !opts.target) {
        opts.target = arg;
        continue;
      }
      return { ok: false, error: `Unexpected argument "${arg}".` };
    }
    let name = arg;
    let inlineValue: string | undefined;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }
    if (!TOKENS_FLAGS.has(name)) return { ok: false, error: `Unknown option "${name}".` };
    if (name === '--admin') {
      opts.admin = true;
      continue;
    }
    const value = inlineValue ?? args[++i];
    if (value === undefined) return { ok: false, error: `${name} needs a value.` };
    if (name === '--state-dir') opts.stateDir = value;
    else if (name === '--name') opts.name = value;
    else opts.slackUserId = value;
  }
  if (action === 'create' && !opts.name?.trim()) return { ok: false, error: 'overcli tokens create needs --name.' };
  if (action === 'revoke' && !opts.target) return { ok: false, error: 'overcli tokens revoke needs a token id or name.' };
  if (opts.slackUserId && !/^[UW][A-Z0-9]{6,}$/.test(opts.slackUserId)) {
    return { ok: false, error: `--slack wants a Slack member id like U012AB3CD (got "${opts.slackUserId}").` };
  }
  return { ok: true, args: { command: 'tokens', tokens: opts, warnings: [] } };
}

function parseProjects(rest: string[]): { ok: true; args: ParsedArgs } | ParseFailure {
  const action = rest[0];
  if (action !== 'add' && action !== 'list') return { ok: false, error: 'overcli projects needs add or list.' };
  const opts: ProjectsOptions = { action };
  const args = rest.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      if (action === 'add' && !opts.path) {
        opts.path = arg;
        continue;
      }
      return { ok: false, error: `Unexpected argument "${arg}".` };
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name !== '--state-dir' && name !== '--name') return { ok: false, error: `Unknown option "${name}".` };
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined) return { ok: false, error: `${name} needs a value.` };
    if (name === '--state-dir') opts.stateDir = value;
    else opts.name = value;
  }
  if (action === 'add' && !opts.path) return { ok: false, error: 'overcli projects add needs a folder.' };
  return { ok: true, args: { command: 'projects', projects: opts, warnings: [] } };
}

const ORG_FLAGS = new Set(['--state-dir', '--name', '--admin', '--slack-team', '--timezone', '--url', '--force']);

function parseOrg(rest: string[]): { ok: true; args: ParsedArgs } | ParseFailure {
  const action = rest[0];
  if (action !== 'init' && action !== 'show') return { ok: false, error: 'overcli org needs init or show.' };
  const opts: OrgOptions = { action, admins: [], force: false };
  const args = rest.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!ORG_FLAGS.has(name)) return { ok: false, error: `Unknown option "${name}".` };
    if (name === '--force') {
      opts.force = true;
      continue;
    }
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined) return { ok: false, error: `${name} needs a value.` };
    if (name === '--state-dir') opts.stateDir = value;
    else if (name === '--name') opts.name = value.trim();
    else if (name === '--admin') {
      for (const id of value.split(',').map((x) => x.trim()).filter(Boolean)) {
        if (!/^[UW][A-Z0-9]{6,}$/.test(id)) return { ok: false, error: `--admin wants Slack member ids like U012AB3CD (got "${id}").` };
        opts.admins.push(id);
      }
    } else if (name === '--slack-team') {
      if (!/^[TE][A-Z0-9]{6,}$/.test(value)) return { ok: false, error: `--slack-team wants a workspace id like T012AB3CD (got "${value}").` };
      opts.slackTeamId = value;
    } else if (name === '--url') opts.publicUrl = value;
    else opts.timezone = value;
  }
  if (action === 'init' && !opts.name) return { ok: false, error: 'overcli org init needs --name.' };
  return { ok: true, args: { command: 'org', org: opts, warnings: [] } };
}

export function parseArgs(argv: string[]): { ok: true; args: ParsedArgs } | ParseFailure {
  const warnings: string[] = [];
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    return { ok: true, args: { command: 'help', warnings } };
  }
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    return { ok: true, args: { command: 'version', warnings } };
  }
  if (argv[0] === 'serve') return parseServe(argv.slice(1));
  if (argv[0] === 'mcp') return parseMcp(argv.slice(1));
  if (argv[0] === 'workers') return parseWorkers(argv.slice(1));
  if (argv[0] === 'teams') return parseTeams(argv.slice(1));
  if (argv[0] === 'tokens') return parseTokens(argv.slice(1));
  if (argv[0] === 'projects') return parseProjects(argv.slice(1));
  if (argv[0] === 'org') return parseOrg(argv.slice(1));
  if (argv[0] !== 'run') {
    return {
      ok: false,
      error: `Unknown command "${argv[0]}". Try: overcli run <file.yaml>, overcli serve, overcli mcp, or overcli workers audit.`,
    };
  }

  const rest = argv.slice(1);
  const positional: string[] = [];
  const opts: RunOptions = {
    file: '',
    permissions: 'deny',
    allowTools: [],
    json: false,
    modelOverrides: [],
    timeoutSeconds: 0,
    trust: 'probation',
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    // `--flag=value` and `--flag value` are both common in CI YAML; accept both
    // rather than making the pipeline author remember which we chose.
    let name = arg;
    let inlineValue: string | undefined;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }

    if (name === '--json') {
      opts.json = true;
      continue;
    }
    if (!FLAGS_WITH_VALUES.has(name)) {
      return { ok: false, error: `Unknown option "${name}".` };
    }
    const value = inlineValue ?? rest[++i];
    if (value === undefined) return { ok: false, error: `${name} needs a value.` };

    switch (name) {
      case '--cwd':
        opts.cwd = value;
        break;
      case '--input':
        opts.input = value;
        break;
      case '--permissions': {
        const policy = parsePermissionPolicy(value);
        if (typeof policy !== 'string') return policy;
        opts.permissions = policy;
        break;
      }
      case '--allow-tool':
        pushAllowTools(opts.allowTools, value);
        break;
      case '--state-dir':
        opts.stateDir = value;
        break;
      case '--artifacts-dir':
        opts.artifactsDir = value;
        break;
      case '--run-in': {
        if (value !== 'cwd' && value !== 'worktree') {
          return { ok: false, error: `--run-in must be cwd or worktree (got "${value}").` };
        }
        opts.runIn = value;
        break;
      }
      case '--model-override': {
        const split = value.indexOf('=');
        if (split <= 0) {
          return { ok: false, error: `--model-override wants from=to (got "${value}").` };
        }
        opts.modelOverrides.push({ from: value.slice(0, split), to: value.slice(split + 1) });
        break;
      }
      case '--branch-prefix':
        opts.branchPrefix = value;
        break;
      case '--trust': {
        if (!WORKER_TRUSTS.includes(value as WorkerTrust)) {
          return { ok: false, error: `--trust must be one of ${WORKER_TRUSTS.join(', ')} (got "${value}").` };
        }
        opts.trust = value as WorkerTrust;
        break;
      }
      case '--timeout': {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
          return { ok: false, error: `--timeout wants a number of seconds (got "${value}").` };
        }
        opts.timeoutSeconds = Math.floor(n);
        break;
      }
    }
  }

  if (positional.length === 0) return { ok: false, error: 'overcli run needs a YAML file.' };
  if (positional.length > 1) {
    return { ok: false, error: `overcli run takes one file (got ${positional.length}).` };
  }
  opts.file = positional[0];

  warnings.push(...allowToolWarnings(opts.permissions, opts.allowTools));

  return { ok: true, args: { command: 'run', run: opts, warnings } };
}

export const HELP = `overcli — run a flow or a worker without the desktop app

USAGE
  overcli run <file.yaml> [options]   One flow or worker, then exit.
  overcli serve [options]             Stay up and run your saved schedules
                                      and standing workers. No file: the
                                      work comes from --state-dir.
  overcli mcp [options]               Speak MCP over stdio so an MCP client
                                      (Claude Desktop, Claude Code) can list
                                      and run your saved flows.
  overcli tokens create --name N [--slack U…] [--admin]
  overcli tokens list | revoke <id|name>
                                      Who may call serve's control plane.
                                      A token is printed once; only its
                                      hash is stored.
  overcli org init --name N [--admin U…] [--slack-team T…] [--url URL] [--timezone Z]
  overcli org show                    Who this box's org is, and its rules,
                                      in <state dir>/org.json.
  overcli projects add <dir> [--name N] | list
                                      The folders workers on this box may
                                      work in — a cloned repo, or a plain
                                      folder for research and writing.
  overcli workers push <name|file.yaml> --to URL [--token T]
                                      Publish a worker you built to your
                                      org's server ($OVERCLI_ORG_URL and
                                      $OVERCLI_ORG_TOKEN work too).
  overcli teams push <name> --to URL [--token T]
                                      Publish a team you built, members
                                      and all; published again, it's
                                      updated there.
  overcli workers audit [options]     List standing-worker shifts that
                                      committed work never merged into
                                      its base branch. Read-only.

RUN OPTIONS
  --cwd DIR              Project to run in. Default: $GITHUB_WORKSPACE, then
                         $WORKSPACE, then the current directory.
  --input TEXT           The run's user_prompt. Optional for a worker.
  --permissions POLICY   deny (default) | allow-list | auto-approve. Same
                         flag, same meaning, under serve.
                         There is no human here, so every tool request gets an
                         answer: deny says no to all of them, allow-list says
                         yes only to --allow-tool names, auto-approve says yes.
                         This OVERRIDES the flow's own tools: list — a step
                         declaring tools: [Bash] still cannot run Bash under
                         deny. It is not a sandbox: an allowed tool runs with
                         this process's full privileges.
  --allow-tool NAME      Repeatable, comma-splittable. allow-list only.
  --state-dir DIR        Persistent state root. Without it a worker starts
                         every run with an empty journal.
  --artifacts-dir DIR    Copy the run's deliverables here when it finishes.
  --run-in MODE          cwd (default in CI) | worktree.
  --model-override A=B   e.g. ollama=claude:claude-sonnet-4-6. Applied before
                         preflight, so a flow pinned to a local model can run
                         on a hosted runner.
  --branch-prefix S      Prefix for branches a worktree run creates.
  --trust LEVEL          Worker files only. probation (default) | trusted |
                         autonomous. A worker bundle never carries its own
                         trust, so on probation every proposal is parked and
                         the job exits 2 without doing the work. Raise this
                         deliberately, in the committed job file.
  --timeout SECONDS      Abort the run after this long. Default: no limit.
  --json                 One JSON summary on stdout; progress on stderr.

SERVE OPTIONS
  --state-dir DIR        Which saved schedules and workers to run, and where
                         the daemon keeps their journals. Default:
                         $OVERCLI_HOME, then ~/.overcli. The desktop app keeps
                         its own state elsewhere (on macOS, ~/Library/
                         Application Support/Overcli) — pass that here to run
                         the app's schedules and workers.
  --permissions POLICY   deny (default) | allow-list | auto-approve. Means
                         exactly what it means for run, and matters more: a
                         daemon fires unattended work for as long as it is
                         up. deny is the safe default and keeps it that way.
  --allow-tool NAME      Repeatable, comma-splittable. allow-list only.
  --control ADDR         Serve the org control plane: MCP at /mcp and the web
                         console at /. A bare port (7420) listens on loopback;
                         0.0.0.0:7420 listens on every interface, e.g. in a
                         container. People sign in by invite link, Slack
                         (/overgo join) or the app; scripts use a token
                         from overcli tokens create. The first start prints
                         a one-time link for the first admin.

  Only one daemon may hold a --state-dir at a time; a second refuses rather
  than double-firing every schedule. Ctrl-C or SIGTERM shuts it down and
  exits 0; a second signal forces the exit.

MCP OPTIONS
  --state-dir DIR        Whose saved flows to offer. Default: $OVERCLI_HOME,
                         then ~/.overcli, like serve.
  --cwd DIR              Project a run_flow call works in when the call names
                         none. Default: $GITHUB_WORKSPACE, $WORKSPACE, then
                         the current directory.
  --permissions POLICY   deny (default) | allow-list | auto-approve. Same
                         meaning as for run: nobody is at the keyboard to
                         answer a tool request a started run makes.
  --allow-tool NAME      Repeatable, comma-splittable. allow-list only.

  Three tools: list_flows (id, name, description), run_flow (flowId, input,
  optional cwd; returns the run id at once, without waiting) and get_run
  (status, per-step outcome, diff summary). Nothing deletes or edits. stdout
  is the protocol; every log line goes to stderr. Close stdin to stop.
  Client config: {"command": "overcli", "args": ["mcp"]}

WORKERS AUDIT OPTIONS
  --state-dir DIR        Where the saved batches live. Default:
                         $OVERCLI_HOME, then the desktop app's data directory
                         (~/Library/Application Support/Overcli on macOS) if
                         it has batches, then ~/.overcli.
  --json                 One JSON object on stdout.

  Each unmerged commit is test-merged in memory (git merge-tree, git 2.38+;
  no ref moves): "clean" still merges, "conflicts" needs a rebuild. Work
  already in base by squash or cherry-pick is counted as absorbed, not
  stranded. Exits 2 when anything is stranded, 0 when clean, 4 when the
  state directory has no batches.

ENVIRONMENT
  OVERCLI_HOME           State root when --state-dir is absent.
                         Default: ~/.overcli
  OVERCLI_REGISTRY_TOKEN_<ID>
                         Bearer token for flow registry <ID>.

EXIT CODES
  0 the run finished and succeeded      3 preflight failed
  1 the run finished and failed         4 bad arguments or unreadable file
  2 the run needs a human (paused)      5 timed out

  serve uses 0 when a signal shut it down cleanly, 1 if it could not start
  (another daemon already holds the --state-dir), and 4 for bad arguments.
`;
