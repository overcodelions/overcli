// Work a worker on the server hands to its manager's desktop: what the
// server can't do itself, because it needs the person's own browser and its
// sign-ins (Claude in Chrome), design tools, or files on their machine.
//
// A worker asks through the server's built-in tool (`ask_desktop`, beside
// `notify`), only when its manager has allowed it. The task waits for that
// manager's overcli, which shows it to them: they Allow it (it opens as a
// local chat) or Decline. What they send back goes to the worker in the same
// thread, as a reply, so it carries on from there. Nothing runs on anyone's
// desktop without them saying so.

export type DesktopTaskKind = 'browser' | 'design' | 'other';

export interface DesktopTask {
  id: string;
  workerId: string;
  workerName: string;
  /// The run that asked, and the thread its result goes back to.
  runId?: string;
  thread?: string;
  /// Whose desktop: the worker's manager.
  forSlackUserId: string;
  forName: string;
  task: string;
  kind: DesktopTaskKind;
  at: number;
  status: 'waiting' | 'claimed' | 'done' | 'declined' | 'expired';
  claimedAt?: number;
  doneAt?: number;
  /// What the person sent back, or why they declined.
  result?: string;
  why?: string;
}

export interface DesktopTaskStore {
  load(): { tasks: DesktopTask[] };
  save(value: { tasks: DesktopTask[] }): void;
}

/// Waiting this long with nobody picking it up, it lapses.
export const DESKTOP_TASK_TTL_MS = 24 * 60 * 60_000;
/// A worker may have this many waiting at once.
export const MAX_OPEN_DESKTOP_TASKS = 5;
export const MAX_DESKTOP_TASK_CHARS = 4000;
export const MAX_DESKTOP_RESULT_CHARS = 20_000;
/// Finished ones are kept this long, then dropped.
const KEEP_MS = 14 * 24 * 60 * 60_000;

/// Lapse what nobody picked up, and drop what's long finished.
export function tidyDesktopTasks(tasks: DesktopTask[], now: number): DesktopTask[] {
  return tasks
    .map((t) => (t.status === 'waiting' && now - t.at > DESKTOP_TASK_TTL_MS ? { ...t, status: 'expired' as const, doneAt: now } : t))
    .filter((t) => !(t.doneAt && now - t.doneAt > KEEP_MS));
}
