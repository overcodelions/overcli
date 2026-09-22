// The service model, shared by the engine in `main/services/` and the pane
// that renders it. Data only — every function that acts on these lives in
// `main/services/`, so the renderer cannot accidentally pull node into the
// bundle by reaching for a type.
//
// Three things are separate on purpose, because conflating them is what makes
// every existing local-dev runner awkward on a worktree-heavy machine:
//
//   IDENTITY  — `ServiceSpec`. What the service IS: its name, how it boots,
//               what "ready" means, what config it owns. Stable across every
//               worktree switch; this is what the pane lists and what logs
//               accumulate against.
//   BINDING   — `ServiceBinding`. WHICH checkout it currently points at. The
//               only thing that moves during a session, often several times
//               an hour and often for several services at once.
//   RUNNER    — `RunnerKind`, and the adapter that implements it. HOW it
//               boots in that checkout. Spring, npm, docker and Apache differ
//               only here; nothing above ever learns which is which.

/// How a service boots. `command` is the escape hatch: an unrecognised stack
/// still works, it just doesn't get detected for you.
export type RunnerKind =
  | 'spring-boot'
  | 'gradle'
  | 'npm'
  | 'ng-serve'
  | 'vite'
  | 'python'
  | 'go'
  | 'docker-compose'
  | 'command';

/// The standard protocol/tool an editor attaches with. Overcli only starts
/// the target in an attachable mode; the editor remains the debugger.
export type DebugKind = 'jdwp' | 'node-inspector' | 'debugpy' | 'delve';

/// What counts as "up". Started is not ready — a Spring service accepts a TCP
/// connection long before it can answer, and ordering a stack on "the process
/// exists" is how you get a dependent that starts against a half-open app.
export type ReadinessProbe =
  | { kind: 'http'; path: string; port: number; okStatuses?: number[] }
  | { kind: 'tcp'; port: number }
  /// Match a line of output. What dev servers give you — `ng serve` announces
  /// "Compiled successfully" and nothing else is observable.
  | { kind: 'log'; pattern: string }
  | { kind: 'command'; command: string[] }
  /// No probe: ready the moment it is spawned. Honest about knowing nothing,
  /// rather than pretending with a timer.
  | { kind: 'none' };

/// How long a service gets to pass its probe before the pane calls it slow.
/// Slow, not failed: it keeps being asked until it answers or exits.
export const DEFAULT_READY_TIMEOUT_SEC = 60;

/// How this service's local configuration reaches the process, in preference
/// order. A service may use more than one.
export interface ConfigProjection {
  /// Environment variables handed to the process at spawn. Preferred: nothing
  /// is written into the checkout, so the worktree cannot go dirty.
  inject?: Record<string, string>;
  /// Path relative to the checkout -> absolute source file, symlinked in for
  /// runtimes that insist on a fixed path. One file, shared by every worktree.
  link?: Record<string, string>;
  /// Path relative to the checkout -> absolute template, rendered per binding
  /// for files that genuinely must differ between checkouts.
  render?: Record<string, string>;
  /// Whether to bring the main checkout's gitignored local config into a bound
  /// worktree. On unless turned off: a worktree gets tracked files and nothing
  /// else, so a service running from one is missing the `application-local`
  /// file it has always been able to read.
  mirrorLocalConfig?: boolean;
  /// Extra globs to mirror when gitignored, beyond files that look like config
  /// — `run-*-local.sh`. A glob with no `/` matches the file name anywhere.
  mirrorInclude?: string[];
  /// Globs never to mirror, even when they look like config.
  mirrorExclude?: string[];
}

/// One startup option: `-Dprocessor.types=PROC`, `--reload`, `-Xmx4096m`.
/// Stored as key and value rather than one string so a copy can override the
/// value of a key the base already sets, which is the whole mechanism behind
/// five services sharing one module.
export interface ServiceOption {
  key: string;
  /// Omitted for a bare flag. `${NAME}` is filled from the machine values.
  value?: string;
  /// Off keeps the option in the list without passing it — for the flag you
  /// turn on twice a month and do not want to retype.
  enabled?: boolean;
}

