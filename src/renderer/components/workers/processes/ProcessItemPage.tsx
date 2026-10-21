// One process item on its own: loads its process, asks main again on a
// timer and whenever a team task moves, and draws the full item page. The
// Processes board and Today's right pane both open items through this.

import { useCallback, useEffect, useState } from "react";

import { useTeamsStore } from "../../../teamsStore";
import { useWorkersStore } from "../../../workersStore";
import type { ProcessStage } from "@shared/org/process";
import { ItemPage } from "./ItemPage";

/// How often an open item asks main again; main catches up with the team
/// tasks on each ask.
const REFRESH_MS = 10_000;

type Board = Extract<Awaited<ReturnType<typeof getProcess>>, { ok: true }>;

function getProcess(id: string) {
  return window.overcli.invoke("processes:get", { id });
}

/// Who does a stage, in a few words: its team or worker, or who decides.
function stageDoer(stage: ProcessStage, teamName: (id?: string) => string | undefined, workerName: (id?: string) => string | undefined): string {
  if (stage.kind === "team") return teamName(stage.teamId) ?? (stage.teamId ? "A team that's gone" : "Pick a team");
  if (stage.kind === "worker") return workerName(stage.workerId) ?? (stage.workerId ? "A worker that's gone" : "Pick a worker");
  const names = [...(stage.approverGroups ?? []).map((g) => g.name), ...(stage.approvers ?? []).map((p) => p.name)];
  return names.join(", ") || "Who decides?";
}

export function ProcessItemPage({ processId, itemId, onOpenProcess }: { processId: string; itemId: string; onOpenProcess?: () => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tasks = useTeamsStore((s) => s.tasks);
  const teamsLoaded = useTeamsStore((s) => s.loaded);
  const workers = useWorkersStore((s) => s.workers);
  const workersLoaded = useWorkersStore((s) => s.loaded);
  useEffect(() => {
    if (!teamsLoaded) void useTeamsStore.getState().reload();
  }, [teamsLoaded]);
  useEffect(() => {
    if (!workersLoaded) void useWorkersStore.getState().reload();
  }, [workersLoaded]);

  const load = useCallback(() => {
    void getProcess(processId).then((res) => {
      if (res.ok) {
        setBoard(res);
        setError(null);
      } else setError(res.error);
    });
  }, [processId]);
  useEffect(() => {
    load();
  }, [load, tasks]);
  useEffect(() => {
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const item = board?.items.find((i) => i.id === itemId);
  if (!board || !item) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-6 text-sm text-ink-muted">
        {error ?? (board ? "That item isn't in this process any more." : "Loading the item…")}
      </div>
    );
  }
  const teamName = (id?: string) => board.teams.find((t) => t.id === id)?.name;
  const workerName = (id?: string) => (board.workers ?? Object.values(workers)).find((w) => w.id === id)?.name;
  const doer = (s: ProcessStage) => stageDoer(s, teamName, workerName);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <ItemPage key={item.id} item={item} process={board.process} doer={doer} onChanged={load} onBack={onOpenProcess} />
    </div>
  );
}
