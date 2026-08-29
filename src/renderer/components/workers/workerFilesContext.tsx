// The worker's own file list, made reachable from anywhere inside its desk.
//
// A worker's prose is full of references to files it wrote — "saved to
// design-accounting-principles-reconciliation.md" — and those files live in
// the worker's directory, not the project. Only the pane that loaded the list
// knows where they actually are, and the markdown that mentions them is
// rendered several components below it. A context beats threading `files`
// through every reply, plan and live-turn component that might one day render
// a filename.

import { createContext, useContext } from "react";
import { useStore } from "../../store";
import { openPathWithHighlight } from "../../openFile";
import { resolveWorkerFilePath, type WorkerFile } from "./workerDeskSelectors";

const WorkerFilesContext = createContext<WorkerFile[] | null>(null);

export const WorkerFilesProvider = WorkerFilesContext.Provider;

/// Click handler for `<Markdown onOpenPath>` inside a worker's desk. Resolves
/// a name the worker used for one of its own files to that file's real path,
/// and otherwise opens the mention as an ordinary path — a worker citing
/// `src/main.ts` means the repo, and that has to keep working.
export function useOpenWorkerPath(): (mention: string) => void {
  const files = useContext(WorkerFilesContext);
  const openFile = useStore((s) => s.openFile);
  return (mention: string) => {
    const resolved = files ? resolveWorkerFilePath(mention, files) : null;
    openPathWithHighlight(resolved ?? mention, openFile);
  };
}
