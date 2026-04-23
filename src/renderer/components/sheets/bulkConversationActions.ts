import { Conversation, UUID } from '@shared/types';

export type BulkScope = 'all' | 'projects' | 'workspaces' | 'archived';

export interface BulkEntry {
  conv: Conversation;
  ownerType: 'project' | 'workspace';
  ownerId: UUID;
  ownerName: string;
  ownerPath: string;
}

export interface FilterArgs {
  scope: BulkScope;
  projectFilter: 'all' | UUID;
  query: string;
}

export function filterBulkEntries(entries: BulkEntry[], args: FilterArgs): BulkEntry[] {
  const q = args.query.trim().toLowerCase();
  return entries.filter((e) => {
    if (args.scope === 'projects' && e.ownerType !== 'project') return false;
    if (args.scope === 'workspaces' && e.ownerType !== 'workspace') return false;
    if (args.scope === 'archived' && !e.conv.hidden) return false;
    if (args.projectFilter !== 'all' && (e.ownerType !== 'project' || e.ownerId !== args.projectFilter)) {
      return false;
    }
    if (!q) return true;
    return (
      e.conv.name.toLowerCase().includes(q) ||
      (e.conv.sessionId ?? '').toLowerCase().includes(q) ||
      e.ownerName.toLowerCase().includes(q) ||
      e.ownerPath.toLowerCase().includes(q)
    );
  });
}

export interface SelectionSummary {
  total: number;
  running: BulkEntry[];
  archived: BulkEntry[];
  active: BulkEntry[];
  deletable: BulkEntry[];
  deletableAgents: BulkEntry[];
}

export function summarizeBulkSelection(
  selectedEntries: BulkEntry[],
  isRunningById: Record<UUID, boolean>,
  isAgent: (conv: Conversation) => boolean,
): SelectionSummary {
  const running = selectedEntries.filter((e) => isRunningById[e.conv.id] ?? false);
  const archived = selectedEntries.filter((e) => !!e.conv.hidden);
  const active = selectedEntries.filter((e) => !e.conv.hidden);
  const deletable = selectedEntries.filter((e) => !(isRunningById[e.conv.id] ?? false));
  const deletableAgents = deletable.filter((e) => isAgent(e.conv));
  return {
    total: selectedEntries.length,
    running,
    archived,
    active,
    deletable,
    deletableAgents,
  };
}

export interface DeletePlan {
  skipRunning: BulkEntry[];
  removeAgentIds: UUID[];
  removeConversationIds: UUID[];
}

export function planBulkDelete(
  selectedEntries: BulkEntry[],
  isRunningById: Record<UUID, boolean>,
  isAgent: (conv: Conversation) => boolean,
): DeletePlan {
  const skipRunning: BulkEntry[] = [];
  const removeAgentIds: UUID[] = [];
  const removeConversationIds: UUID[] = [];
  for (const e of selectedEntries) {
    if (isRunningById[e.conv.id] ?? false) {
      skipRunning.push(e);
      continue;
    }
    if (isAgent(e.conv)) removeAgentIds.push(e.conv.id);
    else removeConversationIds.push(e.conv.id);
  }
  return { skipRunning, removeAgentIds, removeConversationIds };
}
