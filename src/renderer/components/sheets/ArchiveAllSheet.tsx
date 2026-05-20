import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { useFlowsStore } from '../../flowsStore';
import { useAllRunners } from '../../runnersStore';
import { Conversation, UUID } from '@shared/types';
import type { FlowRun } from '@shared/flows/schema';
import { flowRunOwnerPath } from '@shared/flows/schema';
import { SheetActionButton } from './SettingsSheet';
import { isAgentConversation } from '../Sidebar';

type Props =
  | { projectId: UUID; workspaceId?: undefined }
  | { workspaceId: UUID; projectId?: undefined };

export function ArchiveAllSheet(props: Props) {
  const project = useStore((s) =>
    props.projectId ? s.projects.find((p) => p.id === props.projectId) : undefined,
  );
  const workspace = useStore((s) =>
    props.workspaceId ? s.workspaces.find((w) => w.id === props.workspaceId) : undefined,
  );
  const runners = useAllRunners();
  const selectedId = useStore((s) => s.selectedConversationId);
  const archiveInactiveInProject = useStore((s) => s.archiveInactiveInProject);
  const archiveInactiveInWorkspace = useStore((s) => s.archiveInactiveInWorkspace);
  const flowRuns = useFlowsStore((s) => s.runs);
  const removeFlowRun = useFlowsStore((s) => s.removeRun);
  const openSheet = useStore((s) => s.openSheet);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const owner = project ?? workspace;
  const ownerLabel = project ? 'project' : 'workspace';
  const conversations = project?.conversations ?? workspace?.conversations ?? [];
  const ownerPath = project?.path ?? workspace?.rootPath;

  const { targets, skipped } = useMemo(() => {
    const targets: Conversation[] = [];
    const skipped: Array<{ conv: Conversation; reason: string }> = [];
    for (const c of conversations) {
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
  }, [conversations, selectedId, runners]);

  /// Flow runs in this project/workspace that are safe to delete.
  /// "Safe" mirrors the conversation rule: skip anything still doing
  /// work (running, paused, or with a participant conv currently
  /// streaming from a hijack chat).
  const { flowTargets, flowSkipped } = useMemo(() => {
    const flowTargets: FlowRun[] = [];
    const flowSkipped: Array<{ run: FlowRun; reason: string }> = [];
    if (!ownerPath) return { flowTargets, flowSkipped };
    for (const run of Object.values(flowRuns)) {
      if (flowRunOwnerPath(run) !== ownerPath) continue;
      if (run.state.kind === 'running') {
        flowSkipped.push({ run, reason: 'running' });
        continue;
      }
      if (run.state.kind === 'paused') {
        flowSkipped.push({ run, reason: 'paused' });
        continue;
      }
      const isLive = Object.values(run.conversationIds).some(
        (cid) => runners[cid]?.isRunning,
      );
      if (isLive) {
        flowSkipped.push({ run, reason: 'responding' });
        continue;
      }
      flowTargets.push(run);
    }
    return { flowTargets, flowSkipped };
  }, [flowRuns, ownerPath, runners]);

  if (!owner) return null;

  const agentCount = targets.filter(isAgentConversation).length;
  const plainCount = targets.length - agentCount;
  const totalToProcess = targets.length + flowTargets.length;

  const doArchive = async () => {
    setWorking(true);
    setError(null);
    try {
      if (props.projectId !== undefined) {
        await archiveInactiveInProject(props.projectId);
      } else {
        await archiveInactiveInWorkspace(props.workspaceId);
      }
      for (const run of flowTargets) {
        const result = await window.overcli.invoke('flows:deleteRun', { runId: run.id });
        if (result.ok) removeFlowRun(run.id);
      }
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
          Hides conversations in the {ownerLabel}{' '}
          <span className="text-ink-muted">{owner.name}</span> from the sidebar.
          You can restore them later from the Archived section. Agent worktrees and branches are left untouched.
          Finished flow runs in this {ownerLabel} are deleted (flow runs don't support unarchive).
        </div>
      </div>

      <div className="flex flex-col gap-2 border border-card rounded-lg p-3 bg-surface-muted">
        <div className="text-[10px] uppercase tracking-wider text-ink-faint">Summary</div>
        {totalToProcess === 0 ? (
          <div className="text-xs text-ink-faint">Nothing to archive.</div>
        ) : (
          <div className="text-xs text-ink-muted">
            {targets.length > 0 && (
              <>
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
              </>
            )}
            {flowTargets.length > 0 && (
              <>
                {targets.length > 0 && ' '}
                Will delete <span className="text-ink font-medium">{flowTargets.length}</span>{' '}
                flow run{flowTargets.length === 1 ? '' : 's'}.
              </>
            )}
          </div>
        )}
        {(skipped.length > 0 || flowSkipped.length > 0) && (
          <div className="text-[11px] text-ink-faint">
            Keeping{' '}
            {skipped.map((s, i) => (
              <span key={s.conv.id}>
                {i > 0 && ', '}
                <span className="text-ink-muted">{s.conv.name}</span>{' '}
                <span className="text-ink-faint">({s.reason})</span>
              </span>
            ))}
            {skipped.length > 0 && flowSkipped.length > 0 && ', '}
            {flowSkipped.map((s, i) => (
              <span key={s.run.id}>
                {i > 0 && ', '}
                <span className="text-ink-muted">{s.run.flowSnapshot.name}</span>{' '}
                <span className="text-ink-faint">(flow · {s.reason})</span>
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
          label={working ? 'Archiving…' : `Archive ${totalToProcess || ''}`.trim()}
          onClick={() => void doArchive()}
          disabled={working || totalToProcess === 0}
        />
      </div>
    </div>
  );
}
