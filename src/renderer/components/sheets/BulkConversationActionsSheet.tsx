import { useEffect, useMemo, useState } from 'react';
import { Conversation, UUID } from '@shared/types';
import { useStore } from '../../store';
import { useAllRunners } from '../../runnersStore';
import { SheetActionButton } from './SettingsSheet';
import { isAgentConversation } from '../Sidebar';
import {
  BulkEntry,
  BulkScope,
  filterBulkEntries,
  planBulkDelete,
  summarizeBulkSelection,
} from './bulkConversationActions';

export function BulkConversationActionsSheet() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const runners = useAllRunners();
  const setConversationHidden = useStore((s) => s.setConversationHidden);
  const removeConversation = useStore((s) => s.removeConversation);
  const removeAgent = useStore((s) => s.removeAgent);
  const openSheet = useStore((s) => s.openSheet);

  const [scope, setScope] = useState<BulkScope>('all');
  const [projectFilter, setProjectFilter] = useState<'all' | UUID>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<UUID>>(new Set());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const entries = useMemo(() => {
    const out: BulkEntry[] = [];
    for (const p of projects) {
      for (const conv of p.conversations) {
        out.push({
          conv,
          ownerType: 'project',
          ownerId: p.id,
          ownerName: p.name,
          ownerPath: p.path,
        });
      }
    }
    for (const w of workspaces) {
      for (const conv of w.conversations ?? []) {
        out.push({
          conv,
          ownerType: 'workspace',
          ownerId: w.id,
          ownerName: w.name,
          ownerPath: w.rootPath,
        });
      }
    }
    return out;
  }, [projects, workspaces]);

  const entryById = useMemo(() => {
    const out = new Map<UUID, BulkEntry>();
    for (const e of entries) out.set(e.conv.id, e);
    return out;
  }, [entries]);

  useEffect(() => {
    setSelected((cur) => {
      const next = new Set<UUID>();
      for (const id of cur) {
        if (entryById.has(id)) next.add(id);
      }
      return next.size === cur.size ? cur : next;
    });
  }, [entryById]);

  const filtered = useMemo(
    () => filterBulkEntries(entries, { scope, projectFilter, query }),
    [entries, projectFilter, query, scope],
  );

  const allVisibleSelected = filtered.length > 0 && filtered.every((e) => selected.has(e.conv.id));

  const selectedEntries = useMemo(
    () => [...selected].map((id) => entryById.get(id)).filter((e): e is BulkEntry => e != null),
    [selected, entryById],
  );

  const runningById = useMemo(() => {
    const out: Record<UUID, boolean> = {};
    for (const id of Object.keys(runners)) {
      out[id] = runners[id]?.isRunning ?? false;
    }
    return out;
  }, [runners]);

  const summary = useMemo(
    () => summarizeBulkSelection(selectedEntries, runningById, isAgentConversation),
    [selectedEntries, runningById],
  );

  const toggleOne = (id: UUID, checked: boolean) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleVisible = (checked: boolean) => {
    setSelected((cur) => {
      const next = new Set(cur);
      for (const e of filtered) {
        if (checked) next.add(e.conv.id);
        else next.delete(e.conv.id);
      }
      return next;
    });
  };

  const archiveSelected = async () => {
    setWorking(true);
    setError(null);
    try {
      for (const e of summary.active) {
        if (runningById[e.conv.id] ?? false) continue;
        await setConversationHidden(e.conv.id, true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const unarchiveSelected = async () => {
    setWorking(true);
    setError(null);
    try {
      for (const e of summary.archived) {
        if (runningById[e.conv.id] ?? false) continue;
        await setConversationHidden(e.conv.id, false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const deleteSelected = async () => {
    const plan = planBulkDelete(selectedEntries, runningById, isAgentConversation);
    if (plan.removeAgentIds.length + plan.removeConversationIds.length === 0) return;
    const plainCount = plan.removeConversationIds.length;
    const confirmMessage = [
      `Delete ${plan.removeAgentIds.length + plan.removeConversationIds.length} selected conversation${plan.removeAgentIds.length + plan.removeConversationIds.length === 1 ? '' : 's'}?`,
      plan.removeAgentIds.length
        ? `${plan.removeAgentIds.length} agent${plan.removeAgentIds.length === 1 ? '' : 's'} will remove worktrees/branches.`
        : '',
      plainCount
        ? `${plainCount} regular conversation${plainCount === 1 ? '' : 's'} will be removed.`
        : '',
      plan.skipRunning.length
        ? `${plan.skipRunning.length} running conversation${plan.skipRunning.length === 1 ? '' : 's'} will be skipped.`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (!window.confirm(confirmMessage)) return;

    setWorking(true);
    setError(null);
    try {
      const warnings: string[] = [];
      for (const id of plan.removeAgentIds) {
        const res = await removeAgent(id);
        if (!res.ok && res.error) warnings.push(`${entryById.get(id)?.conv.name ?? id}: ${res.error}`);
      }
      for (const id of plan.removeConversationIds) {
        await removeConversation(id);
      }
      setSelected(new Set());
      if (warnings.length > 0) setError(`Removed with warnings: ${warnings.join('; ')}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="flex flex-col w-full h-[min(760px,88vh)]">
      <div className="px-5 pt-4 pb-3 border-b border-card">
        <div className="text-lg font-semibold">Bulk Conversation Actions</div>
        <div className="text-xs text-ink-faint mt-1">
          Select conversations and agents across projects, workspaces, and archive. Agent delete removes worktrees and branches.
        </div>
      </div>

      <div className="px-5 py-3 border-b border-card flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations, owner, or path"
          className="field px-2 py-1 text-xs flex-1 min-w-0"
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as BulkScope)}
          className="field px-2 py-1 text-xs w-[140px]"
        >
          <option value="all">All</option>
          <option value="projects">Projects</option>
          <option value="workspaces">Workspaces</option>
          <option value="archived">Archived</option>
        </select>
        <select
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value as UUID | 'all')}
          className="field px-2 py-1 text-xs w-[190px]"
        >
          <option value="all">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="px-5 py-2 border-b border-card text-xs text-ink-muted flex items-center gap-2">
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            onChange={(e) => toggleVisible(e.target.checked)}
            className="h-3.5 w-3.5 accent-accent"
          />
          Select visible ({filtered.length})
        </label>
        <span className="text-ink-faint">|</span>
        <span>{summary.total} selected</span>
        {summary.running.length > 0 && (
          <>
            <span className="text-ink-faint">|</span>
            <span>{summary.running.length} running (skipped for delete)</span>
          </>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-2">
        {filtered.length === 0 ? (
          <div className="text-xs text-ink-faint py-3">No conversations match the current filters.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {filtered.map((e) => {
              const running = runners[e.conv.id]?.isRunning ?? false;
              const isAgent = isAgentConversation(e.conv);
              return (
                <label
                  key={e.conv.id}
                  className="flex items-center gap-2 rounded border border-card px-2 py-1.5 text-xs hover:bg-card-strong"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(e.conv.id)}
                    onChange={(ev) => toggleOne(e.conv.id, ev.target.checked)}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-ink truncate">{e.conv.name}</div>
                    <div className="text-[10px] text-ink-faint truncate">
                      {e.ownerType === 'project' ? 'Project' : 'Workspace'}: {e.ownerName} • {e.ownerPath}
                    </div>
                  </div>
                  {e.conv.hidden && <span className="text-[10px] text-ink-faint">archived</span>}
                  {isAgent && <span className="text-[10px] text-amber-300">agent</span>}
                  {running && <span className="text-[10px] text-emerald-300">running</span>}
                </label>
              );
            })}
          </div>
        )}
      </div>

      {error && (
        <div className="mx-5 mb-2 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
          {error}
        </div>
      )}

      <div className="px-5 py-3 border-t border-card flex items-center gap-2">
        <SheetActionButton
          label={working ? 'Archiving…' : `Archive ${summary.active.length || ''}`.trim()}
          onClick={() => void archiveSelected()}
          disabled={working || summary.active.length === 0}
        />
        <SheetActionButton
          label={working ? 'Restoring…' : `Unarchive ${summary.archived.length || ''}`.trim()}
          onClick={() => void unarchiveSelected()}
          disabled={working || summary.archived.length === 0}
        />
        <SheetActionButton
          label={working ? 'Deleting…' : `Delete ${summary.deletable.length || ''}`.trim()}
          onClick={() => void deleteSelected()}
          disabled={working || summary.deletable.length === 0}
        />
        <div className="ml-auto flex gap-2">
          <SheetActionButton
            label="Clear selection"
            onClick={() => setSelected(new Set())}
            disabled={working || summary.total === 0}
          />
          <SheetActionButton label="Close" onClick={() => openSheet(null)} disabled={working} />
        </div>
      </div>
    </div>
  );
}
