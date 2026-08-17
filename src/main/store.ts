// Disk-backed app store. Mirrors the Swift AppStore's persistence shape
// closely enough that a user migrating from the Swift build could reuse
// the same conversations list if they pointed us at the plist, but the
// default on-disk layout here is a single overcli.json in Electron's
// userData dir. Small enough to write atomically on every mutation.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { log } from './diagnostics';
import {
  Project,
  Workspace,
  Colosseum,
  AppSettings,
  DEFAULT_SETTINGS,
  FlowRegistry,
  Conversation,
  SystemInitInfo,
  PersistedFileTabs,
  PersistedView,
  UUID,
} from '../shared/types';
import { isSupportedPremiumModel } from '../shared/modelCatalog';
import { trimContextNotices } from '../shared/contextNotices';

const DEPRECATED_CODEX_MODELS = ['gpt-5.3-codex', 'gpt-5.2'];

interface StoreState {
  projects: Project[];
  workspaces: Workspace[];
  colosseums: Colosseum[];
  settings: AppSettings;
  selectedConversationId?: UUID;
  /// The non-conversation part of the user's current view (detail mode,
  /// focused project/workspace, active flow run / orchestration). Restored on
  /// launch so a renderer reload doesn't drop the user off their flow/agent.
  view?: PersistedView;
  /// Open editor tabs per scope (conversation / flow run / explorer root),
  /// so returning to a conversation reopens the files you had there. See
  /// the renderer's uiSlice + fileScope.ts.
  fileTabs?: PersistedFileTabs;
  lastInit?: SystemInitInfo;
  /// Epoch-ms of the last time we triggered each backend CLI's self-updater
  /// on startup. Keyed by Backend. Used to throttle the headless prime to
  /// roughly once per day so we don't re-spawn updaters on every launch.
  backendUpdateChecks?: Record<string, number>;
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'overcli.json');
}

function emptyState(): StoreState {
  return {
    projects: [],
    workspaces: [],
    colosseums: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

function stripDeprecatedCodexModel(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || DEPRECATED_CODEX_MODELS.includes(trimmed)) return undefined;
  return trimmed;
}

function sanitizeConversation(conv: Conversation): Conversation {
  const next = { ...conv };
  next.currentModel = stripDeprecatedCodexModel(next.currentModel) ?? '';

  const claudeModel = stripDeprecatedCodexModel(next.claudeModel);
  if (claudeModel) next.claudeModel = claudeModel;
  else delete next.claudeModel;

  const codexModel = stripDeprecatedCodexModel(next.codexModel);
  if (codexModel) next.codexModel = codexModel;
  else delete next.codexModel;

  const geminiModel = stripDeprecatedCodexModel(next.geminiModel);
  if (geminiModel) next.geminiModel = geminiModel;
  else delete next.geminiModel;

  const ollamaModel = stripDeprecatedCodexModel(next.ollamaModel);
  if (ollamaModel) next.ollamaModel = ollamaModel;
  else delete next.ollamaModel;

  const reviewModel = stripDeprecatedCodexModel(next.reviewModel ?? undefined);
  next.reviewModel = reviewModel ?? null;

  const reviewOllamaModel = stripDeprecatedCodexModel(next.reviewOllamaModel ?? undefined);
  if (reviewOllamaModel) next.reviewOllamaModel = reviewOllamaModel;
  else delete next.reviewOllamaModel;

  // Queued workspace notices supersede one another and are only cleared when
  // the conversation next sends, so a conversation you've moved on from used
  // to accumulate them forever. Running this on load migrates stores written
  // by older builds; running it on save keeps new ones bounded.
  const pendingContextUpdate = trimContextNotices(next.pendingContextUpdate);
  if (pendingContextUpdate) next.pendingContextUpdate = pendingContextUpdate;
  else delete next.pendingContextUpdate;

  return next;
}

function sanitizeProjects(projects: Project[]): Project[] {
  return projects.map((project) => ({
    ...project,
    conversations: project.conversations.map((conv) => sanitizeConversation(conv)),
  }));
}

function sanitizeWorkspaces(workspaces: Workspace[]): Workspace[] {
  return workspaces.map((workspace) => ({
    ...workspace,
    conversations: (workspace.conversations ?? []).map((conv) => sanitizeConversation(conv)),
  }));
}

function sanitizeSettings(settings: AppSettings): AppSettings {
  const backendDefaultModels = { ...settings.backendDefaultModels };
  for (const backend of ['claude', 'codex', 'gemini', 'copilot'] as const) {
    const model = backendDefaultModels[backend];
    if (model && !isSupportedPremiumModel(backend, model)) {
      delete backendDefaultModels[backend];
    }
  }
  // Same treatment for the per-tier flow pins. `tierDefault` already ignores
  // an unsupported pin at read time, but dropping it here keeps the Settings
  // select from rendering a value that isn't in its option list — a retired
  // model would otherwise show as a blank row the user can't interpret.
  const flowModelDefaults = { ...(settings.flowModelDefaults ?? {}) };
  for (const backend of ['claude', 'codex', 'gemini', 'copilot'] as const) {
    const tiers = flowModelDefaults[backend];
    if (!tiers) continue;
    const kept = { ...tiers };
    for (const [tier, model] of Object.entries(kept)) {
      if (model && !isSupportedPremiumModel(backend, model)) {
        delete kept[tier as keyof typeof kept];
      }
    }
    flowModelDefaults[backend] = kept;
  }
  return { ...settings, backendDefaultModels, flowModelDefaults };
}

/// Persisted tab caps. The renderer enforces its own (MAX_TABS_PER_SCOPE
/// in uiSlice.ts); these are the defensive bounds on what reaches disk, so
/// a renderer bug or a long-lived install can't grow overcli.json without
/// limit. Scopes are dropped oldest-first, matching the LRU key order the
/// renderer maintains.
const MAX_FILE_TAB_SCOPES = 60;
const MAX_FILE_TABS_PER_SCOPE = 12;

export function sanitizeFileTabs(raw: unknown): PersistedFileTabs | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: PersistedFileTabs = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  // Keep the newest scopes when over the cap: key order is LRU-ascending.
  for (const [scope, value] of entries.slice(-MAX_FILE_TAB_SCOPES)) {
    if (!scope || !value || typeof value !== 'object') continue;
    const { paths, activePath } = value as { paths?: unknown; activePath?: unknown };
    if (!Array.isArray(paths)) continue;
    const clean: string[] = [];
    for (const p of paths) {
      if (typeof p !== 'string' || !p) continue;
      if (clean.includes(p)) continue;
      clean.push(p);
      if (clean.length >= MAX_FILE_TABS_PER_SCOPE) break;
    }
    if (!clean.length) continue;
    const active = typeof activePath === 'string' && clean.includes(activePath) ? activePath : clean[0];
    out[scope] = { paths: clean, activePath: active };
  }
  return Object.keys(out).length ? out : undefined;
}

