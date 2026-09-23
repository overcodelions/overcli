// Whether what a task left on disk still matches the checkout it came from.
//
// A task installs somewhere shared by the whole machine, whatever the
// ecosystem: the local Maven repository holds one copy of each artifact
// whichever branch built it, and so does an image tag, a linked npm package,
// an editable pip install, a GOPATH. So "it ran" is never the whole answer.
// The question a dependent service actually has is narrower: did it run from
// HERE, meaning the same branch and the same commit on it.
//
// Four ways that can be false, and they are not the same thing:
//
//   * its checkout is on another branch now. What is installed came from a
//     branch nobody is looking at any more.
//   * same branch, later commits. The usual one, and the invisible one: a
//     pull or a commit after the publish leaves every status reading green
//     while the jar is older than the source next to it.
//   * it ran somewhere else than the service that needs it — a task pinned to
//     master feeding a service on a feature branch. Legitimate when it is
//     meant, baffling when it is not.
//   * it has not run here at all, and something else installed whatever is
//     there — a terminal, an IDE, last month. Said rather than skipped,
//     because silence about a thing nobody checked reads exactly like a pass.
//     What a task DID install survives the app being closed, so this means
//     never, not "not since you reopened overcli" — see `TaskRun`.
//
// Nothing here acts on any of it. Re-running a publish is minutes of Gradle,
// and starting one because someone pulled would be a worse surprise than the
// stale jar. The rule is to SAY it, beside a button, and let whoever is
// looking decide — the same restraint task presets are offered under.
//
// A pure comparison over state the engine already records, so the log note
// and the pane agree instead of each deriving their own version of it.

import type { ServiceBinding, ServiceRuntime, ServiceSpec, TaskRun } from './services';

export type TaskDrift =
  /// Its checkout has since moved to a different branch.
  | { kind: 'branch'; ran: string; now: string }
  /// Same branch, but it has commits the task never saw.
  | { kind: 'commit'; ran: string; now: string }
  /// It ran on a different branch from the service that depends on it.
  | { kind: 'elsewhere'; ran: string; now: string }
  /// Nothing overcli ran installed what is there, so there is nothing to
  /// compare. Not a warning about the artifact — a statement about what is
  /// known about it.
  | { kind: 'unknown' };

/// A task measured against its OWN checkout, which can only be answered for a
/// task that finished — never `unknown`, because that is a statement about a
/// dependent's knowledge rather than about the task.
export type OwnDrift = Exclude<TaskDrift, { kind: 'unknown' }>;

/// What a finished task published, measured against its own checkout now.
///
/// Only a finished task has published anything, and only a recorded ref can
/// be compared: a task that ran before overcli recorded commits reports no
/// commit drift rather than a guess, because a warning that cannot be checked
/// is a warning people learn to click past.
export function taskDrift(
  runtime: Pick<ServiceRuntime, 'status' | 'ranRef' | 'ranCommit'> | undefined,
  binding: Pick<ServiceBinding, 'ref' | 'head'> | undefined,
): OwnDrift | null {
  if (!runtime || runtime.status !== 'done' || !runtime.ranRef) return null;
  if (binding?.ref && binding.ref !== runtime.ranRef) {
    return { kind: 'branch', ran: runtime.ranRef, now: binding.ref };
  }
  if (runtime.ranCommit && binding?.head && binding.head !== runtime.ranCommit) {
    return { kind: 'commit', ran: runtime.ranCommit, now: binding.head };
  }
  return null;
}

/// What a task last left on disk: the live runtime when it finished, else the
/// last run that SUCCEEDED, from the stack file. A re-run that fails, or one
/// still going, installs nothing and clears the runtime's refs — and reading
/// that as "has not run here" would disown the jar the earlier success left
/// behind, which is exactly what a dependent is about to build against.
export function lastSuccessfulRun(
  runtime: Pick<ServiceRuntime, 'status' | 'ranRef' | 'ranCommit'> | undefined,
  lastRun: TaskRun | undefined,
): Pick<ServiceRuntime, 'status' | 'ranRef' | 'ranCommit'> | undefined {
  if (runtime?.status === 'done' && runtime.ranRef) return runtime;
  if (lastRun?.ref) return { status: 'done', ranRef: lastRun.ref, ranCommit: lastRun.commit };
  return runtime;
}

export interface DriftedTask {
  task: ServiceSpec;
  drift: TaskDrift;
}

/// The tasks `spec` waits on whose output no longer matches where it came
/// from — what to say on the service that is about to build against them.
///
/// A task in another project is left alone: it has its own branches, and
/// nothing about this service's ref says anything about them.
export function driftedTasks(
  spec: ServiceSpec,
  services: readonly ServiceSpec[],
  runtimes: readonly ServiceRuntime[],
  bindings: readonly ServiceBinding[],
  /// The stack file's record of each task's last SUCCESSFUL run — see
  /// `lastSuccessfulRun`. Optional so a caller with no record still gets the
  /// runtime-only answer.
  lastRuns: Readonly<Record<string, TaskRun>> = {},
): DriftedTask[] {
  if (spec.task) return [];
  const ref = bindings.find((b) => b.serviceId === spec.id)?.ref;
  const out: DriftedTask[] = [];

  for (const depId of spec.deps ?? []) {
    const task = services.find((s) => s.id === depId);
    if (!task?.task) continue;
    const runtime = lastSuccessfulRun(
      runtimes.find((r) => r.serviceId === task.id),
      Object.prototype.hasOwnProperty.call(lastRuns, task.id) ? lastRuns[task.id] : undefined,
    );
    const drift = taskDrift(runtime, bindings.find((b) => b.serviceId === task.id));
    if (drift) {
      out.push({ task, drift });
      continue;
    }
    // No drift of its own: it published from the branch its checkout is still
    // on. That is only the right branch if it is also this service's.
    const ran = runtime?.status === 'done' ? runtime.ranRef : undefined;
    if (!ran) {
      out.push({ task, drift: { kind: 'unknown' } });
      continue;
    }
    if (!ref || ran === ref || task.projectId !== spec.projectId) continue;
    out.push({ task, drift: { kind: 'elsewhere', ran, now: ref } });
  }
  return out;
}

/// One sentence, for the log and for the pane.
export function describeDrift(name: string, drift: TaskDrift): string {
  if (drift.kind === 'branch') {
    return `${name} last ran from ${drift.ran}; its checkout is on ${drift.now} now`;
  }
  if (drift.kind === 'commit') {
    return `${name} last ran from ${shortCommit(drift.ran)}; ${shortCommit(drift.now)} is checked out now`;
  }
  if (drift.kind === 'unknown') {
    return `${name} has not run here, so what it installs came from somewhere else`;
  }
  return `${name} last ran from ${drift.ran}; this starts from ${drift.now}`;
}

export function shortCommit(sha: string): string {
  return sha.slice(0, 7);
}
