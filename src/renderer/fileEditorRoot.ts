// Which directory the side file editor resolves paths against.
//
// A flow run's files live wherever the run runs — a worktree, or a
// workspace symlink root under userData — and none of that is derivable
// from the selected conversation. The run pane is on screen in two
// places, though: the Flows tab, and a worker's tab once one of ITS runs
// is opened. Both need the same root, or the editor resolves a run's
// absolute paths against whatever conversation happened to be selected
// underneath and git runs in the wrong repo entirely.

/// The two views that render a flow run. Selecting a worker clears the
/// active run (`selectWorker`), so in the Workers tab an active run means
/// its pane is the one being shown.
export function flowRunPaneIsOnScreen(detailMode: string): boolean {
  return detailMode === 'flows' || detailMode === 'workers';
}

/// The run wins wherever it's shown. Otherwise a worker's own directory
/// scopes the editor to that worker's files, and everything else falls
/// back to the conversation root the editor derives itself (null here).
export function fileEditorRootFor(input: {
  detailMode: string;
  runProjectPath: string | null;
  workerFilesRoot: string | null;
}): string | null {
  if (flowRunPaneIsOnScreen(input.detailMode) && input.runProjectPath) {
    return input.runProjectPath;
  }
  if (input.detailMode === 'workers') return input.workerFilesRoot;
  return null;
}

/// Where ⌘P indexes. The finder answers the same question as the editor —
/// "the place I'm looking at" — so it shares this precedence rather than
/// keeping a second one that disagrees. The explorer wins when it's open
/// (its pane replaces the editor's), then the run or worker's desk on
/// screen, then the conversation.
///
/// Resolving from the conversation alone indexed the wrong repo inside a
/// flow: the Flows and Workers views leave a conversation selected
/// underneath, so a run out of a workspace symlink root (or its own
/// worktree) listed whichever project that stale conversation belonged to.
export function fileFinderRootFor(input: {
  detailMode: string;
  explorerRootPath: string | null;
  runProjectPath: string | null;
  workerFilesRoot: string | null;
  conversationRoot: string | null;
}): string | null {
  if (input.explorerRootPath) return input.explorerRootPath;
  return fileEditorRootFor(input) ?? input.conversationRoot;
}
