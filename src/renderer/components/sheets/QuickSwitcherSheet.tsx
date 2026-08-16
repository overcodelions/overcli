// ⌘K. One input over everything the app knows about: chats, agents, flow
// runs, saved flows, projects, workspaces, archived conversations, and app
// actions. Ranking + bucketing live in ./commandPalette.ts (pure, tested);
// this file owns the chrome, the keyboard, and the side effects.
//
// Rows are typed on sight — a monogram tile for flows, a backend-tinted
// marker for chats, a folder for places — and statused on the right, so the
// list reads as a map of the app rather than a wall of titles.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UUID } from '@shared/types';
import { useStore } from '../../store';
import { useFlowsStore } from '../../flowsStore';
import { draftFromWorker, useWorkersStore } from '../../workersStore';
import { useRunningMap } from '../../runnersStore';
import { findContainerPath } from '../../conversationLookup';
import { backendColor } from '../../theme';
import { FlowMonogram } from '../flows/FlowMonogram';
import {
  adjacentGroupStart,
  buildPaletteGroups,
  buildPaletteItems,
  flattenGroups,
  groupStartIndices,
  scopeCounts,
  arrowStepFromQueryEdge,
  SECTION_LABEL,
  type PaletteCommand,
  type PaletteItem,
  type PaletteKind,
  type PaletteScope,
  type PaletteStatus,
  type RankedItem,
} from './commandPalette';

const SCOPES: Array<{ id: PaletteScope; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'chats', label: 'Chats' },
  { id: 'flows', label: 'Flows' },
  { id: 'places', label: 'Places' },
  { id: 'actions', label: 'Actions' },
  { id: 'archived', label: 'Archived' },
];