/// A service identity. Owned by a workspace, not by a checkout.
export interface ServiceSpec {
  id: string;
  name: string;
  /// The overcli project this service comes from. A repo holding both an API
  /// and a web app contributes two specs with the same `projectId`.
  projectId?: string;
  /// Path relative to the project root, for a service inside a monorepo.
  subpath?: string;
  runner: RunnerKind;
  /// argv, not a shell string — no quoting rules to get wrong, and nothing
  /// the user typed is ever handed to a shell.
  command: string[];
  /// True once someone has set the command by hand. A re-import keeps it: the
  /// file said nothing better, which is why they typed it.
  commandEdited?: boolean;
  /// Where an imported service was described — the file kind, the project it
  /// is in, and the text that defines it. Kept so Ask AI can see what the
  /// user's own setup runs, not just what detection guessed.
  importedFrom?: { source: string; project: string; excerpt?: string };
  /// The port the service is configured to bind; undefined for a worker that
  /// serves nothing.
  port?: number;
  ready: ReadinessProbe;
  /// Seconds to wait for `ready` before calling it slow. Unset means
  /// `DEFAULT_READY_TIMEOUT_SEC`. A cold Gradle build of a Spring app can take
  /// minutes, and one number for every service was wrong for exactly those.
  readyTimeoutSec?: number;
  /// True when the runner watches its own files and patches a running process
  /// better than we could from outside (`ng serve`, vite, nodemon, Spring
  /// devtools). For these the correct response to a change is to do NOTHING.
  selfReloads: boolean;
  /// Globs, relative to the checkout, that trigger a restart. Only consulted
  /// when `selfReloads` is false.
  watch?: string[];
  /// Services that must be READY before this one starts. Startup ordering
  /// only — deliberately NOT a restart-propagation graph.
  deps?: string[];
  /// Runs to completion rather than staying up: a publish to Maven local, a
  /// shared library's build, a migration. Exit 0 is `done`, and a dependent
  /// waits for that instead of a probe. Done counts only for the ref it ran
  /// from — a task that ran on master has not published your branch.
  task?: boolean;
  /// Whether restarting this also restarts its dependents. Defaults false and
  /// should stay false almost always: an HTTP client reconnects, that is what
  /// it is for. Set it only where a real build artifact is shared.
  restartDependents?: boolean;
  config: ConfigProjection;
  /// A pinned service never moves in a bulk rebind. This is how "pin the
  /// backends, float the frontend" is expressed.
  pinnedRef?: string;

  /// What kind of thing this is — "REST services", "Processors", "Front ends".
  /// Free text, guessed on detection, and the only grouping the list uses.
  group?: string;

  /// The service this is a copy of. A copy shares the base's checkout and
  /// options and states only its own differences; an option it restates wins.
  /// This is how one Gradle module becomes five processors that can all run at
  /// once.
  copyOf?: string;

  /// This service's own startup options. On a base, these are the shared set
  /// every copy inherits.
  options?: ServiceOption[];

  /// How options reach the process. Getting this wrong is silent: Gradle's
  /// bootRun ignores JVM flags passed as plain arguments, so they have to ride
  /// inside `-PjvmArgs="…"`. Defaults by runner.
  optionStyle?: 'argv' | 'gradle-jvm-args';

  /// How this runner becomes attachable. Absent for runners Overcli does not
  /// know how to debug without inventing project-specific behaviour.
  debugKind?: DebugKind;
  /// Preferred debugger port. The runtime carries the actual port after a
  /// stack offset has been applied.
  debugPort?: number;
  /// Whether launches carry the debug agent. Changing this restarts a live
  /// service immediately; a stopped service uses it on its next start.
  debugEnabled?: boolean;
}

/// Where a service currently points. `ref` is carried alongside `path`
/// because paths are not stable here: flows commit into the main checkout and
/// delete the scratch worktree mid-session, so a binding that knows only a
/// path becomes an ENOENT with nothing useful to say.
export interface ServiceBinding {
  serviceId: string;
  ref: string;
  /// Absolute path to the checkout. Always a real path — never a workspace
  /// symlink root, which exists for the agent's cwd and breaks module
  /// resolution and git rooting when a process is launched under it.
  path: string;
  /// Set when this binding runs on an offset port because another stack holds
  /// the service's usual one.
  portOffset?: number;
  /// The commit the checkout is on right now, filled in when a stack is read
  /// and never saved: a sha written to disk on every pull would rewrite the
  /// stack file for a fact that is only true until the next one. What it is
  /// for is `taskDrift` — a task that published from an earlier commit of the
  /// branch it is still on is otherwise indistinguishable from a fresh one.
  head?: string;
}

/// A workspace's services and where they currently point — the whole
/// persisted document.
/// What a task last put on this machine, by service id.
///
/// Runtime state lives in memory and dies with the app. What a task INSTALLED
/// does not: the jar in the local Maven repository, the image tag, the linked
/// package are all still there tomorrow. Forgetting which commit they came
/// from is forgetting the only fact that can answer "is what I am building
/// against current" — and the answer after every restart would be silence,
/// which reads exactly like "yes".
export interface TaskRun {
  ref: string;
  commit?: string;
  at: number;
}

export interface StackConfig {
  workspaceId: string;
  services: ServiceSpec[];
  bindings: ServiceBinding[];
  /// Keyed by service id, and only for tasks.
  lastRuns?: Record<string, TaskRun>;
}

export type ServiceStatus =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'failed'
  /// Spawned, probe never passed within its budget. Distinct from `failed`
  /// (the process exited): the thing is running and not answering, which has
  /// completely different causes and remedies.
  | 'unready'
  /// A task that exited 0. Not live — there is no process — but not stopped
  /// either: what it produced is still there for its dependents.
  | 'done';

