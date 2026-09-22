// Live service state for the pane, in its own store.
//
// Separate from the main projects/workspaces store for the same reason
// `runnersStore` is: output streams in continuously and statuses flip on
// every start and rebind, and folding that into the store that also holds
// settings and sheet flags means every unrelated component re-evaluates its
// selectors on every log line.
//
// It is also a third kind of state, distinct from both existing stores.
// `runnersStore` is per-CONVERSATION and ephemeral; the main store is
// persisted configuration. Services are long-lived RUNTIME: they outlive the
// conversation that started them, are shared by every conversation in the
// workspace, and die with the app. Nothing else in the renderer is shaped
// like that, which is why it gets its own store rather than a corner of one.

import { create } from 'zustand';
import type { WorktreeChoice } from '@shared/worktrees';
import { emptyExceptionLog, feedException, type ExceptionLog } from '@shared/exceptions';
import { planBulkRebind, planPinRebind } from './servicesRebindPlan';
import { runWithConcurrency, startLayers } from './servicesStartPlan';
import { watchForMode, type ReloadMode } from './serviceReloadMode';
import { buildProbe, portFor, type BulkEdits } from './servicesBulkEdit';
import type {
  LeaseDecision,
  MachineEntry,
  MachineValueNeed,
  ReadinessProbe,
  RemovedServices,
  ServiceFinding,
  ServiceOption,
  ServiceRuntime,
  StackView,
} from '@shared/services';

/// One option as it will actually be passed, and where it came from.
export interface ResolvedOption {
  key: string;
  value?: string;
  origin: 'shared' | 'own';
  overrides?: boolean;
}

/// Lines kept per service in the renderer. The main process keeps more; this
/// is what the pane can usefully scroll; everything is also on disk.
const LOG_LIMIT = 10_000;

/// Lines waiting to reach the store. Fifteen running services write hundreds of
/// lines a second between them, and one store update per line meant the log on
/// screen was re-filtered and re-rendered hundreds of times a second. Collected
/// here and applied together, a few times a second — still reads as live.
const FLUSH_MS = 100;
const pendingLines = new Map<string, string[]>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

interface ServicesState {
  /// Keyed by workspace id. A workspace nobody has opened is simply absent —
  /// loading one must not create anything.
  stacks: Record<string, StackView>;
  logs: Record<string, string[]>;
  /// Exceptions pulled out of each log, keyed like the logs. They outlive the
  /// lines they came from: a burst of traces is what pushes the cause out.
  exceptions: Record<string, ExceptionLog>;
  /// Which service the log pane is showing, per workspace.
  selected: Record<string, string | undefined>;
  /// The service whose output is open in the side drawer, when one is. Its
  /// own pick, deliberately not `selected`: the drawer is read from a chat,
  /// and opening it must not move what the Services pane is showing.
  logDrawer?: { workspaceId: string; serviceId: string };
  /// A clash waiting on the user: another stack holds the port. Parked here
  /// rather than resolved, because taking a port from a flow nobody was
  /// watching is not a decision the app gets to make.
  pendingLease: Record<string, { serviceId: string; lease: LeaseDecision } | undefined>;
  /// Values shared by every service on this machine, filled into `${NAME}`.
  /// Secrets arrive without their values.
  machine: MachineEntry[];
  /// Whether secrets can be encrypted here at all.
  secureStorage: boolean;
  migrationError?: string;
  backupPath?: string;
  /// The Machine values sheet, when open. `needs` are values services refer
  /// to that are not set yet — present when the sheet was opened to fill them
  /// in, after adding services or from a "missing machine values" failure.
  machineSheet?: { needs: MachineValueNeed[] };
  openMachineSheet(needs?: MachineValueNeed[]): void;
  closeMachineSheet(): void;
  /// Open the sheet for whatever these stacks still need. False when nothing
  /// is missing, so a caller can carry on.
  promptMachineNeeds(workspaceIds: string[]): Promise<boolean>;
  /// The service the user just pressed start on. A failure that arrives for
  /// THIS one takes them to its output; a background service dying while they
  /// read something else does not steal the pane.
  awaiting?: { workspaceId: string; serviceId: string };
  /// Bumped whenever a start the user was waiting on fails, so the detail pane
  /// can land on Output without guessing.
  failedAt?: number;
  /// Why the last failure happened, keyed like the logs. Fetched when a
  /// service fails rather than on every render: the rules read the repo.
  findings: Record<string, ServiceFinding[]>;
  /// What a model made of a failure the rules could not explain, keyed like
  /// the logs. Never fetched on its own: the user asks for it, because it
  /// costs a subprocess and a model call and its answer is a guess.
  suggestions: Record<string, { status: 'asking' } | { status: 'answered'; backend: string; text: string; command?: string } | { status: 'failed'; error: string }>;
  /// What each service will actually start with, keyed like the logs. Fetched
  /// on selection, because it depends on the base's options and the machine
  /// values as much as on the service itself.
  resolved: Record<string, ResolvedOption[]>;
  /// Rows ticked for a bulk action, keyed like the logs. Separate from
  /// `selected`, which is the one service the detail pane shows: ticking five
  /// rows is not asking to read five logs.
  checked: Record<string, true>;
  /// Where a shift-click range starts: the last row clicked or ticked.
  anchor?: string;
  /// Group and module headers folded shut, by their list key. For the session.
  collapsed: Record<string, boolean>;
  /// The last removal, held for its undo.
  removed?: {
    entries: { workspaceId: string; removed: RemovedServices }[];
    count: number;
    /// Names of what was running and got stopped on the way out.
    stopped: string[];
  };