export function QuickSwitcherSheet() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const lastSelectedAt = useStore((s) => s.lastSelectedAt);
  const selectedConversationId = useStore((s) => s.selectedConversationId);
  const showDebug = useStore((s) => s.settings.showDebug ?? false);
  const selectConversation = useStore((s) => s.selectConversation);
  const openSheet = useStore((s) => s.openSheet);
  const renameConversation = useStore((s) => s.renameConversation);
  const setConversationHidden = useStore((s) => s.setConversationHidden);
  const setDetailMode = useStore((s) => s.setDetailMode);
  const openExplorer = useStore((s) => s.openExplorer);
  const startNewConversation = useStore((s) => s.startNewConversation);
  const startNewConversationInWorkspace = useStore((s) => s.startNewConversationInWorkspace);

  const runs = useFlowsStore((s) => s.runs);
  const flows = useFlowsStore((s) => s.flows);
  const workers = useWorkersStore((s) => s.workers);
  const lastOpenedAtByRun = useFlowsStore((s) => s.lastOpenedAtByRun);
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const openEditor = useFlowsStore((s) => s.openEditor);
  const renameRun = useFlowsStore((s) => s.renameRun);
  const flowsLoaded = useFlowsStore((s) => s.loaded);
  const reloadFlows = useFlowsStore((s) => s.reload);

  // The library is loaded lazily by the Flows/Welcome panes. ⌘K can be the
  // first thing a user touches in a session, and a palette that silently
  // knows about no flows is worse than a brief one-frame gap.
  useEffect(() => {
    if (!flowsLoaded) void reloadFlows(projects.map((p) => p.path));
  }, [flowsLoaded, reloadFlows, projects]);

  // Value-stable projection: token-by-token runner updates don't re-render
  // the palette while the user is typing.
  const runningMap = useRunningMap();
  const runningIds = useMemo(() => {
    const set = new Set<string>();
    for (const [id, r] of Object.entries(runningMap)) if (r?.isRunning) set.add(id);
    return set;
  }, [runningMap]);

  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<PaletteScope>('all');
  const [selected, setSelected] = useState(0);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The palette is mounted for a few seconds at a time; freezing "now" on
  // mount keeps recency bonuses stable while the user types instead of
  // letting rows drift between keystrokes.
  const now = useMemo(() => Date.now(), []);

  const commands = usePaletteCommands({ showDebug });

  const items = useMemo(
    () =>
      buildPaletteItems({
        projects,
        workspaces,
        runs: Object.values(runs),
        flows,
        workers: Object.values(workers),
        commands,
        runningIds,
        lastSelectedAt,
        lastOpenedAtByRun,
      }),
    [projects, workspaces, runs, flows, workers, commands, runningIds, lastSelectedAt, lastOpenedAtByRun],
  );

  const groups = useMemo(
    () => buildPaletteGroups(items, query, scope, now),
    [items, query, scope, now],
  );
  const flat = useMemo(() => flattenGroups(groups), [groups]);
  const counts = useMemo(() => scopeCounts(items, query, now), [items, query, now]);
  const groupStarts = useMemo(() => groupStartIndices(groups), [groups]);

  // Preselect the top row. At rest, if that's the chat already on screen,
  // fall through to the next one so ↵ still goes somewhere useful.
  useEffect(() => {
    const top = flat[0]?.item.target;
    if (
      !query.trim() &&
      selectedConversationId &&
      top?.type === 'conversation' &&
      top.convId === selectedConversationId &&
      flat.length > 1
    ) {
      setSelected(1);
      return;
    }
    setSelected(0);
  }, [query, scope, selectedConversationId, flat]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-palette-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected, groups]);

  const close = useCallback(() => openSheet(null), [openSheet]);

  const commit = useCallback(
    (item: PaletteItem, alternate = false) => {
      // Close FIRST — several targets open another sheet, and closing after
      // would immediately dismiss it.
      close();
      const target = item.target;
      // A flow is the one row whose primary action needs more input than the
      // palette collected — which project, and what to work on — so it hands
      // off to the launcher sheet. ⌘↵ still goes to the editor.
      if (target.type === 'flow' && !alternate) {
        openSheet({ type: 'flowLaunch', flowId: target.flowId });
        return;
      }
      switch (target.type) {
        case 'conversation':
          if (item.archived) openSheet({ type: 'archiveConversation', convId: target.convId });
          else selectConversation(target.convId);
          return;
        case 'run':
          setActiveRun(target.runId);
          setDetailMode('flows');
          return;
        case 'flow':
          openEditor({ kind: 'editing', flowId: target.flowId });
          setDetailMode('flows');
          return;
        case 'worker': {
          const w = useWorkersStore.getState().workers[target.workerId];
          if (w) useWorkersStore.getState().openEditor(draftFromWorker(w));
          setDetailMode('workers');
          return;
        }
        case 'project':
          startNewConversation(target.projectId);
          return;
        case 'workspace':
          startNewConversationInWorkspace(target.workspaceId);
          return;
        case 'command':
          commands.find((c) => c.id === target.commandId)?.run();
          return;
      }
    },
    [
      close,
      commands,
      openEditor,
      openSheet,
      selectConversation,
      setActiveRun,
      setDetailMode,
      startNewConversation,
      startNewConversationInWorkspace,
    ],
  );

  const startRename = (item: PaletteItem) => {
    if (item.target.type === 'conversation') {
      setRenamingKey(item.key);
      setRenameValue(item.title);
    } else if (item.target.type === 'run') {
      setRenamingKey(item.key);
      // Seed empty: the displayed title may be the prompt's first line, and
      // pre-filling it means clearing it before typing.
      setRenameValue('');
    }
  };

  const commitRename = async (item: PaletteItem) => {
    const next = renameValue.trim();
    setRenamingKey(null);
    setRenameValue('');
    searchRef.current?.focus();
    if (item.target.type === 'conversation') {
      if (next) await renameConversation(item.target.convId, next);
    } else if (item.target.type === 'run') {
      await renameRun(item.target.runId, next);
    }
  };

  const cancelRename = () => {
    setRenamingKey(null);
    setRenameValue('');
    searchRef.current?.focus();
  };

  const cycleScope = (delta: number) => {
    const i = SCOPES.findIndex((s) => s.id === scope);
    setScope(SCOPES[(i + delta + SCOPES.length) % SCOPES.length]!.id);
  };

  const jumpGroup = (delta: number) => {
    const next = adjacentGroupStart(groupStarts, selected, delta);
    if (next !== null) setSelected(next);
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (renamingKey) return;
    const pick = flat[selected]?.item;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      // ⌥↑/⌥↓ jumps sections mid-query, when the caret still has text to
      // walk and the bare arrows below rightly stay out of the way.
      if (e.altKey) jumpGroup(dir);
      else setSelected((s) => Math.max(0, Math.min(flat.length - 1, s + dir)));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // Bare ←/→ moves along the filter chips — they're the row that runs
      // horizontally. Only once the caret has run out of query to move
      // through, though; see arrowStepFromQueryEdge.
      const step = arrowStepFromQueryEdge(
        e.key,
        e.currentTarget.selectionStart,
        e.currentTarget.selectionEnd,
        query.length,
      );
      if (step === null) return;
      e.preventDefault();
      cycleScope(step);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      jumpGroup(e.key === 'PageDown' ? 1 : -1);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      cycleScope(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (pick) commit(pick, mod);
    } else if (mod && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      if (pick) startRename(pick);
    } else if (mod && e.key.toLowerCase() === 'e') {
      const path = pick && explorePathFor(pick, projects, workspaces);
      if (!path) return;
      e.preventDefault();
      close();
      openExplorer(path);
    } else if (mod && e.key === 'Backspace') {
      if (!pick || pick.target.type !== 'conversation') return;
      e.preventDefault();
      const convId = pick.target.convId;
      if (e.shiftKey) {
        close();
        openSheet({ type: 'archiveConversation', convId });
      } else {
        // ⌘⌫ toggles: archive a live chat, restore an archived one.
        void setConversationHidden(convId, !pick.archived);
      }
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-card px-5">
        <SearchGlyph />
        <input
          ref={searchRef}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder="Search chats, flows, projects, actions…"
          className="flex-1 bg-transparent py-3.5 text-sm text-ink outline-none placeholder:text-ink-faint"
        />
        <span className="text-[10px] text-ink-faint">{flat.length} result{flat.length === 1 ? '' : 's'}</span>
      </div>

      <div className="flex items-center gap-1 border-b border-card px-4 py-1.5">
        {SCOPES.map((s) => (
          <button
            key={s.id}
            onClick={() => {
              setScope(s.id);
              searchRef.current?.focus();
            }}
            className={
              'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ' +
              (scope === s.id
                ? 'palette-chip-active text-ink'
                : 'border-transparent text-ink-faint hover:bg-card-strong hover:text-ink-muted')
            }
          >
            {s.label}
            <span className={scope === s.id ? 'text-ink-muted' : 'text-ink-faint'}>
              {counts[s.id]}
            </span>
          </button>
        ))}
      </div>

      <div ref={listRef} className="min-h-[280px] flex-1 overflow-y-auto py-1">
        {flat.length === 0 ? (
          <EmptyState
            query={query}
            scope={scope}
            archivedCount={counts.archived}
            onScope={(next) => {
              setScope(next);
              searchRef.current?.focus();
            }}
          />
        ) : (
          groups.map((group) => {
            const startIndex = flat.indexOf(group.items[0]!);
            return (
              <div key={group.section} className="pb-1">
                <div className="flex items-center justify-between px-5 pb-1 pt-2">
                  <span className="text-[10px] uppercase tracking-wider text-ink-faint">
                    {SECTION_LABEL[group.section]}
                  </span>
                  {group.total > group.items.length && (
                    <span className="text-[10px] text-ink-faint">
                      +{group.total - group.items.length} more
                    </span>
                  )}
                </div>
                {group.items.map((ranked, i) => (
                  <PaletteRow
                    key={ranked.item.key}
                    ranked={ranked}
                    selected={startIndex + i === selected}
                    renaming={renamingKey === ranked.item.key}
                    renameValue={renameValue}
                    onRenameChange={setRenameValue}
                    onRenameCommit={() => void commitRename(ranked.item)}
                    onRenameCancel={cancelRename}
                    onHover={() => setSelected(startIndex + i)}
                    onClick={() => commit(ranked.item)}
                  />
                ))}
              </div>
            );
          })
        )}
      </div>

      <Footer item={flat[selected]?.item} projects={projects} workspaces={workspaces} />
    </div>
  );
}

