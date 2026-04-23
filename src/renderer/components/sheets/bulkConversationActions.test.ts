import { describe, expect, it } from 'vitest';
import { Conversation } from '@shared/types';
import {
  BulkEntry,
  filterBulkEntries,
  planBulkDelete,
  summarizeBulkSelection,
} from './bulkConversationActions';

function conv(id: string, name: string, opts?: { hidden?: boolean; agent?: boolean }): Conversation {
  return {
    id,
    name,
    createdAt: 1,
    totalCostUSD: 0,
    turnCount: 0,
    currentModel: '',
    permissionMode: 'default',
    hidden: opts?.hidden,
    worktreePath: opts?.agent ? `C:/wt/${id}` : undefined,
    branchName: opts?.agent ? `agent/${id}` : undefined,
  };
}

function entry(
  c: Conversation,
  ownerType: 'project' | 'workspace',
  ownerId: string,
  ownerName: string,
): BulkEntry {
  return {
    conv: c,
    ownerType,
    ownerId,
    ownerName,
    ownerPath: `C:/${ownerName}`,
  };
}

describe('filterBulkEntries', () => {
  const p1 = entry(conv('c1', 'Alpha task'), 'project', 'p1', 'Project One');
  const p2 = entry(conv('c2', 'Beta task', { hidden: true }), 'project', 'p2', 'Project Two');
  const w1 = entry(conv('c3', 'Workspace task'), 'workspace', 'w1', 'Workspace One');
  const entries = [p1, p2, w1];

  it('filters by project id and excludes workspace rows', () => {
    const out = filterBulkEntries(entries, {
      scope: 'all',
      projectFilter: 'p1',
      query: '',
    });
    expect(out.map((x) => x.conv.id)).toEqual(['c1']);
  });

  it('returns only archived rows in archived scope', () => {
    const out = filterBulkEntries(entries, {
      scope: 'archived',
      projectFilter: 'all',
      query: '',
    });
    expect(out.map((x) => x.conv.id)).toEqual(['c2']);
  });
});

describe('selection planning', () => {
  const plain = entry(conv('plain', 'Plain'), 'project', 'p1', 'Project One');
  const agent = entry(conv('agent', 'Agent', { agent: true }), 'project', 'p1', 'Project One');
  const archived = entry(conv('arch', 'Archived', { hidden: true }), 'workspace', 'w1', 'Workspace One');
  const selected = [plain, agent, archived];
  const isAgent = (c: Conversation) => !!c.worktreePath;

  it('summarizes active/archived/running and agent deletables', () => {
    const summary = summarizeBulkSelection(selected, { plain: false, agent: true, arch: false }, isAgent);
    expect(summary.total).toBe(3);
    expect(summary.running.map((x) => x.conv.id)).toEqual(['agent']);
    expect(summary.archived.map((x) => x.conv.id)).toEqual(['arch']);
    expect(summary.deletable.map((x) => x.conv.id)).toEqual(['plain', 'arch']);
    expect(summary.deletableAgents.map((x) => x.conv.id)).toEqual([]);
  });

  it('plans delete routing: agents -> removeAgent, plain -> removeConversation, running skipped', () => {
    const plan = planBulkDelete(selected, { plain: false, agent: false, arch: true }, isAgent);
    expect(plan.skipRunning.map((x) => x.conv.id)).toEqual(['arch']);
    expect(plan.removeAgentIds).toEqual(['agent']);
    expect(plan.removeConversationIds).toEqual(['plain']);
  });
});
