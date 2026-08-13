import { useCallback, useEffect, useRef, useState } from 'react';

export interface ProjectBranches {
  branches: string[];
  /// True until the first (local, instant) listing lands.
  loading: boolean;
  /// True while a `git fetch origin` is in flight behind the cached list.
  refreshing: boolean;
  /// Re-fetch from origin and re-list. Safe to call while one is running.
  refresh: () => void;
}

/// Branch options for a project's pickers, in two passes.
///
/// Pass one lists what's already in the local repo — instant, so the picker
/// is usable immediately. Pass two fetches from origin and re-lists, which
/// is what surfaces a branch pushed from somewhere else (a PR opened on
/// another machine, a teammate's branch). Without it the picker silently
/// shows a stale world and answers "No matching branches." for a branch
/// that plainly exists on the remote.
export function useProjectBranches(projectPath: string | undefined, enabled = true): ProjectBranches {
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [token, setToken] = useState(0);
  // Bumped on unmount / path change so a slow fetch that lands late can't
  // overwrite the list belonging to a different project.
  const generation = useRef(0);

  const refresh = useCallback(() => setToken((t) => t + 1), []);

  useEffect(() => {
    if (!projectPath || !enabled) {
      setBranches([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const gen = ++generation.current;
    setLoading(true);
    setRefreshing(true);

    void window.overcli
      .invoke('git:listBaseBranches', projectPath)
      .then((list) => {
        if (gen !== generation.current) return;
        setBranches(list);
      })
      .catch(() => {})
      .finally(() => {
        if (gen === generation.current) setLoading(false);
      });

    void window.overcli
      .invoke('git:listBaseBranchesFresh', projectPath)
      .then((list) => {
        // An empty result means the fetch-and-list found nothing at all
        // (not a git repo, no refs) — keep the cached list rather than
        // blanking a picker the user may already be typing into.
        if (gen !== generation.current || list.length === 0) return;
        setBranches(list);
      })
      .catch(() => {})
      .finally(() => {
        if (gen === generation.current) {
          setLoading(false);
          setRefreshing(false);
        }
      });

    return () => {
      generation.current++;
    };
  }, [projectPath, enabled, token]);

  return { branches, loading, refreshing, refresh };
}