// ------------------------------------------------------------------ rows

function PaletteRow({
  ranked,
  selected,
  renaming,
  renameValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onHover,
  onClick,
}: {
  ranked: RankedItem;
  selected: boolean;
  renaming: boolean;
  renameValue: string;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onHover: () => void;
  onClick: () => void;
}) {
  const { item, positions } = ranked;
  return (
    <div
      data-palette-selected={selected}
      onMouseEnter={onHover}
      onClick={() => {
        if (!renaming) onClick();
      }}
      className={
        'flex cursor-pointer items-center gap-3 px-5 py-1.5 transition-colors ' +
        (selected ? 'palette-row-selected text-ink' : 'text-ink-muted hover:bg-card-strong')
      }
    >
      <KindTile item={item} />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => onRenameChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                onRenameCommit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onRenameCancel();
              }
            }}
            placeholder={item.title}
            className="w-full rounded border border-accent bg-transparent px-1 py-0.5 text-sm text-ink outline-none"
          />
        ) : (
          <div className="truncate text-sm">
            <Highlighted text={item.title} positions={positions} />
          </div>
        )}
        {item.subtitle && (
          <div className="truncate text-[10px] text-ink-faint">{item.subtitle}</div>
        )}
      </div>
      {/* A flow's ↵ opens a launcher rather than navigating, which is worth
          saying out loud — every other row in the list just goes somewhere. */}
      {item.kind === 'flow' && selected && (
        <span className="flex-shrink-0 text-[10px] text-ink-muted">↵ run</span>
      )}
      <KindBadge kind={item.kind} />
      <StatusPill status={item.status} />
    </div>
  );
}