  load(workspaceId: string): Promise<void>;
  /// Every workspace's services at once. What the pane actually opens with —
  /// a stack running in another workspace is still holding ports, and making
  /// the user go and find it is how two copies of one service happen.
  loadAll(workspaceIds: string[]): Promise<void>;
  select(workspaceId: string, serviceId: string): Promise<void>;
  /// Show a service's output in the side drawer, from wherever the user is.
  /// Lines stream into the store for every service regardless of selection
  /// (see `ingestLine`), so this only has to fetch the snapshot behind them.
  openLogDrawer(workspaceId: string, serviceId: string): Promise<void>;
  closeLogDrawer(): void;
  start(workspaceId: string, serviceId: string, offset?: number, ignoreHeld?: boolean): Promise<void>;
  stop(workspaceId: string, serviceId: string): Promise<void>;
  restart(workspaceId: string, serviceId: string): Promise<void>;
  rebind(workspaceId: string, serviceId: string, ref: string, path: string): Promise<void>;
  rebindAll(
    workspaceId: string,
    targets: { serviceId: string; ref: string; path: string }[],
  ): Promise<string[]>;
  setPinned(workspaceId: string, serviceId: string, pinnedRef?: string): Promise<void>;
  setChecked(keys: string[], on: boolean): void;
  clearChecked(): void;
  setAnchor(key: string | undefined): void;
  toggleCollapsed(key: string): void;
  /// Start independent rows concurrently, in dependency-ordered layers.
  /// Unlike `start`, this does not select each in turn.
  startMany(keys: string[]): Promise<void>;
  stopMany(keys: string[]): Promise<void>;
  /// Gone from the list at once, stopped if running, and undoable.
  removeMany(keys: string[]): Promise<void>;
  undoRemove(): Promise<void>;
  dismissRemoved(): void;
  /// Worktree choices per service id, as the pane last fetched them — one
  /// answer every switch control reads, whether on a workspace, a group or a
  /// selection.
  choices: Record<string, WorktreeChoice[]>;
  setChoices(choices: Record<string, WorktreeChoice[]>): void;
  /// Move rows by key onto a branch, each in its own repository. Services whose
  /// repo has no such branch, or that are pinned, stay put and are counted.
  switchKeys(keys: string[], ref: string, pin?: boolean): Promise<void>;
  /// What the last switch did, in a line.
  notice?: { text: string; sub?: string };
  dismissNotice(): void;
  setGroup(workspaceId: string, serviceId: string, group?: string): Promise<void>;
  setOptions(workspaceId: string, serviceId: string, options: ServiceOption[]): Promise<void>;
  setCommand(workspaceId: string, serviceId: string, command: string[]): Promise<void>;
  setWatch(workspaceId: string, serviceId: string, selfReloads: boolean, watch: string[]): Promise<void>;
  /// The same choice across ticked rows. Each service keeps its own globs —
  /// see `watchForMode` — so this sets what they do, not what they watch.
  setWatchMany(keys: string[], mode: ReloadMode): Promise<void>;
  /// Write every field the bulk sheet set, across the ticked rows, in one go.
  /// Fields left unset are not written — see `planBulkEdit`.
  applyBulkEdit(keys: string[], edits: BulkEdits): Promise<void>;
  setDebug(workspaceId: string, serviceId: string, enabled: boolean): Promise<void>;
  setReady(
    workspaceId: string,
    serviceId: string,
    ready: ReadinessProbe,
    readyTimeoutSec?: number,
  ): Promise<void>;
  setTask(workspaceId: string, serviceId: string, task: boolean): Promise<void>;
  setDeps(workspaceId: string, serviceId: string, deps: string[]): Promise<void>;
  addTask(
    workspaceId: string,
    serviceId: string,
    args: { name: string; command: string[]; subpath?: string; runBefore: boolean },
  ): Promise<string | null>;
  duplicate(
    workspaceId: string,
    serviceId: string,
    args: { name: string; group?: string; options?: ServiceOption[] },
  ): Promise<string | null>;
  loadMachine(): Promise<void>;
  saveMachine(entries: MachineEntry[]): Promise<void>;
  revealConfig(workspaceId: string, serviceId: string): Promise<void>;
  revealLogFile(workspaceId: string, serviceId: string): Promise<void>;
  /// Where the full output is on disk — every line, not just what the pane keeps.
  logFile(workspaceId: string, serviceId: string): Promise<string>;
  explain(workspaceId: string, serviceId: string): Promise<void>;
  /// `'explain'` explains `command`, the editor's text, and keeps its answer
  /// under `explainKey` so it never replaces a fix shown on the output.
  askAi(workspaceId: string, serviceId: string, kind?: 'fix' | 'command' | 'explain', command?: string): Promise<void>;
  cancelAskAi(workspaceId: string, serviceId: string, kind?: 'fix' | 'command' | 'explain'): Promise<void>;
  checkoutRef(
    workspaceId: string,
    serviceId: string,
    ref: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /// Stop whatever holds a port, then start the service that wanted it.
  freePortAndStart(workspaceId: string, serviceId: string, port: number): Promise<void>;
  dismissLease(workspaceId: string): void;
  /// Ask the port again while a banner says it is taken by something outside
  /// overcli: clear the banner once it is free, and name the holder once it
  /// can be named.
  recheckLease(workspaceId: string): Promise<void>;

  ingestStatus(workspaceId: string, runtime: ServiceRuntime): void;
  ingestLines(workspaceId: string, serviceId: string, lines: string[]): void;
  deleteMachineBackup(): Promise<void>;
  /// A service was pointed at another checkout. The ref shows at once; the
  /// path follows from a reload, since the event does not carry it.
  ingestRebound(workspaceId: string, serviceId: string, to: string): void;
  /// Empties a service's output here and in the engine, so reselecting it
  /// does not bring the old lines back.
  clearLog(workspaceId: string, serviceId: string): Promise<void>;
}

/// One key per service's log, so a workspace's services never collide.
export function logKey(workspaceId: string, serviceId: string): string {
  return `${workspaceId}/${serviceId}`;
}

/// Where an explanation of a service's command is kept among the suggestions.
export function explainKey(workspaceId: string, serviceId: string): string {
  return `${logKey(workspaceId, serviceId)}#explain`;
}

function suggestionKey(workspaceId: string, serviceId: string, kind?: string): string {
  return kind === 'explain' ? explainKey(workspaceId, serviceId) : logKey(workspaceId, serviceId);
}

export const useServicesStore = create<ServicesState>((set, get) => ({
  stacks: {},
  logs: {},
  exceptions: {},
  selected: {},
  logDrawer: undefined,
  pendingLease: {},
  machine: [],
  secureStorage: false,
  migrationError: undefined,
  backupPath: undefined,
  machineSheet: undefined,

  openMachineSheet(needs = []) {
    set({ machineSheet: { needs } });
  },

  closeMachineSheet() {
    set({ machineSheet: undefined });
  },

  async promptMachineNeeds(workspaceIds) {
    const needs = await window.overcli.invoke('services:machineValueNeeds', workspaceIds);
    if (needs.length === 0) return false;
    await get().loadMachine();
    set({ machineSheet: { needs } });
    return true;
  },
  resolved: {},
  checked: {},
  anchor: undefined,
  collapsed: {},
  removed: undefined,
  choices: {},
  notice: undefined,
  awaiting: undefined,
  failedAt: undefined,
  findings: {},
  suggestions: {},

  async load(workspaceId) {
    const view = await window.overcli.invoke('services:view', workspaceId);
    set((s) => ({ stacks: { ...s.stacks, [workspaceId]: view } }));
    // Land on something rather than an empty pane.
    if (!get().selected[workspaceId] && view.services[0]) {
      await get().select(workspaceId, view.services[0].id);
    }
  },

  async loadAll(workspaceIds) {
    const views = await window.overcli.invoke('services:viewAll', workspaceIds);
    set((s) => ({
      stacks: { ...s.stacks, ...Object.fromEntries(views.map((v) => [v.workspaceId, v])) },
    }));
  },

  async select(workspaceId, serviceId) {
    // One selection across every workspace: picking in one group replaces the
    // pick in another, because there is one detail pane.
    set((s) => ({ selected: { ...blank(s.selected), [workspaceId]: serviceId } }));
    const [lines, resolved, caught] = await Promise.all([
      window.overcli.invoke('services:log', { workspaceId, serviceId }),
      window.overcli.invoke('services:resolvedOptions', { workspaceId, serviceId }),
      window.overcli.invoke('services:exceptions', { workspaceId, serviceId }),
    ]);
    // Anything queued is already in the snapshot; applying it too would print it twice.
    pendingLines.delete(logKey(workspaceId, serviceId));
    set((s) => ({
      logs: { ...s.logs, [logKey(workspaceId, serviceId)]: lines },
      exceptions: { ...s.exceptions, [logKey(workspaceId, serviceId)]: { items: caught, recent: [] } },
      resolved: { ...s.resolved, [logKey(workspaceId, serviceId)]: resolved },
    }));
  },

  async openLogDrawer(workspaceId, serviceId) {
    // Open first, fetch second: the snapshot is an IPC round trip and the
    // drawer sliding in is the answer to the click.
    set({ logDrawer: { workspaceId, serviceId } });
    // Opened from a chat, this workspace's stack may never have been loaded —
    // without it the drawer has no name, branch or status to show.
    if (!get().stacks[workspaceId]) void get().loadAll([workspaceId]);
    const key = logKey(workspaceId, serviceId);
    const [lines, caught] = await Promise.all([
      window.overcli.invoke('services:log', { workspaceId, serviceId }),
      window.overcli.invoke('services:exceptions', { workspaceId, serviceId }),
    ]);
    // Anything queued is already in the snapshot; applying it too would print it twice.
    pendingLines.delete(key);
    set((s) => ({
      logs: { ...s.logs, [key]: lines },
      exceptions: { ...s.exceptions, [key]: { items: caught, recent: [] } },
    }));
  },

  closeLogDrawer() {
    set({ logDrawer: undefined });
  },

  async setGroup(workspaceId, serviceId, group) {
    await window.overcli.invoke('services:setGroup', { workspaceId, serviceId, group });
    await get().load(workspaceId);
  },

  async setOptions(workspaceId, serviceId, options) {
    await window.overcli.invoke('services:setOptions', { workspaceId, serviceId, options });
    await get().load(workspaceId);
    await get().select(workspaceId, serviceId);
  },

  async setCommand(workspaceId, serviceId, command) {
    await window.overcli.invoke('services:setCommand', { workspaceId, serviceId, command });
    await get().load(workspaceId);
  },

  async setWatch(workspaceId, serviceId, selfReloads, watch) {
    await window.overcli.invoke('services:setWatch', { workspaceId, serviceId, selfReloads, watch });
    await get().load(workspaceId);
  },

  async setWatchMany(keys, mode) {
    const { stacks } = get();
    await Promise.all(
      keys.map((key) => {
        const { workspaceId, serviceId } = splitKey(key);
        const spec = stacks[workspaceId]?.services.find((s) => s.id === serviceId);
        const { selfReloads, watch } = watchForMode(spec ?? {}, mode);
        return window.overcli.invoke('services:setWatch', { workspaceId, serviceId, selfReloads, watch });
      }),
    );
    // One reload per workspace rather than one per service: fifteen rows in
    // one stack is one answer, not fifteen.
    await get().loadAll([...new Set(keys.map((key) => splitKey(key).workspaceId))]);
  },

  async applyBulkEdit(keys, edits) {
    const { stacks } = get();
    const specOf = (key: string) => {
      const { workspaceId, serviceId } = splitKey(key);
      return stacks[workspaceId]?.services.find((s) => s.id === serviceId);
    };

    // Config first, the branch last. A rebind relaunches whatever was
    // running, so the options it comes back up with should already be the
    // new ones rather than the ones it is about to be told to forget.
    if (edits.group !== undefined) {
      await Promise.all(
        keys.map((key) => {
          const { workspaceId, serviceId } = splitKey(key);
          if ((specOf(key)?.group ?? '') === edits.group) return undefined;
          return window.overcli.invoke('services:setGroup', {
            workspaceId,
            serviceId,
            group: edits.group || undefined,
          });
        }),
      );
    }

    if (edits.ready !== undefined) {
      const shape = edits.ready;
      await Promise.all(
        keys.map((key) => {
          const spec = specOf(key);
          if (!spec) return undefined;
          // A service with no port cannot take an http or tcp probe. The
          // sheet already said so in its row; silently skip it here rather
          // than write a probe pointing at nothing.
          const probe = buildProbe(shape, portFor(spec));
          if (!probe) return undefined;
          const { workspaceId, serviceId } = splitKey(key);
          return window.overcli.invoke('services:setReady', {
            workspaceId,
            serviceId,
            ready: probe,
            readyTimeoutSec: spec.readyTimeoutSec,
          });
        }),
      );
    }

    if (edits.reload !== undefined) await get().setWatchMany(keys, edits.reload);

    // Reuses the ordinary bulk switch: it already plans per repository, keeps
    // a pin from being overwritten by accident, and reports what stayed put.
    if (edits.ref !== undefined) {
      // Asked to move the pinned ones without re-pinning them: clear those
      // pins first, or the switch will correctly refuse the very services the
      // user just said to move. A pin the user has chosen to drop is not a
      // pin any more.
      if (edits.unpin && !edits.pin) {
        await Promise.all(
          keys.map((key) => {
            const spec = specOf(key);
            if (!spec?.pinnedRef || spec.pinnedRef === edits.ref) return undefined;
            const { workspaceId, serviceId } = splitKey(key);
            return window.overcli.invoke('services:setPinned', {
              workspaceId,
              serviceId,
              pinnedRef: undefined,
            });
          }),
        );
      }
      await get().switchKeys(keys, edits.ref, edits.pin);
    }
    else await get().loadAll([...new Set(keys.map((key) => splitKey(key).workspaceId))]);
  },

  async setReady(workspaceId, serviceId, ready, readyTimeoutSec) {
    await window.overcli.invoke('services:setReady', { workspaceId, serviceId, ready, readyTimeoutSec });
    await get().load(workspaceId);
  },

  async setTask(workspaceId, serviceId, task) {
    await window.overcli.invoke('services:setTask', { workspaceId, serviceId, task });
    await get().load(workspaceId);
  },

  async setDeps(workspaceId, serviceId, deps) {
    await window.overcli.invoke('services:setDeps', { workspaceId, serviceId, deps });
    await get().load(workspaceId);
  },

  async addTask(workspaceId, serviceId, args) {
    const id = await window.overcli.invoke('services:addTask', { workspaceId, serviceId, ...args });
    await get().load(workspaceId);
    return id;
  },

  async setDebug(workspaceId, serviceId, enabled) {
    await window.overcli.invoke('services:setDebug', { workspaceId, serviceId, enabled });
    await get().load(workspaceId);
  },

  async duplicate(workspaceId, serviceId, args) {
    const id = await window.overcli.invoke('services:duplicate', {
      workspaceId,
      serviceId,
      ...args,
    });
    await get().load(workspaceId);
    if (id) await get().select(workspaceId, id);
    return id;
  },

  async loadMachine() {
    const view = await window.overcli.invoke('services:machineValues');
    set({ machine: view.entries, secureStorage: view.secureStorage, migrationError: view.migrationError, backupPath: view.backupPath });
  },

  async saveMachine(entries) {
    await window.overcli.invoke('services:saveMachineValues', entries);
    // Re-read rather than keep what was sent: what was typed into a secret
    // must not linger in renderer state once it is in the keychain.
    await get().loadMachine();
  },

  async deleteMachineBackup() {
    await window.overcli.invoke('services:deleteMachineBackup');
    await get().loadMachine();
  },

  async start(workspaceId, serviceId, offset, ignoreHeld) {
    // Remember what was asked for, so a failure that lands a second later can
    // be told apart from one that had nothing to do with this click.
    set({ awaiting: { workspaceId, serviceId } });
    // Starting something is asking to watch it. Select it now rather than
    // only when it goes wrong — the output is the point of pressing play.
    await get().select(workspaceId, serviceId);
    const result = await window.overcli.invoke('services:start', { workspaceId, serviceId, offset, ignoreHeld });
    if (!result.started && result.lease) {
      // Pressing play on a row that was not selected put the explanation on a
      // page the user could not see, so nothing appeared to happen at all.
      // Select the service that refused, so the reason is on screen next to
      // the row that just went amber.
      await get().select(workspaceId, serviceId);
      set((s) => ({
        pendingLease: { ...s.pendingLease, [workspaceId]: { serviceId, lease: result.lease! } },
      }));
      return;
    }
    // A start that worked clears any complaint left from the last attempt.
    set((s) => ({ pendingLease: { ...s.pendingLease, [workspaceId]: undefined } }));
    await get().load(workspaceId);
  },

  async stop(workspaceId, serviceId) {
    await window.overcli.invoke('services:stop', { workspaceId, serviceId });
  },

  async restart(workspaceId, serviceId) {
    await window.overcli.invoke('services:restart', { workspaceId, serviceId });
  },

  async rebind(workspaceId, serviceId, ref, path) {
    await window.overcli.invoke('services:rebind', { workspaceId, serviceId, ref, path });
    await get().load(workspaceId);
  },

  async rebindAll(workspaceId, targets) {
    const moved = await window.overcli.invoke('services:rebindAll', { workspaceId, targets });
    await get().load(workspaceId);
    return moved;
  },

  async setPinned(workspaceId, serviceId, pinnedRef) {
    await window.overcli.invoke('services:setPinned', { workspaceId, serviceId, pinnedRef });
    await get().load(workspaceId);
  },

  setChecked(keys, on) {
    set((s) => {
      const checked = { ...s.checked };
      for (const key of keys) {
        if (on) checked[key] = true;
        else delete checked[key];
      }
      return { checked, anchor: keys[keys.length - 1] ?? s.anchor };
    });
  },

  clearChecked() {
    set({ checked: {} });
  },

  setAnchor(key) {
    set({ anchor: key });
  },

  toggleCollapsed(key) {
    set((s) => ({ collapsed: { ...s.collapsed, [key]: !s.collapsed[key] } }));
  },

  async startMany(keys) {
    const requested = new Map<string, string[]>();
    for (const key of keys) {
      const { workspaceId, serviceId } = splitKey(key);
      requested.set(workspaceId, [...(requested.get(workspaceId) ?? []), serviceId]);
    }

    // Keep workspaces serial: their supervisors coordinate port claims, and
    // starting two stacks at the exact same instant could race that check.
    for (const [workspaceId, serviceIds] of requested) {
      const stack = get().stacks[workspaceId];
      if (!stack) continue;
      for (const layer of startLayers(stack.services, serviceIds)) {
        await runWithConcurrency(layer, 4, async (serviceId) => {
          const runtime = get().stacks[workspaceId]?.runtimes.find((r) => r.serviceId === serviceId);
          if (runtime && isServiceLive(runtime.status)) return;
          const result = await window.overcli.invoke('services:start', { workspaceId, serviceId });
          if (!result.started && result.lease) {
            set((s) => ({
              pendingLease: { ...s.pendingLease, [workspaceId]: { serviceId, lease: result.lease! } },
            }));
          }
        });
      }
    }
  },

  async stopMany(keys) {
    await Promise.all(
      keys.map((key) => window.overcli.invoke('services:stop', splitKey(key))),
    );
  },

  async removeMany(keys) {
    const byStack = new Map<string, string[]>();
    for (const key of keys) {
      const { workspaceId, serviceId } = splitKey(key);
      byStack.set(workspaceId, [...(byStack.get(workspaceId) ?? []), serviceId]);
    }
    const stopped: string[] = [];
    for (const [workspaceId, ids] of byStack) {
      const stack = get().stacks[workspaceId];
      for (const id of ids) {
        const runtime = stack?.runtimes.find((r) => r.serviceId === id);
        const spec = stack?.services.find((s) => s.id === id);
        if (spec && runtime && isServiceLive(runtime.status)) stopped.push(spec.name);
      }
    }

    // Off the list now, not after the engine answers. Waiting on it is what
    // made removing feel broken: the row sat there after the menu closed.
    set((s) => {
      const stacks = { ...s.stacks };
      const selected = { ...s.selected };
      let logDrawer = s.logDrawer;
      for (const [workspaceId, ids] of byStack) {
        const stack = stacks[workspaceId];
        if (!stack) continue;
        const gone = new Set(ids);
        stacks[workspaceId] = {
          ...stack,
          services: stack.services.filter((x) => !gone.has(x.id)),
          bindings: stack.bindings.filter((b) => !gone.has(b.serviceId)),
          runtimes: stack.runtimes.filter((r) => !gone.has(r.serviceId)),
        };
        if (selected[workspaceId] && gone.has(selected[workspaceId]!)) selected[workspaceId] = undefined;
        // A drawer left open on a service that no longer exists would sit
        // there showing the last lines of something the user just removed.
        if (logDrawer?.workspaceId === workspaceId && gone.has(logDrawer.serviceId)) logDrawer = undefined;
      }
      return { stacks, selected, logDrawer, checked: {}, anchor: undefined };
    });

    const entries = await Promise.all(
      [...byStack].map(async ([workspaceId, serviceIds]) => ({
        workspaceId,
        removed: await window.overcli.invoke('services:removeMany', { workspaceId, serviceIds }),
      })),
    );
    const count = entries.reduce((n, e) => n + e.removed.services.length, 0);
    if (count > 0) set({ removed: { entries, count, stopped } });
  },

  async undoRemove() {
    const removed = get().removed;
    if (!removed) return;
    set({ removed: undefined });
    await Promise.all(
      removed.entries.map((entry) => window.overcli.invoke('services:restore', entry)),
    );
    await Promise.all(removed.entries.map((entry) => get().load(entry.workspaceId)));
  },

  dismissRemoved() {
    set({ removed: undefined });
  },

  setChoices(choices) {
    set({ choices });
  },

  async switchKeys(keys, ref, pin = false) {
    const { stacks, choices } = get();
    const byStack = new Map<string, Set<string>>();
    for (const key of keys) {
      const { workspaceId, serviceId } = splitKey(key);
      byStack.set(workspaceId, (byStack.get(workspaceId) ?? new Set()).add(serviceId));
    }

    let moved = 0;
    let pinned = 0;
    const skipped = { 'no-such-ref': 0, pinned: 0, 'already-there': 0 };
    for (const [workspaceId, ids] of byStack) {
      const stack = stacks[workspaceId];
      if (!stack) continue;
      const selected = stack.services.filter((s) => ids.has(s.id));
      const currentRefs = Object.fromEntries(stack.bindings.map((b) => [b.serviceId, b.ref]));
      const pinPlan = pin ? planPinRebind(selected, choices, currentRefs, ref) : undefined;
      const plan = pinPlan ?? planBulkRebind(selected, choices, currentRefs, ref);
      const pinIds = pinPlan?.pinIds ?? [];

      // A pin click is an explicit replacement of any old pin. Clear it
      // before rebinding or the supervisor will correctly refuse the move.
      if (pin) {
        await Promise.all(
          selected
            .filter((s) => pinIds.includes(s.id) && s.pinnedRef && s.pinnedRef !== ref)
            .map((s) => window.overcli.invoke('services:setPinned', {
              workspaceId,
              serviceId: s.id,
              pinnedRef: undefined,
            })),
        );
      }
      for (const s of plan.skipped) skipped[s.reason] += 1;
      if (plan.targets.length > 0) moved += (await get().rebindAll(workspaceId, plan.targets)).length;
      if (pin) {
        await Promise.all(
          pinIds.map((serviceId) => window.overcli.invoke('services:setPinned', {
            workspaceId,
            serviceId,
            pinnedRef: ref,
          })),
        );
        pinned += pinIds.length;
        await get().load(workspaceId);
      }
    }

    // Saying what stayed matters as much as what moved: in a workspace of
    // twenty repos, most will not have the branch, and silence reads as broken.
    const sub = [
      skipped['no-such-ref'] > 0 && `${skipped['no-such-ref']} don't have that branch`,
      skipped.pinned > 0 && `${skipped.pinned} pinned`,
      skipped['already-there'] > 0 && `${skipped['already-there']} already on it`,
    ]
      .filter(Boolean)
      .join(' · ');
    set({
      notice: {
        text: pin
          ? `Pinned ${pinned} to ${ref}${moved > 0 ? ` · moved ${moved}` : ''}`
          : moved > 0
            ? `Moved ${moved} to ${ref}`
            : `Nothing moved to ${ref}`,
        sub: sub || undefined,
      },
    });
  },

  dismissNotice() {
    set({ notice: undefined });
  },

  async freePortAndStart(workspaceId, serviceId, port) {
    await window.overcli.invoke('services:freePort', port);
    set((s) => ({ pendingLease: { ...s.pendingLease, [workspaceId]: undefined } }));
    await get().start(workspaceId, serviceId);
  },

  /// Ask why it failed. The answers come from rules over the output and the
  /// repo, so this runs once per failure rather than on every render.
  async explain(workspaceId, serviceId) {
    const findings = await window.overcli.invoke('services:explainFailure', {
      workspaceId,
      serviceId,
    });
    set((s) => ({ findings: { ...s.findings, [logKey(workspaceId, serviceId)]: findings } }));
  },

  /// Ask a model, once, because the rules had nothing. Separate from
  /// `explain` on purpose: those answers are free and arrive unbidden, this
  /// one spends a subprocess and comes back labelled as a guess.
  async askAi(workspaceId, serviceId, kind, command) {
    const key = suggestionKey(workspaceId, serviceId, kind);
    set((s) => ({ suggestions: { ...s.suggestions, [key]: { status: 'asking' } } }));
    const result = await window.overcli.invoke('services:askAi', { workspaceId, serviceId, kind, command });
    set((s) => ({
      suggestions: {
        ...s.suggestions,
        [key]: result.ok
          ? { status: 'answered', backend: result.backend, text: result.text, command: result.command }
          : { status: 'failed', error: result.error },
      },
    }));
  },

  async cancelAskAi(workspaceId, serviceId, kind) {
    const key = suggestionKey(workspaceId, serviceId, kind);
    // Only a question still running has anything to stop; dismissing an
    // answer must not cancel a different ask in flight for the same service.
    if (get().suggestions[key]?.status === 'asking') {
      await window.overcli.invoke('services:cancelAskAi', { workspaceId, serviceId });
    }
    set((s) => {
      const next = { ...s.suggestions };
      delete next[key];
      return { suggestions: next };
    });
  },

  async checkoutRef(workspaceId, serviceId, ref) {
    const outcome = await window.overcli.invoke('services:checkoutRef', {
      workspaceId,
      serviceId,
      ref,
    });
    if (outcome.ok) await get().load(workspaceId);
    return outcome;
  },

  async revealConfig(workspaceId, serviceId) {
    await window.overcli.invoke('services:revealConfigDir', { workspaceId, serviceId });
  },

  async revealLogFile(workspaceId, serviceId) {
    await window.overcli.invoke('services:revealLogFile', { workspaceId, serviceId });
  },

  logFile(workspaceId, serviceId) {
    return window.overcli.invoke('services:logFile', { workspaceId, serviceId });
  },

  dismissLease(workspaceId) {
    set((s) => ({ pendingLease: { ...s.pendingLease, [workspaceId]: undefined } }));
  },

  async recheckLease(workspaceId) {
    const pending = get().pendingLease[workspaceId];
    // Only an outside holder can be re-asked. A port another overcli stack
    // holds may not be bound yet while that service starts, so "closed" there
    // does not mean free.
    if (!pending || pending.lease.kind !== 'held' || pending.lease.claim.stackId !== 'external') return;
    const status = await window.overcli.invoke('services:portStatus', pending.lease.claim.port, {
      workspaceId,
      serviceId: pending.serviceId,
    });
    // Another start may have replaced the complaint while we were asking.
    if (get().pendingLease[workspaceId] !== pending) return;
    if (!status.open) {
      set((s) => ({ pendingLease: { ...s.pendingLease, [workspaceId]: undefined } }));
      return;
    }
    const { claim } = pending.lease;
    if (status.holder === claim.holder && status.holderKind === claim.holderKind) return;
    const lease = {
      ...pending.lease,
      claim: { ...claim, holder: status.holder, holderKind: status.holderKind },
    };
    set((s) => ({ pendingLease: { ...s.pendingLease, [workspaceId]: { ...pending, lease } } }));
  },

  ingestStatus(workspaceId, runtime) {
    // A start that fails should land you on the output that says why — the
    // same rule as a start that is refused outright, and for the same reason:
    // the explanation is useless on a page nobody is looking at.
    // Explain EVERY failure, not only one the user is still waiting on. A
    // service whose readiness is "as soon as it starts" is already running by
    // the time it dies — AcmeProcessor fails thirty seconds in — so tying the
    // rules to the wait meant they never ran for exactly the failures that
    // need them most. A fresh start clears the old findings first, so a
    // stale explanation never sits over new output.
    if (runtime.status === 'starting') {
      set((s) => {
        const key = logKey(workspaceId, runtime.serviceId);
        if (!s.findings[key] && !s.suggestions[key]) return {};
        const findings = { ...s.findings };
        const suggestions = { ...s.suggestions };
        delete findings[key];
        delete suggestions[key];
        return { findings, suggestions };
      });
    }
    if (runtime.status === 'failed') void get().explain(workspaceId, runtime.serviceId);

    const awaiting = get().awaiting;
    if (
      runtime.status === 'failed' &&
      awaiting?.workspaceId === workspaceId &&
      awaiting.serviceId === runtime.serviceId
    ) {
      set({ awaiting: undefined, failedAt: Date.now() });
      void get().select(workspaceId, runtime.serviceId);
    } else if (
      (runtime.status === 'ready' || runtime.status === 'done') &&
      awaiting?.serviceId === runtime.serviceId
    ) {
      set({ awaiting: undefined });
    }

    set((s) => {
      const stack = s.stacks[workspaceId];
      if (!stack) return s;
      const runtimes = stack.runtimes.some((r) => r.serviceId === runtime.serviceId)
        ? stack.runtimes.map((r) => (r.serviceId === runtime.serviceId ? runtime : r))
        : [...stack.runtimes, runtime];
      return { stacks: { ...s.stacks, [workspaceId]: { ...stack, runtimes } } };
    });
  },

  async clearLog(workspaceId, serviceId) {
    const key = logKey(workspaceId, serviceId);
    pendingLines.delete(key);
    set((s) => ({ logs: { ...s.logs, [key]: [] }, exceptions: { ...s.exceptions, [key]: emptyExceptionLog() } }));
    await window.overcli.invoke('services:clearLog', { workspaceId, serviceId });
  },

  ingestRebound(workspaceId, serviceId, to) {
    // Whoever asked for the rebind is still awaiting it — the call resolves
    // only once the relaunched service is ready, minutes for a cold build —
    // so the row must not wait on that caller's reload to show where it went.
    set((s) => {
      const stack = s.stacks[workspaceId];
      if (!stack) return {};
      return {
        stacks: {
          ...s.stacks,
          [workspaceId]: {
            ...stack,
            bindings: stack.bindings.map((b) => (b.serviceId === serviceId ? { ...b, ref: to } : b)),
          },
        },
      };
    });
    if (get().stacks[workspaceId]) void get().loadAll([workspaceId]);
  },

  ingestLines(workspaceId, serviceId, lines) {
    const key = logKey(workspaceId, serviceId);
    const queue = pendingLines.get(key);
    if (queue) queue.push(...lines);
    else pendingLines.set(key, [...lines]);
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      const batch = [...pendingLines];
      pendingLines.clear();
      if (batch.length === 0) return;
      const now = Date.now();
      set((s) => {
        const logs = { ...s.logs };
        const exceptions = { ...s.exceptions };
        for (const [batchKey, incoming] of batch) {
          const lines = [...(logs[batchKey] ?? []), ...incoming];
          // Trim from the front so the newest output is always what survives.
          if (lines.length > LOG_LIMIT) lines.splice(0, lines.length - LOG_LIMIT);
          logs[batchKey] = lines;
          let caught = exceptions[batchKey] ?? emptyExceptionLog();
          for (const line of incoming) caught = feedException(caught, line, now);
          exceptions[batchKey] = caught;
        }
        return { logs, exceptions };
      });
    }, FLUSH_MS);
  },

}));

/// The other half of `logKey`. Workspace ids never contain a slash; service
/// ids might, so split on the first.
export function splitKey(key: string): { workspaceId: string; serviceId: string } {
  const at = key.indexOf('/');
  return { workspaceId: key.slice(0, at), serviceId: key.slice(at + 1) };
}

/// Every workspace's selection cleared. There is one detail pane, so there is
/// one selection.
function blank(selected: Record<string, string | undefined>): Record<string, undefined> {
  return Object.fromEntries(Object.keys(selected).map((k) => [k, undefined]));
}

/// Why a service will not start, for the row that just refused. Distinct from
/// a runtime status: nothing was spawned, so there is no process to have a
/// state — what there is, is a reason.
export function blockedReason(
  pending: { serviceId: string; lease: LeaseDecision } | undefined,
  serviceId: string,
): string | null {
  if (!pending || pending.serviceId !== serviceId) return null;
  if (pending.lease.kind !== 'held') return null;
  return `port ${pending.lease.claim.port} taken`;
}

/// Whether a status should read as live in the sidebar and the tab count.
export function isServiceLive(status: ServiceRuntime['status']): boolean {
  return status === 'ready' || status === 'starting' || status === 'unready';
}
