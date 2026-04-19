import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { Conversation, UUID } from '@shared/types';
import { SheetActionButton } from './SettingsSheet';
import { isAgentConversation } from '../Sidebar';

export function ArchiveAllSheet({ projectId }: { projectId: UUID }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const runners = useStore((s) => s.runners);
  const selectedId = useStore((s) => s.selectedConversationId);
  const archiveInactiveInProject = useStore((s) => s.archiveInactiveInProject);
  const openSheet = useStore((s) => s.openSheet);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { targets, skipped } = useMemo(() => {
    const targets: Conversation[] = [];
    const skipped: Array<{ conv: Conversation; reason: string }> = [];
    for (const c of project?.conversations ?? []) {
      if (c.hidden) continue;
      if (c.id === selectedId) {
        skipped.push({ conv: c, reason: 'open' });
        continue;
      }
      if (runners[c.id]?.isRunning) {
        skipped.push({ conv: c, reason: 'running' });
        continue;
      }
      targets.push(c);
    }
    return { targets, skipped };
  }, [project, selectedId, runners]);

  if (!project) return null;

  const agentCount = targets.filter(isAgentConversation).length;
  const plainCount = targets.length - agentCount;

  const doArchive = async () => {
    setWorking(true);
    setError(null);
    try {
      await archiveInactiveInProject(projectId);
      openSheet(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWorking(false);
    }
  };

  return (
    <div className="flex flex-col p-5 gap-4 max-h-[80vh] overflow-y-auto">
      <div>
        <div className="text-lg font-semibold">Archive inactive conversations</div>
        <div className="text-xs text-ink-faint">
          Hides conversations in <span className="text-ink-muted">{project.name}</span> from the sidebar.
          You can restore them later from the Archived section. Agent worktrees and branches are left untouched.
        </div>
      </div>

      <div className="flex flex-col gap-2 border border-card rounded-lg p-3 bg-surface-muted">
        <div className="text-[10px] uppercase tracking-wider text-ink-faint">Summary</div>
        {targets.length === 0 ? (
          <div className="text-xs text-ink-faint">Nothing to archive.</div>
        ) : (
          <div className="text-xs text-ink-muted">
            Will archive <span className="text-ink font-medium">{targets.length}</span>{' '}
            conversation{targets.length === 1 ? '' : 's'}
            {agentCount > 0 && (
              <>
                {' '}· <span className="text-ink">{plainCount}</span> regular,{' '}
                <span className="text-ink">{agentCount}</span> agent
                {agentCount === 1 ? '' : 's'}
              </>
            )}
            .
          </div>
        )}
        {skipped.length > 0 && (
          <div className="text-[11px] text-ink-faint">
            Keeping{' '}
            {skipped.map((s, i) => (
              <span key={s.conv.id}>
                {i > 0 && ', '}
                <span className="text-ink-muted">{s.conv.name}</span>{' '}
                <span className="text-ink-faint">({s.reason})</span>
              </span>
            ))}
            .
          </div>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 mt-1">
        <SheetActionButton label="Cancel" onClick={() => openSheet(null)} disabled={working} />
        <SheetActionButton
          primary
          label={working ? 'Archiving…' : `Archive ${targets.length || ''}`.trim()}
          onClick={() => void doArchive()}
          disabled={working || targets.length === 0}
        />
      </div>
    </div>
  );
}