/// Matched characters in bold accent. Only ever fed title offsets — a hit
/// that came from a branch name or a tag highlights nothing rather than
/// lighting up an unrelated span of the title.
function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const set = new Set(positions);
  const out: React.ReactNode[] = [];
  let buffer = '';
  let bufferHit = set.has(0);
  const flush = (key: number) => {
    if (!buffer) return;
    out.push(
      bufferHit ? (
        <span key={key} className="font-semibold text-accent">
          {buffer}
        </span>
      ) : (
        <span key={key}>{buffer}</span>
      ),
    );
    buffer = '';
  };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== bufferHit) {
      flush(i);
      bufferHit = hit;
    }
    buffer += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}

/// The row's identity at a glance. Flows and runs reuse the sidebar's
/// monogram so the same flow looks the same everywhere; chats carry their
/// backend's color; places and actions get a neutral glyph tile.
function KindTile({ item }: { item: PaletteItem }) {
  if (item.kind === 'run' || item.kind === 'flow' || item.kind === 'worker') {
    return (
      <div className={item.archived ? 'opacity-50' : undefined}>
        <FlowMonogram name={item.monogram ?? item.title} size="md" live={item.status === 'running'} />
      </div>
    );
  }
  if (item.kind === 'chat' || item.kind === 'agent') {
    const color = backendColor(item.backend);
    return (
      <div
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
        style={{ background: `${color}22`, color }}
      >
        {item.kind === 'agent' ? (
          <span className="text-[13px] leading-none">⎇</span>
        ) : (
          <ChatGlyph />
        )}
      </div>
    );
  }
  return (
    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-card-strong text-ink-muted">
      {item.kind === 'project' && <FolderGlyph />}
      {item.kind === 'workspace' && <StackGlyph />}
      {item.kind === 'command' && <span className="text-[11px] leading-none">⌘</span>}
    </div>
  );
}

