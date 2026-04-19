import { useEffect, useMemo, useState } from 'react';

interface BaseBranchSelectProps {
  repoPaths: string[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}

export function BaseBranchSelect({
  repoPaths,
  value,
  onChange,
  className,
  disabled,
}: BaseBranchSelectProps) {
  const paths = useMemo(
    () => Array.from(new Set(repoPaths.map((p) => p.trim()).filter(Boolean))),
    [repoPaths.join('\0')],
  );
  const [options, setOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (paths.length === 0) {
      setOptions([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all(paths.map((projectPath) => loadBaseBranches(projectPath)))
      .then((lists) => {
        if (cancelled) return;
        setOptions(intersectBranchLists(lists));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setOptions([]);
        setError(err instanceof Error ? err.message : 'Could not load branches.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [paths]);

  useEffect(() => {
    if (options.length === 0) return;
    if (!value || !options.includes(value)) onChange(options[0]);
  }, [onChange, options, value]);

  const selectedValue = options.includes(value) ? value : '';
  const placeholder = loading
    ? 'Loading branches…'
    : error
      ? 'Could not load branches'
      : paths.length > 1
        ? 'No shared branches found'
        : 'No usable branches found';
  const emptyHint =
    !loading && !error && options.length === 0
      ? paths.length > 1
        ? 'If any member repo has no commits yet, make an initial commit or fetch a remote branch first.'
        : 'If this repo has no commits yet, make an initial commit or fetch a remote branch first.'
      : null;

  return (
    <div className="flex flex-col gap-1">
      <select
        value={selectedValue}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || loading || options.length === 0}
        className={className ?? 'field px-3 py-1.5 text-sm'}
      >
        {options.length === 0 ? (
          <option value="">{placeholder}</option>
        ) : (
          options.map((branch) => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))
        )}
      </select>
      {error && <div className="text-xs text-red-400">{error}</div>}
      {emptyHint && <div className="text-xs text-amber-400">{emptyHint}</div>}
    </div>
  );
}

function intersectBranchLists(lists: string[][]): string[] {
  if (lists.length === 0) return [];
  return lists[0].filter((branch, index, first) => {
    if (first.indexOf(branch) !== index) return false;
    return lists.every((list) => list.includes(branch));
  });
}

async function loadBaseBranches(projectPath: string): Promise<string[]> {
  try {
    return await window.overcli.invoke('git:listBaseBranches', projectPath);
  } catch (err) {
    if (!isMissingHandlerError(err)) throw err;
    return loadBaseBranchesFallback(projectPath);
  }
}

async function loadBaseBranchesFallback(projectPath: string): Promise<string[]> {
  const branches: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    branches.push(trimmed);
  };

  let detected = '';
  try {
    detected = await window.overcli.invoke('git:detectBaseBranch', projectPath);
  } catch {
    // Ignore and keep going with raw git output.
  }

  const local = await window.overcli.invoke('git:run', {
    args: ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'],
    cwd: projectPath,
  });
  if (local.exitCode === 0) {
    local.stdout.split(/\r?\n/).forEach(push);
  }

  const remote = await window.overcli.invoke('git:run', {
    args: ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes'],
    cwd: projectPath,
  });
  if (remote.exitCode === 0) {
    for (const ref of remote.stdout.split(/\r?\n/)) {
      const trimmed = ref.trim();
      if (!trimmed || trimmed.endsWith('/HEAD')) continue;
      push(trimmed);
      if (trimmed.startsWith('origin/')) push(trimmed.slice('origin/'.length));
    }
  }

  if (detected && (await canResolveBranch(projectPath, detected))) {
    return [detected, ...branches.filter((branch) => branch !== detected)];
  }

  return branches;
}

async function canResolveBranch(projectPath: string, baseBranch: string): Promise<boolean> {
  const candidates = [
    baseBranch,
    `refs/heads/${baseBranch}`,
    `origin/${baseBranch}`,
    `refs/remotes/${baseBranch}`,
    `refs/remotes/origin/${baseBranch}`,
  ];
  for (const candidate of candidates) {
    const res = await window.overcli.invoke('git:run', {
      args: ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`],
      cwd: projectPath,
    });
    if (res.exitCode === 0) return true;
  }
  return false;
}

function isMissingHandlerError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('No handler registered') || message.includes('No handler registered for');
}
