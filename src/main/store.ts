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
  UUID,
} from '../shared/types';
import { isSupportedPremiumModel } from '../shared/modelCatalog';

const DEPRECATED_CODEX_MODELS = ['gpt-5.3-codex', 'gpt-5.2'];

interface StoreState {
  projects: Project[];
  workspaces: Workspace[];
  colosseums: Colosseum[];
  settings: AppSettings;
  selectedConversationId?: UUID;
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
  return { ...settings, backendDefaultModels };
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

function save(): void {
  if (!cached) return;
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Atomic write: write to .tmp then rename so a crash mid-write doesn't
  // leave a half-written JSON file that refuses to decode on next launch.
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cached, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
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
