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

export interface ParsedArgs {
  command: 'run' | 'help' | 'version';
  run?: RunOptions;
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

export function parseArgs(argv: string[]): { ok: true; args: ParsedArgs } | ParseFailure {
  const warnings: string[] = [];
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    return { ok: true, args: { command: 'help', warnings } };
  }
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    return { ok: true, args: { command: 'version', warnings } };
  }
  if (argv[0] !== 'run') {
    return { ok: false, error: `Unknown command "${argv[0]}". Try: overcli run <file.yaml>` };
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
        if (!PERMISSION_POLICIES.includes(value as PermissionPolicy)) {
          return {
            ok: false,
            error: `--permissions must be one of ${PERMISSION_POLICIES.join(', ')} (got "${value}").`,
          };
        }
        opts.permissions = value as PermissionPolicy;
        break;
      }
      case '--allow-tool':
        // Repeatable, and also comma-splittable so one CI variable can carry
        // the whole list.
        opts.allowTools.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
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

  if (opts.allowTools.length > 0 && opts.permissions !== 'allow-list') {
    warnings.push(
      `--allow-tool only applies under --permissions allow-list; ignoring ${opts.allowTools.length} of them.`,
    );
  }
  if (opts.permissions === 'allow-list' && opts.allowTools.length === 0) {
    warnings.push(
      '--permissions allow-list with no --allow-tool denies everything, same as --permissions deny.',
    );
  }

  return { ok: true, args: { command: 'run', run: opts, warnings } };
}

export const HELP = `overcli — run a flow or a worker without the desktop app

USAGE
  overcli run <file.yaml> [options]

OPTIONS
  --cwd DIR              Project to run in. Default: $GITHUB_WORKSPACE, then
                         $WORKSPACE, then the current directory.
  --input TEXT           The run's user_prompt. Optional for a worker.
  --permissions POLICY   deny (default) | allow-list | auto-approve.
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

ENVIRONMENT
  OVERCLI_HOME           State root when --state-dir is absent.
                         Default: ~/.overcli
  OVERCLI_REGISTRY_TOKEN_<ID>
                         Bearer token for flow registry <ID>.

EXIT CODES
  0 the run finished and succeeded      3 preflight failed
  1 the run finished and failed         4 bad arguments or unreadable file
  2 the run needs a human (paused)      5 timed out
`;
