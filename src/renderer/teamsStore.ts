// Renderer mirror of teams and their tasks. Main decides everything (see
// src/main/flows/teamEngine.ts); this store holds what main last pushed and
// forwards the user's actions over IPC. Which team is on screen lives in
// workersStore, beside the worker selection it is a peer of.

import { create } from 'zustand';
import type { Attachment, UUID } from '@shared/types';
import type { Team, TeamHireRequest, TeamMember, TeamRosterDraft, TeamTask } from '@shared/flows/team';
import type { Worker } from '@shared/flows/worker';

export type TeamInput = Omit<Team, 'id' | 'createdAt' | 'updatedAt'> & { id?: UUID };

type Result = { ok: true } | { ok: false; error: string };

interface TeamsState {
  loaded: boolean;
  teams: Record<string, Team>;
  tasks: Record<string, TeamTask>;
  /// The create/edit screen: `teamId` null is a new team.
  editor: { teamId: string | null } | null;
  /// Task ids with an action in flight, so buttons can't be double-sent.
  busy: Record<string, boolean>;
  /// The last error per task (or per team for briefs and saves).
  errors: Record<string, string | null>;
  /// What the coordinator has written so far in its current turn, per task.
  /// Live only: main does not persist it.
  progress: Record<string, { stage: number | null | 'room'; tail: string; chars: number }>;
}

interface TeamsActions {
  reload(): Promise<void>;
  applyTeam(team: Team): void;
  removeTeamLocal(id: string): void;
  applyTask(task: TeamTask): void;
  removeTaskLocal(id: string): void;
  applyProgress(taskId: string, stage: number | null | 'room', tail: string, chars: number): void;
  roomAsk(taskId: string, text: string, attachments?: Attachment[]): Promise<Result>;
  roomContinue(taskId: string): Promise<Result>;
  roomStop(taskId: string): Promise<Result>;
  updatePack(taskId: string): Promise<Result>;
  roomStartWork(taskId: string, messageId: string): Promise<Result>;
  roomDismissWork(taskId: string, messageId: string): Promise<Result>;
  roomHandOff(taskId: string, messageId: string): Promise<Result>;
  openFolder(taskId: string): Promise<Result>;
  openFile(taskId: string, name: string): Promise<Result>;
  openEditor(teamId: string | null): void;
  closeEditor(): void;
  save(team: TeamInput): Promise<{ ok: true; team: Team } | { ok: false; error: string }>;
  remove(id: string): Promise<Result>;
  /// Suggest a team for what you describe. Nothing is saved.
  draftRoster(
    brief: string,
    current?: { name?: string; purpose?: string; members: TeamMember[]; projectPath?: string; ownProjectOnly?: boolean },
  ): Promise<{ ok: true; draft: TeamRosterDraft } | { ok: false; error: string }>;
  /// Hire one worker for a team. They land on the crew with no shifts; the
  /// editor puts them on the team.
  landCode(taskId: string, projectPath: string): Promise<{ ok: true; message: string } | { ok: false; error: string }>;
  hireMember(request: TeamHireRequest): Promise<{ ok: true; worker: Worker } | { ok: false; error: string }>;
  /// `projectPath`: where this task works, over the team's; `null` for
  /// each member in their own.
  brief(teamId: string, brief: string, attachments?: Attachment[], projectPath?: string | null): Promise<Result>;
  answer(taskId: string, answers: string[]): Promise<Result>;
  revise(taskId: string, feedback: string): Promise<Result>;
  approve(taskId: string): Promise<Result>;
  continueTask(taskId: string, extraBudgetUSD?: number): Promise<Result>;
  retry(taskId: string): Promise<Result>;
  cancel(taskId: string): Promise<Result>;
  skip(taskId: string, stage: number, workerId?: string): Promise<Result>;
  accept(taskId: string): Promise<Result>;
  deleteTask(taskId: string): Promise<Result>;
  readFile(taskId: string, name: string): Promise<{ ok: true; body: string } | { ok: false; error: string }>;
}

