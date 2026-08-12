// Zustand slice for the Flows tab's Schedules segment.
//
// Thin on purpose. Main owns every decision that matters — when a schedule
// next fires, whether it's due, what happens on overlap — so this store is a
// mirror kept in sync from `scheduleUpdate` events plus the draft the editor
// is currently building. `nextFireAt` in particular is never computed here:
// it's derived in main from the trigger and the last firing, and a second
// implementation would drift the moment one of them changed.

import { create } from 'zustand';

import type { Schedule, ScheduleTarget, ScheduleTrigger } from '@shared/flows/schedule';

/// What the editor form holds. Everything is present and typed, so `save`
/// hands main a complete record — main re-validates with the same
/// `validateSchedule` the form uses, so there is one rule set, not two.
export interface ScheduleDraft {
  /// Absent when creating.
  id?: string;
  name: string;
  enabled: boolean;
  projectPath: string;
  target: ScheduleTarget;
  trigger: ScheduleTrigger;
  onOverlap: Schedule['onOverlap'];
  catchUp: Schedule['catchUp'];
}

interface SchedulesState {
  loaded: boolean;
  schedules: Record<string, Schedule>;
  /// scheduleId → next fire time (ms epoch), null when disabled.
  nextFireAt: Record<string, number | null>;
  /// The schedule being created or edited, or null when the editor is closed.
  draft: ScheduleDraft | null;
  /// Set while a save/runNow is in flight, so the form can disable its buttons.
  busy: boolean;
  error: string | null;
}

interface SchedulesActions {
  reload(): Promise<void>;
  applyUpdate(schedule: Schedule, nextFireAt: number | null): void;
  removeLocal(id: string): void;
  openEditor(draft: ScheduleDraft): void;
  closeEditor(): void;
  patchDraft(patch: Partial<ScheduleDraft>): void;
  save(): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  runNow(id: string): Promise<void>;
  clearError(): void;
}

/// A blank schedule, pre-filled with the choices that are right most of the
/// time: weekday mornings, isolated in a worktree, skip rather than pile up.
export function newScheduleDraft(projectPath: string): ScheduleDraft {
  return {
    name: '',
    enabled: true,
    projectPath,
    target: { kind: 'flow', flowId: '', prompt: '', runIn: 'worktree' },
    trigger: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] },
    onOverlap: 'skip',
    catchUp: 'skip',
  };
}

export function draftFromSchedule(s: Schedule): ScheduleDraft {
  return {
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    projectPath: s.projectPath,
    target: structuredClone(s.target),
    trigger: structuredClone(s.trigger),
    onOverlap: s.onOverlap,
    catchUp: s.catchUp,
  };
}

export const useSchedulesStore = create<SchedulesState & SchedulesActions>((set, get) => ({
  loaded: false,
  schedules: {},
  nextFireAt: {},
  draft: null,
  busy: false,
  error: null,

  async reload() {
    const rows = await window.overcli.invoke('schedules:list');
    const schedules: Record<string, Schedule> = {};
    const nextFireAt: Record<string, number | null> = {};
    for (const row of rows) {
      schedules[row.schedule.id] = row.schedule;
      nextFireAt[row.schedule.id] = row.nextFireAt;
    }
    set({ schedules, nextFireAt, loaded: true });
  },

  applyUpdate(schedule, nextFireAt) {
    set((s) => ({
      schedules: { ...s.schedules, [schedule.id]: schedule },
      nextFireAt: { ...s.nextFireAt, [schedule.id]: nextFireAt },
    }));
  },

  removeLocal(id) {
    set((s) => {
      const schedules = { ...s.schedules };
      const nextFireAt = { ...s.nextFireAt };
      delete schedules[id];
      delete nextFireAt[id];
      return { schedules, nextFireAt };
    });
  },

  openEditor(draft) {
    set({ draft, error: null });
  },

  closeEditor() {
    set({ draft: null, error: null });
  },

  patchDraft(patch) {
    set((s) => (s.draft ? { draft: { ...s.draft, ...patch }, error: null } : {}));
  },

  async save() {
    const draft = get().draft;
    if (!draft) return false;
    set({ busy: true, error: null });
    try {
      const res = await window.overcli.invoke('schedules:save', { schedule: draft });
      if (!res.ok) {
        set({ error: res.error });
        return false;
      }
      // The `scheduleUpdate` event has already landed the saved record; just
      // close the form.
      set({ draft: null });
      return true;
    } finally {
      set({ busy: false });
    }
  },

  async setEnabled(id, enabled) {
    const res = await window.overcli.invoke('schedules:setEnabled', { id, enabled });
    if (!res.ok) set({ error: res.error });
  },

  async remove(id) {
    const res = await window.overcli.invoke('schedules:delete', { id });
    if (!res.ok) set({ error: res.error });
  },

  async runNow(id) {
    set({ busy: true, error: null });
    try {
      const res = await window.overcli.invoke('schedules:runNow', { id });
      if (!res.ok) set({ error: res.error });
    } finally {
      set({ busy: false });
    }
  },

  clearError() {
    set({ error: null });
  },
}));