function conversationIds(s: StoreState): Set<string> {
  const ids = new Set<string>();
  for (const p of s.projects) for (const c of p.conversations ?? []) ids.add(c.id);
  for (const w of s.workspaces) for (const c of w.conversations ?? []) ids.add(c.id);
  return ids;
}

export function loadState(): StoreState {
  const p = storePath();
  if (!fs.existsSync(p)) return emptyState();
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    // Merge in any new default-settings keys so a plist written by an older
    // build still decodes when we add fields later.
    const merged = {
      ...emptyState(),
      ...parsed,
      settings: sanitizeSettings({ ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) }),
    };
    merged.projects = sanitizeProjects(merged.projects);
    merged.workspaces = sanitizeWorkspaces(merged.workspaces);
    merged.fileTabs = sanitizeFileTabs(merged.fileTabs);
    const regs: FlowRegistry[] = merged.settings.flowRegistries ?? [];
    if (!regs.some((r) => r.id === 'official')) {
      merged.settings.flowRegistries = [
        ...regs,
        { id: 'official', name: 'Official', indexUrl: 'https://raw.githubusercontent.com/overcodelions/overcli-flow-registry/main/index.json' },
      ];
    }
    return merged;
  } catch (err) {
    log('error', 'store.load', 'Failed to load overcli.json, starting fresh', err);
    return emptyState();
  }
}

let cached: StoreState | null = null;

function current(): StoreState {
  if (!cached) cached = loadState();
  return cached;
}

/// Trailing-debounce window for disk writes.
///
/// Persisting the store means serializing every project, workspace, and
/// conversation — comfortably past half a megabyte once a user has real
/// history. Doing that synchronously on every mutation blocked the single
/// main-process thread, which is also what brokers every streaming IPC
/// message from every running agent. A handful of agents finishing turns
/// at once was enough to stall the whole window. Writes now coalesce here
/// and run off-thread; the atomic tmp+rename is preserved either way.
export const SAVE_DEBOUNCE_MS = 500;

let saveTimer: NodeJS.Timeout | null = null;
/// Held while a write is in flight so a save arriving mid-write queues a
/// follow-up instead of putting two writers on the same tmp path.
let writing = false;
let dirtyDuringWrite = false;
/// Bumped by every synchronous flush. The async writer captures it before
/// awaiting and skips its rename if a flush landed in the meantime, so an
/// in-flight write can't clobber a newer shutdown snapshot. A counter
/// rather than a flag so persistence still works if a quit gets cancelled.
let writeGeneration = 0;

function serialize(state: StoreState): string {
  // Deliberately not pretty-printed. Nothing reads this by hand, and the
  // indentation is pure main-thread serialize time on every save.
  return JSON.stringify(state);
}

