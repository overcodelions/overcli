// Disk-backed app store. Mirrors the Swift AppStore's persistence shape
// closely enough that a user migrating from the Swift build could reuse
// the same conversations list if they pointed us at the plist, but the
// default on-disk layout here is a single overcli.json in Electron's
// userData dir. Small enough to write atomically on every mutation.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
  Project,
  Workspace,
  Colosseum,
  AppSettings,
  DEFAULT_SETTINGS,
  SystemInitInfo,
  UUID,
} from '../shared/types';

interface StoreState {
  projects: Project[];
  workspaces: Workspace[];
  colosseums: Colosseum[];
  settings: AppSettings;
  selectedConversationId?: UUID;
  lastInit?: SystemInitInfo;
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

export function loadState(): StoreState {
  const p = storePath();
  if (!fs.existsSync(p)) return emptyState();
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    // Merge in any new default-settings keys so a plist written by an older
    // build still decodes when we add fields later.
    return {
      ...emptyState(),
      ...parsed,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
    };
  } catch (err) {
    console.error('Failed to load overcli.json, starting fresh:', err);
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
    s.projects = projects;
    save();
  },
  saveWorkspaces(workspaces: Workspace[]): void {
    const s = current();
    s.workspaces = workspaces;
    save();
  },
  saveColosseums(colosseums: Colosseum[]): void {
    const s = current();
    s.colosseums = colosseums;
    save();
  },
  saveSettings(settings: AppSettings): void {
    const s = current();
    s.settings = settings;
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
};