export const useTeamsStore = create<TeamsState & TeamsActions>((set, get) => {
  /// Run one task action with the busy flag and error slot handled.
  const act = async (key: string, call: () => Promise<Result>): Promise<Result> => {
    if (get().busy[key]) return { ok: false, error: 'Already working on it.' };
    set((s) => ({ busy: { ...s.busy, [key]: true }, errors: { ...s.errors, [key]: null } }));
    try {
      const res = await call();
      if (!res.ok) set((s) => ({ errors: { ...s.errors, [key]: res.error } }));
      return res;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      set((s) => ({ errors: { ...s.errors, [key]: error } }));
      return { ok: false, error };
    } finally {
      set((s) => ({ busy: { ...s.busy, [key]: false } }));
    }
  };

  return {
    loaded: false,
    teams: {},
    tasks: {},
    editor: null,
    busy: {},
    errors: {},
    progress: {},

    async reload() {
      const { teams, tasks } = await window.overcli.invoke('teams:list');
      set({
        loaded: true,
        teams: Object.fromEntries(teams.map((t) => [t.id, t])),
        tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
      });
    },

    applyTeam(team) {
      set((s) => ({ teams: { ...s.teams, [team.id]: team } }));
    },

    removeTeamLocal(id) {
      set((s) => {
        const teams = { ...s.teams };
        delete teams[id];
        const tasks = Object.fromEntries(Object.entries(s.tasks).filter(([, t]) => t.teamId !== id));
        return { teams, tasks, editor: s.editor?.teamId === id ? null : s.editor };
      });
    },

    applyTask(task) {
      set((s) => ({ tasks: { ...s.tasks, [task.id]: task } }));
    },

    removeTaskLocal(id) {
      set((s) => {
        const tasks = { ...s.tasks };
        delete tasks[id];
        return { tasks };
      });
    },

    applyProgress(taskId, stage, tail, chars) {
      set((s) => ({ progress: { ...s.progress, [taskId]: { stage, tail, chars } } }));
    },

    openEditor(teamId) {
      set({ editor: { teamId } });
    },

    closeEditor() {
      set({ editor: null });
    },

    async save(team) {
      const res = await window.overcli.invoke('teams:save', { team });
      if (res.ok) get().applyTeam(res.team);
      return res;
    },

    async remove(id) {
      const res = await window.overcli.invoke('teams:delete', { id });
      if (res.ok) get().removeTeamLocal(id);
      return res;
    },

    draftRoster: (brief, current) => window.overcli.invoke('teams:draftRoster', { brief, current }),
    hireMember: (request) => window.overcli.invoke('teams:hireMember', { request }),
    landCode: async (taskId, projectPath) => {
      const res = await window.overcli.invoke('teams:landCode', { taskId, projectPath });
      set((s) => ({ errors: { ...s.errors, [taskId]: res.ok ? null : res.error } }));
      return res;
    },

    brief(teamId, brief, attachments, projectPath) {
      return act(teamId, async () => {
        const res = await window.overcli.invoke('teams:brief', { teamId, brief, attachments, projectPath });
        if (!res.ok) return res;
        get().applyTask(res.task);
        return { ok: true };
      });
    },

    answer: (taskId, answers) => act(taskId, () => window.overcli.invoke('teams:answer', { taskId, answers })),
    revise: (taskId, feedback) => act(taskId, () => window.overcli.invoke('teams:revise', { taskId, feedback })),
    approve: (taskId) => act(taskId, () => window.overcli.invoke('teams:approve', { taskId })),
    continueTask: (taskId, extraBudgetUSD) =>
      act(taskId, () => window.overcli.invoke('teams:continue', { taskId, extraBudgetUSD })),
    retry: (taskId) => act(taskId, () => window.overcli.invoke('teams:retry', { taskId })),
    cancel: (taskId) => act(taskId, () => window.overcli.invoke('teams:cancel', { taskId })),
    skip: (taskId, stage, workerId) =>
      act(taskId, () => window.overcli.invoke('teams:skip', { taskId, stage, workerId })),
    accept: (taskId) => act(taskId, () => window.overcli.invoke('teams:accept', { taskId })),
    deleteTask: (taskId) =>
      act(taskId, async () => {
        const res = await window.overcli.invoke('teams:deleteTask', { taskId });
        if (res.ok) get().removeTaskLocal(taskId);
        return res;
      }),
    readFile: (taskId, name) => window.overcli.invoke('teams:readFile', { taskId, name }),
    roomAsk: (taskId, text, attachments) =>
      act(taskId, () => window.overcli.invoke('teams:roomAsk', { taskId, text, attachments })),
    roomContinue: (taskId) => act(taskId, () => window.overcli.invoke('teams:roomContinue', { taskId })),
    // Not through `act`: stopping has to work while the room is busy.
    roomStop: (taskId) => window.overcli.invoke('teams:roomStop', { taskId }),
    updatePack: (taskId) => act(taskId, () => window.overcli.invoke('teams:updatePack', { taskId })),
    roomStartWork: (taskId, messageId) =>
      act(taskId, () => window.overcli.invoke('teams:roomStartWork', { taskId, messageId })),
    roomDismissWork: (taskId, messageId) =>
      act(taskId, () => window.overcli.invoke('teams:roomDismissWork', { taskId, messageId })),
    roomHandOff: (taskId, messageId) =>
      act(taskId, () => window.overcli.invoke('teams:roomHandOff', { taskId, messageId })),
    openFile: async (taskId, name) => {
      const res = await window.overcli.invoke('teams:openFile', { taskId, name });
      if (!res.ok) set((s) => ({ errors: { ...s.errors, [taskId]: res.error } }));
      return res;
    },
    openFolder: async (taskId) => {
      const res = await window.overcli.invoke('teams:openFolder', { taskId });
      if (!res.ok) set((s) => ({ errors: { ...s.errors, [taskId]: res.error } }));
      return res;
    },
  };
});