function save(): void {
  if (saveTimer) return; // window already armed; this mutation rides along
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void writeState();
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

async function writeState(): Promise<void> {
  if (!cached) return;
  if (writing) {
    dirtyDuringWrite = true;
    return;
  }
  writing = true;
  const p = storePath();
  const tmp = `${p}.tmp`;
  const gen = writeGeneration;
  // Snapshot before the first await so we persist the state as of this
  // tick rather than whatever it drifts to mid-write.
  const body = serialize(cached);
  try {
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(tmp, body, 'utf-8');
    // Atomic swap: a crash mid-write leaves the old file intact rather
    // than a half-written JSON that refuses to decode on next launch.
    if (gen === writeGeneration) await fs.promises.rename(tmp, p);
  } catch (err) {
    log('error', 'store.save', 'Failed to persist overcli.json', err);
  } finally {
    writing = false;
    if (dirtyDuringWrite) {
      dirtyDuringWrite = false;
      save();
    }
  }
}

/// Last-chance synchronous write for shutdown, where there's no event loop
/// left to await an async write on. Cancels any pending debounce and takes
/// the freshest state. Uses its own tmp path so it can't collide with a
/// write already in flight.
export function flushStoreSync(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!cached) return;
  try {
    const p = storePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-exit`;
    fs.writeFileSync(tmp, serialize(cached), 'utf-8');
    fs.renameSync(tmp, p);
    writeGeneration += 1;
  } catch (err) {
    log('error', 'store.flush', 'Failed to flush overcli.json on shutdown', err);
  }
}

export const Store = {
  load(): StoreState {
    return current();
  },
  saveProjects(projects: Project[]): void {
    const s = current();
    s.projects = sanitizeProjects(projects);
    save();
  },
  saveWorkspaces(workspaces: Workspace[]): void {
    const s = current();
    s.workspaces = sanitizeWorkspaces(workspaces);
    save();
  },
  /// Targeted update of one conversation's mutable metadata.
  ///
  /// `saveProjects`/`saveWorkspaces` re-sanitize and re-serialize every
  /// conversation in the store, and the renderer has to structured-clone
  /// the whole array across IPC to call them. Turn completion — by far the
  /// most frequent write — only ever bumps a scalar or two, so routing it
  /// through the bulk path made every finishing agent pay for all 700 of
  /// them. Returns false when the id isn't found, so the caller can fall
  /// back to a full save rather than silently dropping the change.
  patchConversation(id: UUID, patch: Partial<Conversation>): boolean {
    const s = current();
    const lists: (Conversation[] | undefined)[] = [
      ...s.projects.map((p) => p.conversations),
      ...s.workspaces.map((w) => w.conversations),
    ];
    for (const list of lists) {
      if (!list) continue;
      const idx = list.findIndex((c) => c.id === id);
      if (idx === -1) continue;
      list[idx] = sanitizeConversation({ ...list[idx], ...patch });
      save();
      return true;
    }
    return false;
  },
  saveColosseums(colosseums: Colosseum[]): void {
    const s = current();
    s.colosseums = colosseums;
    save();
  },
  saveSettings(settings: AppSettings): void {
    const s = current();
    s.settings = sanitizeSettings(settings);
    save();
  },
  saveSelection(id: UUID | null): void {
    const s = current();
    if (id) s.selectedConversationId = id;
    else delete s.selectedConversationId;
    save();
  },
  saveView(view: PersistedView): void {
    const s = current();
    s.view = view;
    save();
  },
  saveFileTabs(tabs: PersistedFileTabs): void {
    const s = current();
    s.fileTabs = sanitizeFileTabs(tabs);
    save();
  },
  /// Drop restored tabs that can no longer be opened: scopes for deleted
  /// conversations, and files that have since left the disk (an agent's
  /// scratch file, a branch switch). Without this, a returning user gets a
  /// strip of tabs that each render a "this file was deleted" panel.
  ///
  /// Async on purpose — it runs once, off the critical path of the first
  /// paint, and the main thread is the one brokering every agent's stream.
  /// Relative paths are left alone: they're workspace-member paths
  /// (`<member>/…`) that only resolve against a root the renderer holds.
  async pruneFileTabs(): Promise<void> {
    const s = current();
    if (!s.fileTabs) return;
    const known = conversationIds(s);
    const next: PersistedFileTabs = {};
    let changed = false;
    for (const [scope, entry] of Object.entries(s.fileTabs)) {
      if (scope.startsWith('conv:') && !known.has(scope.slice('conv:'.length))) {
        changed = true;
        continue;
      }
      const checked = await Promise.all(
        entry.paths.map(async (p) => {
          if (!path.isAbsolute(p)) return p;
          try {
            await fs.promises.access(p);
            return p;
          } catch {
            return null;
          }
        }),
      );
      const paths = checked.filter((p): p is string => p !== null);
      if (paths.length !== entry.paths.length) changed = true;
      if (!paths.length) continue;
      const active = entry.activePath && paths.includes(entry.activePath) ? entry.activePath : paths[0];
      next[scope] = { paths, activePath: active };
    }
    if (!changed) return;
    s.fileTabs = Object.keys(next).length ? next : undefined;
    save();
  },
  setLastInit(info: SystemInitInfo): void {
    const s = current();
    s.lastInit = info;
    save();
  },
  setBackendUpdateChecks(checks: Record<string, number>): void {
    const s = current();
    s.backendUpdateChecks = checks;
    save();
  },
};
