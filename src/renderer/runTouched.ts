// When you last touched a flow run — not just when the run itself last moved.
//
// A paused run stops counting as "needs you" once it has sat still for the
// stall window (see runTriage.ts): a badge you can't clear stops being a
// signal. But "sat still" used to mean only the run's own clock — when it was
// created or last ran a step — so a run you were talking to today, started
// two weeks ago, dropped out of the tray while it plainly still needed you.
// Your side counts too: the last thing you typed to any of its participants
// (persisted on those conversations), and when you last opened it this
// session.

import { useMemo } from 'react';

import type { FlowRun } from '@shared/flows/schema';
import type { Project, Workspace } from '@shared/types';
import { useFlowsStore } from './flowsStore';
import { useStore } from './store';

export type RunTouchedAt = (run: FlowRun) => number;

export function runTouchedAtFrom(
  projects: Project[],
  workspaces: Workspace[],
  lastOpenedAtByRun: Record<string, number>,
): RunTouchedAt {
  const promptAt = new Map<string, number>();
  for (const place of [...projects, ...workspaces]) {
    for (const c of place.conversations) if (c.lastPromptAt) promptAt.set(c.id, c.lastPromptAt);
  }
  return (run) => {
    let at = lastOpenedAtByRun[run.id] ?? 0;
    for (const id of Object.values(run.conversationIds ?? {})) at = Math.max(at, promptAt.get(id) ?? 0);
    return at;
  };
}

export function useRunTouchedAt(): RunTouchedAt {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const lastOpenedAtByRun = useFlowsStore((s) => s.lastOpenedAtByRun);
  return useMemo(
    () => runTouchedAtFrom(projects, workspaces, lastOpenedAtByRun),
    [projects, workspaces, lastOpenedAtByRun],
  );
}