const KIND_LABEL: Record<PaletteKind, string> = {
  chat: 'chat',
  agent: 'agent',
  worker: 'worker',
  run: 'run',
  flow: 'flow',
  project: 'project',
  workspace: 'workspace',
  command: 'action',
};

/// Quiet type tag. Two rows can share a title across kinds ("Coverage gap
/// report" as both a flow and a run of it) — this is what tells them apart
/// without reading the subtitle.
function KindBadge({ kind }: { kind: PaletteKind }) {
  return (
    <span className="hidden flex-shrink-0 rounded border border-card px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-ink-faint sm:block">
      {KIND_LABEL[kind]}
    </span>
  );
}

const STATUS_STYLE: Record<
  Exclude<PaletteStatus, 'idle'>,
  { label: string; className: string; dot: string }
> = {
  running: {
    label: 'running',
    className: 'text-emerald-700 dark:text-emerald-300',
    dot: 'bg-emerald-500',
  },
  paused: { label: 'paused', className: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
  watching: { label: 'watching', className: 'text-sky-700 dark:text-sky-300', dot: 'bg-sky-500' },
  done: { label: 'done', className: 'text-emerald-700/70 dark:text-emerald-300/60', dot: 'bg-emerald-500/60' },
  failed: { label: 'failed', className: 'text-red-700 dark:text-red-300', dot: 'bg-red-500' },
  archived: { label: 'archived', className: 'text-ink-faint', dot: 'bg-ink-faint' },
};

function StatusPill({ status }: { status: PaletteStatus }) {
  if (status === 'idle') return null;
  const style = STATUS_STYLE[status];
  return (
    <span
      className={'flex flex-shrink-0 items-center gap-1.5 text-[10px] ' + style.className}
      title={style.label}
    >
      <span className="relative flex h-1.5 w-1.5">
        {status === 'running' && (
          <span className={'absolute inline-flex h-full w-full animate-ping rounded-full opacity-70 ' + style.dot} />
        )}
        <span className={'relative inline-flex h-1.5 w-1.5 rounded-full ' + style.dot} />
      </span>
      {style.label}
    </span>
  );
}

function EmptyState({
  query,
  scope,
  archivedCount,
  onScope,
}: {
  query: string;
  scope: PaletteScope;
  archivedCount: number;
  onScope: (scope: PaletteScope) => void;
}) {
  return (
    <div className="px-5 py-10 text-center">
      <div className="text-xs text-ink-muted">
        {query.trim() ? (
          <>
            No matches for <span className="text-ink">“{query.trim()}”</span>
          </>
        ) : (
          'Nothing here yet.'
        )}
      </div>
      <div className="mt-1 text-[10px] text-ink-faint">
        {scope !== 'all' ? (
          <button onClick={() => onScope('all')} className="underline decoration-dotted hover:text-ink-muted">
            Search everything instead
          </button>
        ) : archivedCount > 0 ? (
          <button
            onClick={() => onScope('archived')}
            className="underline decoration-dotted hover:text-ink-muted"
          >
            Look in {archivedCount} archived item{archivedCount === 1 ? '' : 's'}
          </button>
        ) : (
          'Try a project name, a branch, or an action like “settings”.'
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- footer

function Footer({
  item,
  projects,
  workspaces,
}: {
  item: PaletteItem | undefined;
  projects: { id: string; path: string }[];
  workspaces: { id: string; rootPath: string }[];
}) {
  const hints: Array<[string, string]> = [];
  const target = item?.target;
  if (item && target) {
    if (target.type === 'conversation') {
      hints.push(['↵', item.archived ? 'manage' : 'open']);
      hints.push(['⌘R', 'rename']);
      hints.push(['⌘⌫', item.archived ? 'restore' : 'archive']);
      hints.push(['⌘⇧⌫', 'delete']);
    } else if (target.type === 'run') {
      hints.push(['↵', 'open run']);
      hints.push(['⌘R', 'rename']);
    } else if (target.type === 'flow') {
      hints.push(['↵', 'run flow']);
      hints.push(['⌘↵', 'edit']);
    } else if (target.type === 'project' || target.type === 'workspace') {
      hints.push(['↵', 'new chat here']);
      if (explorePathFor(item, projects, workspaces)) hints.push(['⌘E', 'browse files']);
    } else {
      hints.push(['↵', 'run']);
    }
  }
  hints.push(['←→', 'filter']);
  hints.push(['⌥↑↓', 'section']);
  hints.push(['esc', 'close']);
  return (
    <div className="flex flex-wrap gap-3 border-t border-card px-5 py-2 text-[10px] text-ink-faint">
      {hints.map(([key, label]) => (
        <span key={key + label}>
          <kbd className="font-mono text-ink-muted">{key}</kbd> {label}
        </span>
      ))}
    </div>
  );
}

/// Root the ⌘E shortcut opens. Only places have one — a chat's cwd is
/// already reachable from the conversation itself.
function explorePathFor(
  item: PaletteItem,
  projects: { id: string; path: string }[],
  workspaces: { id: string; rootPath: string }[],
): string | null {
  if (item.target.type === 'project') {
    const id = item.target.projectId;
    return projects.find((p) => p.id === id)?.path ?? null;
  }
  if (item.target.type === 'workspace') {
    const id = item.target.workspaceId;
    return workspaces.find((w) => w.id === id)?.rootPath ?? null;
  }
  return null;
}

// -------------------------------------------------------------- commands

/// App actions offered alongside the content. Built from the live store so
/// the list reflects what's actually reachable — no "Debug" entry when
/// debug is off, no explorer entry with nothing to browse.
function usePaletteCommands({ showDebug }: { showDebug: boolean }): PaletteCommand[] {
  const projects = useStore((s) => s.projects);
  const focusedProjectId = useStore((s) => s.focusedProjectId);
  const selectedConversationId = useStore((s) => s.selectedConversationId);

  return useMemo(() => {
    const state = () => useStore.getState();
    const targetProjectId = (): UUID | null =>
      focusedProjectId ??
      (selectedConversationId
        ? (projects.find((p) => p.conversations.some((c) => c.id === selectedConversationId))?.id ??
          null)
        : null) ??
      projects[0]?.id ??
      null;
    const exploreRoot = (): string | null => {
      const s = state();
      if (selectedConversationId) {
        const path = findContainerPath(s, selectedConversationId);
        if (path) return path;
      }
      const id = targetProjectId();
      return projects.find((p) => p.id === id)?.path ?? null;
    };

    const list: PaletteCommand[] = [
      {
        id: 'chat.new',
        title: 'New conversation',
        subtitle: 'In the project you last worked in',
        keywords: ['start chat', 'compose', 'ask'],
        run: () => {
          const id = targetProjectId();
          if (id) state().startNewConversation(id);
        },
      },
      {
        id: 'project.add',
        title: 'Add project…',
        subtitle: 'Point Overcli at a repo on disk',
        keywords: ['open folder', 'repo', 'import'],
        run: () => void state().pickProject(),
      },
      {
        id: 'workspace.new',
        title: 'New workspace…',
        subtitle: 'Group several projects into one agent context',
        keywords: ['multi repo', 'group projects'],
        run: () => state().openSheet({ type: 'newWorkspace' }),
      },
      {
        id: 'flows.library',
        title: 'Flows library',
        subtitle: 'Browse and launch saved pipelines',
        keywords: ['pipelines', 'browse flows'],
        run: () => {
          useFlowsStore.getState().setLibrarySegment('flows');
          state().setDetailMode('flows');
        },
      },
      {
        id: 'flows.new',
        title: 'New flow…',
        subtitle: 'Author a multi-step pipeline',
        keywords: ['create pipeline', 'flow editor'],
        run: () => {
          useFlowsStore.getState().openEditor({ kind: 'new' });
          state().setDetailMode('flows');
        },
      },
      {
        id: 'flows.schedules',
        title: 'Schedules',
        subtitle: 'Flows that run on a timer',
        keywords: ['cron', 'recurring', 'scheduled'],
        run: () => {
          useFlowsStore.getState().setLibrarySegment('schedules');
          state().setDetailMode('flows');
        },
      },
      {
        id: 'view.orchestrator',
        title: 'Orchestrator',
        keywords: ['tasks', 'board', 'plan'],
        run: () => state().setDetailMode('orchestrator'),
      },
      {
        id: 'view.workers',
        title: 'Workers',
        subtitle: 'Standing personas that plan their own shifts',
        keywords: ['worker', 'persona', 'hire', 'standing', 'shift'],
        run: () => state().setDetailMode('workers'),
      },
      {
        id: 'view.local',
        title: 'Local models',
        keywords: ['ollama', 'offline', 'gpu'],
        run: () => state().setDetailMode('local'),
      },
      {
        id: 'view.stats',
        title: 'Usage & stats',
        keywords: ['cost', 'tokens', 'spend', 'analytics'],
        run: () => state().setDetailMode('stats'),
      },
      {
        id: 'view.sidebar',
        title: 'Toggle sidebar',
        keywords: ['hide panel', 'show panel'],
        run: () => state().toggleSidebar(),
      },
      {
        id: 'app.capabilities',
        title: 'Extensions & capabilities',
        keywords: ['mcp', 'skills', 'plugins', 'tools'],
        run: () => state().openSheet({ type: 'capabilities' }),
      },
      {
        id: 'app.cleanup',
        title: 'Cleanup conversations…',
        subtitle: 'Bulk archive or delete',
        keywords: ['bulk', 'archive all', 'prune', 'delete'],
        run: () => state().openSheet({ type: 'bulkConversationActions' }),
      },
      {
        id: 'app.settings',
        title: 'Settings…',
        keywords: ['preferences', 'theme', 'config', 'options'],
        run: () => state().openSheet({ type: 'settings' }),
      },
      {
        id: 'app.shortcuts',
        title: 'Keyboard shortcuts',
        keywords: ['keys', 'bindings', 'help'],
        run: () => state().openSheet({ type: 'shortcutsHelp' }),
      },
      {
        id: 'app.whatsNew',
        title: "What's new",
        keywords: ['release notes', 'changelog', 'updates'],
        run: () => state().openSheet({ type: 'whatsNew' }),
      },
      {
        id: 'app.about',
        title: 'About Overcli',
        keywords: ['version', 'credits'],
        run: () => state().openSheet({ type: 'about' }),
      },
    ];

    const root = exploreRoot();
    if (root) {
      list.splice(6, 0, {
        id: 'view.explorer',
        title: 'Browse files',
        subtitle: root,
        keywords: ['explorer', 'file tree', 'open folder'],
        run: () => state().openExplorer(root),
      });
    }
    if (showDebug) {
      list.push({
        id: 'app.debug',
        title: 'Debug',
        keywords: ['logs', 'internals', 'diagnostics'],
        run: () => state().openSheet({ type: 'debug' }),
      });
    }
    return list;
  }, [projects, focusedProjectId, selectedConversationId, showDebug]);
}

// --------------------------------------------------------------- glyphs

function SearchGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 flex-shrink-0 text-ink-faint" fill="none">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function ChatGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
      <path
        d="M2.5 4.2A1.7 1.7 0 014.2 2.5h7.6a1.7 1.7 0 011.7 1.7v4.6a1.7 1.7 0 01-1.7 1.7H7l-3 2.5v-2.5h-.2a1.3 1.3 0 01-1.3-1.3V4.2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
      <path
        d="M1.8 4.4A1 1 0 012.8 3.4h3l1.1 1.3h5.3a1 1 0 011 1v5.9a1 1 0 01-1 1h-9.4a1 1 0 01-1-1V4.4z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StackGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
      <path
        d="M8 2.2l5.5 2.8L8 7.8 2.5 5l5.5-2.8z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M2.5 8l5.5 2.8L13.5 8" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M2.5 11l5.5 2.8L13.5 11" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
