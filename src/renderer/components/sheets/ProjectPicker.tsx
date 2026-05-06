import { ReactNode, useMemo, useState } from 'react';
import { Project } from '@shared/types';

interface Props {
  projects: Project[];
  picked: Set<string>;
  onChange: (next: Set<string>) => void;
  renderRowBadge?: (project: Project, checked: boolean) => ReactNode;
}

export function ProjectPicker({ projects, picked, onChange, renderRowBadge }: Props) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const selected = useMemo(
    () => projects.filter((p) => picked.has(p.id)),
    [projects, picked],
  );
  const visibleUnselected = useMemo(
    () =>
      projects.filter((p) => {
        if (picked.has(p.id)) return false;
        if (!q) return true;
        return p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q);
      }),
    [projects, picked, q],
  );

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(picked);
    if (checked) next.add(id);
    else next.delete(id);
    onChange(next);
  };

  const selectAllVisible = () => {
    if (visibleUnselected.length === 0) return;
    const next = new Set(picked);
    for (const p of visibleUnselected) next.add(p.id);
    onChange(next);
  };

  const renderRow = (p: Project) => {
    const checked = picked.has(p.id);
    return (
      <label
        key={p.id}
        className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-card-strong cursor-pointer border-b border-card last:border-b-0"
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => toggle(p.id, e.target.checked)}
          className="accent-accent"
        />
        <div className="flex-1 min-w-0">
          <div>{p.name}</div>
          <div className="text-[10px] text-ink-faint truncate">{p.path}</div>
        </div>
        {renderRowBadge?.(p, checked)}
      </label>
    );
  };

  return (
    <div>
      <div className="flex items-center gap-2 mt-1">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={projects.length > 0 ? `Search ${projects.length} projects…` : 'Search projects…'}
          className="field flex-1 px-3 py-1.5 text-sm"
        />
        <div className="text-[10px] text-ink-faint whitespace-nowrap">
          {picked.size}/{projects.length} selected
        </div>
      </div>
      <div className="mt-1 border border-card rounded max-h-[300px] overflow-y-auto">
        {selected.map(renderRow)}

        {q && (
          <div className="flex items-center justify-between px-3 py-1.5 text-[10px] text-ink-faint bg-card/30 border-b border-card">
            <span>
              {visibleUnselected.length === 0
                ? 'No matches'
                : `${visibleUnselected.length} match${visibleUnselected.length === 1 ? '' : 'es'}`}
            </span>
            {visibleUnselected.length > 0 && (
              <button
                type="button"
                onClick={selectAllVisible}
                className="text-accent hover:underline"
              >
                Select all visible
              </button>
            )}
          </div>
        )}

        {visibleUnselected.map(renderRow)}

        {projects.length === 0 && (
          <div className="px-3 py-3 text-xs text-ink-faint text-center">No projects yet.</div>
        )}
      </div>
    </div>
  );
}