/// Live state for one service. Not persisted — this is what the pane renders.
export interface ServiceRuntime {
  serviceId: string;
  status: ServiceStatus;
  pid?: number;
  /// The port actually in use, after any offset.
  port?: number;
  /// The attach endpoint actually used by this process.
  debugKind?: DebugKind;
  debugPort?: number;
  startedAt?: number;
  readyAt?: number;
  /// Running from before the app was reopened, taken back rather than started
  /// here — see `Supervisor.adopt`. Everything works except the output: its
  /// stdout went to a process that no longer exists, so the log is whatever is
  /// already on disk until a restart puts it back on a pipe we hold.
  adopted?: boolean;
  exitCode?: number | null;
  lastError?: string;
  /// While `starting`: the name of what it is waiting on before it launches.
  waitingOn?: string;
  /// For a task: the ref it last finished on, and when. Where a task installs
  /// to — the local Maven repository, an image tag, a linked package, a
  /// GOPATH — is shared by every checkout on the machine, so which branch it
  /// came from is the one thing worth knowing about it.
  ranRef?: string;
  /// And the commit that ref was on when it ran, so a publish followed by a
  /// pull on the same branch is still visibly older than the checkout.
  ranCommit?: string;
  finishedAt?: number;
}

/// A port held by something, and by whom — for the sentence shown when two
/// stacks want the same service.
export interface PortClaim {
  port: number;
  serviceId: string;
  stackId: string;
  holder?: string;
  /// What the holder is to us, which decides whether stopping it is offered.
  holderKind?: PortHolderKind;
  since?: number;
}

/// Who a port holder outside overcli's own claims turns out to be: overcli
/// itself (never offered for stopping), a leftover copy of this service whose
/// launcher exited, or anything else.
export type PortHolderKind = 'self' | 'stale' | 'other';

/// What starting a service right now would run into.
export type LeaseDecision =
  | { kind: 'free'; port: number; offset: 0 }
  /// This stack already has it up; restarting is the only sensible reading of
  /// "start" here.
  | { kind: 'already-running'; claim: PortClaim }
  /// Another stack holds it. Three exits, and the user picks.
  | { kind: 'held'; claim: PortClaim; alongside: { port: number; offset: number } | null };

/// One thing detection concluded, and the file that says so. Rendered next to
/// the field in the pane: "port 8084 — application.yml:2".
export interface Evidence {
  field: 'runner' | 'command' | 'port' | 'ready' | 'selfReloads' | 'config' | 'profile';
  why: string;
  source?: string;
}

export interface ServiceProposal {
  spec: Omit<ServiceSpec, 'id'>;
  evidence: Evidence[];
  /// How much came from the repo rather than from a default. `low` means we
  /// recognised the ecosystem but guessed the specifics — worth a look before
  /// accepting.
  confidence: 'high' | 'medium' | 'low';
}

/// A one-off task worth offering for a checkout, from what its build files
/// say it can do: publish to Maven local, build the Docker image.
export interface TaskPreset {
  id: string;
  /// What the choice reads as: "Publish to Maven local".
  label: string;
  /// What the task would be called in the list.
  name: string;
  command: string[];
  /// Where it runs, relative to the checkout, when that is not the root.
  subpath?: string;
  /// The file that made it worth offering.
  why: string;
}

/// One explanation for a failed start, with what justified it. Produced by
/// deterministic rules over the output, the spec and the repo — never a guess.
export interface ServiceFinding {
  id: string;
  title: string;
  detail: string;
  evidence: string[];
  action?: 'mirror-config' | 'import-options' | 'free-port' | 'edit-options';
  /// The port a `free-port` action is about — the one the output named, which
  /// is not always the one the service is saved with.
  port?: number;
}

/// Values that differ per developer rather than per service — database user,
/// an SQS prefix, a path. Referred to as `${NAME}` from any option or injected
/// variable, and shared by every service on the machine, because retyping a
/// database password into forty services is how forty services end up with
/// thirty-nine different passwords.
export type MachineValues = Record<string, string>;

/// One machine value as the pane sees it. A secret's `value` never crosses to
/// the renderer: it comes back absent with `stored: true`, and a save that
/// leaves it absent keeps what the keychain already holds.
export interface MachineEntry {
  name: string;
  secret: boolean;
  value?: string;
  /// A secret that already has a value in the keychain.
  stored?: boolean;
}

/// A `${NAME}` some service refers to that has no value on this machine.
export interface MachineValueNeed {
  name: string;
  /// Service names, for "needed by billing-rest, acme-rest".
  services: string[];
}

export interface MachineValuesView {
  entries: MachineEntry[];
  /// False when this machine has no keychain to encrypt secrets with. The
  /// pane then refuses to mark anything secret rather than pretending.
  secureStorage: boolean;
  migrationError?: string;
  backupPath?: string;
}

/// What the pane renders: the stack plus everything live about it.
export interface StackView {
  workspaceId: string;
  services: ServiceSpec[];
  bindings: ServiceBinding[];
  runtimes: ServiceRuntime[];
}

/// What a removal took out of a stack, held so it can be put back. The index
/// is each service's place in the list, so an undo restores the order too.
export interface RemovedServices {
  services: { spec: ServiceSpec; index: number }[];
  bindings: ServiceBinding[];
}
