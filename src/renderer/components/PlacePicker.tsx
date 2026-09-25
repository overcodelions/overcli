// One picker for "which project or workspace" everywhere the app asks.
//
// These were native <select>s, each listing every workspace and every repo in
// store order — forty names in a column you could only scroll, with the one
// you use daily somewhere in the middle. This opens on your pinned places and
// the ones you were in last, searches name and path as you type, and narrows
// by kind, so the usual answer is at the top and any other is a few letters
// away.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useStore } from '../store';
import { useRunningMap } from '../runnersStore';
import { useFlowsStore } from '../flowsStore';
import { isSamePath } from '@shared/pathScope';
import {
  agoLabel,
  filterPlaces,
  placeId,
  placeKind,
  placeName,
  placePath,
  workspaceRefs,
  type PlaceFilter,
  type PlaceRef,
  type PlaceSort,
} from '../places';
import { projectActivityAt, workspaceActivityAt } from './sidebarItems';
import { KindIcon } from './SidebarPlaces';

const RECENT_COUNT = 6;

export function PlacePicker({
  value,
  onChange,
  placeholder = 'Pick a project…',
  size = 'md',
  label,
  className = '',
}: {
  /// The chosen place's path (a project's folder or a workspace's root), or
  /// '' for none.
  value: string;
  onChange: (path: string, ref: PlaceRef) => void;
  placeholder?: string;
  size?: 'sm' | 'md';
  /// Accessible name for the trigger when no visible label sits beside it.
  label?: string;
  className?: string;
}) {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const isGitRepoById = useStore((s) => s.projectIsGitRepo);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const all = useMemo<PlaceRef[]>(
    () => [...workspaceRefs(workspaces, projects), ...projects.map((project) => ({ kind: 'project' as const, project }))],
    [projects, workspaces],
  );
  const current = value ? all.find((ref) => isSamePath(placePath(ref), value)) : undefined;
  const kindOf = (ref: PlaceRef) => placeKind(ref, ref.kind === 'project' ? isGitRepoById[ref.project.id] : undefined);

  const small = size === 'sm';
  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        className={
          'inline-flex min-w-0 items-center gap-1.5 rounded border border-card-strong bg-card text-left text-ink hover:border-ink-faint ' +
          (open ? 'border-accent/70 ' : '') +
          (small ? 'max-w-[220px] px-1.5 py-0.5 text-[11px] ' : 'w-full max-w-[380px] px-2 py-1.5 text-sm ') +
          className
        }
      >
        {current ? <KindIcon kind={kindOf(current)} size={small ? 11 : 13} /> : null}
        <span className={'min-w-0 flex-1 truncate ' + (current ? '' : 'text-ink-faint')}>
          {current ? placeName(current) : placeholder}
        </span>
        {current?.kind === 'workspace' && !small && (
          <span className="flex-shrink-0 text-[11px] text-ink-faint">
            workspace · {current.members.length} repo{current.members.length === 1 ? '' : 's'}
          </span>
        )}
        <svg width="10" height="10" viewBox="0 0 16 16" className="flex-shrink-0 text-ink-faint" aria-hidden>
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <PickerPopover
          anchor={trigger}
          all={all}
          value={current ? placeId(current) : null}
          kindOf={kindOf}
          onPick={(ref) => {
            setOpen(false);
            onChange(placePath(ref), ref);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function PickerPopover({
  anchor,
  all,
  value,
  kindOf,
  onPick,
  onClose,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  all: PlaceRef[];
  value: string | null;
  kindOf: (ref: PlaceRef) => ReturnType<typeof placeKind>;
  onPick: (ref: PlaceRef) => void;
  onClose: () => void;
}) {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const colosseums = useStore((s) => s.colosseums);
  const pinned = useStore((s) => s.settings.pinnedPlaces);
  const pickProject = useStore((s) => s.pickProject);
  const runners = useRunningMap();
  const flowRuns = useFlowsStore((s) => s.runs);
  const [now] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PlaceFilter>('all');
  const [sort, setSort] = useState<PlaceSort>('recent');
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);

  const activity = useMemo(() => {
    const at = new Map<string, number>();
    for (const ref of all) {
      at.set(
        placeId(ref),
        ref.kind === 'project'
          ? projectActivityAt(ref.project, colosseums, runners, flowRuns, now)
          : Math.max(
              workspaceActivityAt(ref.workspace, runners, flowRuns, now),
              ...ref.members.map((m) => projectActivityAt(m, colosseums, runners, flowRuns, now)),
            ),
      );
    }
    return (ref: PlaceRef) => at.get(placeId(ref)) ?? 0;
  }, [all, colosseums, runners, flowRuns, now]);

  // Grouped when you have not asked for anything; one flat, ranked list the
  // moment you type, filter or sort.
  const sections = useMemo(() => {
    const flat = query || filter !== 'all' || sort !== 'recent';
    if (flat) {
      const found = filterPlaces(projects, workspaces, {
        query,
        sort,
        filter,
        kind: kindOf,
        activityAt: activity,
        status: () => ({ running: 0, needsYou: 0 }),
        weight: (ref) =>
          ref.kind === 'project'
            ? ref.project.conversations.length
            : (ref.workspace.conversations ?? []).length + ref.members.reduce((n, m) => n + m.conversations.length, 0),
      });
      return [{ title: '', items: found }];
    }
    const byId = new Map(all.map((ref) => [placeId(ref), ref]));
    const pins = (pinned ?? []).map((id) => byId.get(id)).filter((r): r is PlaceRef => !!r);
    const taken = new Set(pins.map(placeId));
    const recent = [...all]
      .filter((ref) => !taken.has(placeId(ref)))
      .sort((a, b) => activity(b) - activity(a))
      .slice(0, RECENT_COUNT);
    for (const ref of recent) taken.add(placeId(ref));
    const rest = all.filter((ref) => !taken.has(placeId(ref))).sort((a, b) => placeName(a).localeCompare(placeName(b)));
    return [
      { title: 'Pinned', items: pins },
      { title: 'Recent', items: recent },
      { title: 'Everything else, A–Z', items: rest },
    ].filter((s) => s.items.length > 0);
  }, [query, filter, sort, projects, workspaces, all, pinned, activity, kindOf]);
  const options = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  useEffect(() => setCursor(0), [query, filter, sort]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    if (!a) return;
    const width = Math.max(360, Math.min(460, a.width));
    const left = Math.max(8, Math.min(a.left, window.innerWidth - width - 8));
    const below = window.innerHeight - a.bottom - 12;
    const above = a.top - 12;
    const up = below < 320 && above > below;
    const maxHeight = Math.min(520, up ? above : below);
    setPos({ top: up ? a.top - 4 - maxHeight : a.bottom + 4, left, width, maxHeight });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [anchor, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(options.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const ref = options[cursor];
      if (ref) onPick(ref);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const FILTERS: Array<[PlaceFilter, string]> = [
    ['all', 'All'],
    ['workspaces', 'Workspaces'],
    ['repos', 'Repos'],
    ['documents', 'Documents'],
  ];
  let index = -1;

  return createPortal(
    <div
      ref={box}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: pos?.width ?? 400,
        maxHeight: pos?.maxHeight,
      }}
      className="z-50 flex flex-col overflow-hidden rounded-lg border border-card-strong bg-surface-elevated text-xs shadow-2xl"
    >
      <div className="flex flex-col gap-2 border-b border-card-strong p-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${all.length} places — name or path`}
          aria-label="Search places"
          className="field w-full px-2 py-1.5 text-xs"
        />
        <div className="flex items-center gap-1 text-[10.5px] text-ink-faint">
          {FILTERS.map(([v, l]) => (
            <button
              key={v}
              type="button"
              onClick={() => setFilter(v)}
              aria-pressed={filter === v}
              className={
                'rounded-full px-2 py-px ' +
                (filter === v ? 'bg-card-strong text-ink' : 'border border-card-strong hover:text-ink-muted')
              }
            >
              {l}
            </button>
          ))}
          <span className="flex-1" />
          <span>Sort</span>
          <div className="flex gap-px rounded bg-card p-px">
            {(['recent', 'az'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setSort(v)}
                aria-pressed={sort === v}
                className={'rounded px-1.5 py-px ' + (sort === v ? 'bg-card-strong text-ink' : 'hover:text-ink-muted')}
              >
                {v === 'recent' ? 'Recent' : 'A–Z'}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div ref={list} role="listbox" aria-label="Places" className="min-h-0 flex-1 overflow-y-auto p-1">
        {options.length === 0 && <div className="px-2 py-3 text-ink-faint">Nothing matches.</div>}
        {sections.map((section) => (
          <div key={section.title || 'results'}>
            {section.title && (
              <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                {section.title}
              </div>
            )}
            {section.items.map((ref) => {
              index += 1;
              const i = index;
              const id = placeId(ref);
              const chosen = id === value;
              const meta =
                ref.kind === 'workspace'
                  ? `workspace · ${ref.members.length} repo${ref.members.length === 1 ? '' : 's'}`
                  : shortPath(ref.project.path);
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={chosen}
                  data-index={i}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => onPick(ref)}
                  className={
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ' +
                    (i === cursor ? 'bg-card-strong ' : '') +
                    (chosen ? 'text-ink' : 'text-ink-muted')
                  }
                >
                  <KindIcon kind={kindOf(ref)} />
                  <span className={'min-w-0 flex-1 truncate ' + (chosen ? 'font-medium' : '')}>{placeName(ref)}</span>
                  <span className="max-w-[45%] flex-shrink-0 truncate text-[10.5px] text-ink-faint">
                    {meta}
                    {activity(ref) ? ` · ${agoLabel(activity(ref), now)}` : ''}
                  </span>
                  {chosen && (
                    <svg width="12" height="12" viewBox="0 0 16 16" className="flex-shrink-0 text-accent" aria-hidden>
                      <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 border-t border-card-strong px-3 py-1.5 text-[10.5px] text-ink-faint">
        <span>↑↓ move</span>
        <span>↵ choose</span>
        <span>esc close</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            onClose();
            void pickProject();
          }}
          className="hover:text-ink"
        >
          + Open another folder…
        </button>
      </div>
    </div>,
    document.body,
  );
}

/// ~/code/ledger-svc rather than /Users/someone/code/ledger-svc.
function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}
