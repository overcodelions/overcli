import { describe, it, expect } from 'vitest';
import {
  flowMatchesQuery,
  flowTagCounts,
  groupFlows,
  installedRegistryKeys,
  registryEntryMatchesQuery,
} from './flowGrouping';
import type { Flow } from '@shared/flows/schema';

function flow(over: Partial<Flow> & { id: string }): Flow {
  return {
    name: over.id,
    input: 'user_prompt',
    participants: [],
    steps: [{ id: 'plan' }, { id: 'build' }] as Flow['steps'],
    source: 'user',
    filePath: `/u/flows/${over.id}.yaml`,
    ...over,
  };
}

describe('flowMatchesQuery', () => {
  const f = flow({ id: 'ticket-triage', name: 'Jira ticket triage', description: 'Pull a ticket and plan', tags: ['triage', 'tickets'] });

  it('matches on name, description, tag, and step id', () => {
    expect(flowMatchesQuery(f, 'jira')).toBe(true);
    expect(flowMatchesQuery(f, 'plan a')).toBe(true); // description words, any order
    expect(flowMatchesQuery(f, 'tickets')).toBe(true);
    expect(flowMatchesQuery(f, 'build')).toBe(true); // step id
    expect(flowMatchesQuery(f, 'kubernetes')).toBe(false);
  });

  it('requires every term, not just one', () => {
    expect(flowMatchesQuery(f, 'jira triage')).toBe(true);
    expect(flowMatchesQuery(f, 'jira kubernetes')).toBe(false);
  });

  it('treats an empty or whitespace query as "everything"', () => {
    expect(flowMatchesQuery(f, '')).toBe(true);
    expect(flowMatchesQuery(f, '   ')).toBe(true);
  });
});

describe('groupFlows', () => {
  const mine = flow({ id: 'my-flow' });
  const installedFlow = flow({ id: 'installed-public-solve-ticket' });
  const projectFlow = flow({ id: 'repo-flow', source: 'project', filePath: '/p/.overcli/flows/repo-flow.yaml' });
  const installed = [{ filename: 'installed-public-solve-ticket.yaml' }];

  it('splits by provenance so hand-built flows are not buried', () => {
    const groups = groupFlows([installedFlow, mine, projectFlow], { starred: [], installed });
    expect(groups.map((g) => g.key)).toEqual(['mine', 'project', 'installed']);
    expect(groups[0].flows.map((f) => f.id)).toEqual(['my-flow']);
    expect(groups[2].flows.map((f) => f.id)).toEqual(['installed-public-solve-ticket']);
  });

  it('promotes starred flows out of their origin group, not into a duplicate', () => {
    const groups = groupFlows([mine, installedFlow], {
      starred: ['user:installed-public-solve-ticket'],
      installed,
    });
    expect(groups.map((g) => g.key)).toEqual(['starred', 'mine']);
    expect(groups[0].flows.map((f) => f.id)).toEqual(['installed-public-solve-ticket']);
    // Exactly once overall.
    expect(groups.flatMap((g) => g.flows).filter((f) => f.id === installedFlow.id)).toHaveLength(1);
  });

  it('drops empty groups rather than rendering bare headings', () => {
    expect(groupFlows([mine], { starred: [], installed: undefined }).map((g) => g.key)).toEqual(['mine']);
    expect(groupFlows([], { starred: [], installed })).toEqual([]);
  });

  it('applies the query and tag filters before grouping', () => {
    const tagged = flow({ id: 'design-doc', tags: ['design'] });
    const all = [mine, tagged];
    expect(groupFlows(all, { starred: [], installed, query: 'design' })[0].flows.map((f) => f.id))
      .toEqual(['design-doc']);
    expect(groupFlows(all, { starred: [], installed, tags: new Set(['design']) })[0].flows.map((f) => f.id))
      .toEqual(['design-doc']);
    expect(groupFlows(all, { starred: [], installed, tags: new Set(['design', 'ops']) })).toEqual([]);
  });

  it('treats a user and a project flow of the same id as distinct entries', () => {
    const userCopy = flow({ id: 'repo-flow' });
    const groups = groupFlows([userCopy, projectFlow], { starred: [], installed: undefined });
    expect(groups.flatMap((g) => g.flows)).toHaveLength(2);
  });
});

describe('registryEntryMatchesQuery', () => {
  const entry = {
    id: 'solve-ticket',
    name: 'Solve a ticket end-to-end',
    description: 'Fetches a Jira ticket and plans',
    tags: ['tickets', 'implementation'],
  };

  it('matches the same fields a local flow search would', () => {
    expect(registryEntryMatchesQuery(entry, 'jira')).toBe(true);
    expect(registryEntryMatchesQuery(entry, 'tickets')).toBe(true);
    expect(registryEntryMatchesQuery(entry, 'solve-ticket')).toBe(true);
    expect(registryEntryMatchesQuery(entry, 'zendesk')).toBe(false);
  });

  it('handles entries with no description or tags', () => {
    expect(registryEntryMatchesQuery({ id: 'x', name: 'Bare' }, 'bare')).toBe(true);
    expect(registryEntryMatchesQuery({ id: 'x', name: 'Bare' }, 'nope')).toBe(false);
  });
});

describe('installedRegistryKeys', () => {
  const entry = { filename: 'installed-public-solve.yaml', registryId: 'public', id: 'solve' };
  const onDisk = flow({ id: 'installed-public-solve' });

  it('reports a registry flow as installed when its file is loaded', () => {
    expect([...installedRegistryKeys([onDisk], [entry])]).toEqual(['public:solve']);
  });

  it('ignores bookkeeping for a flow that is no longer on disk', () => {
    // Deleted outside the app, or a settings file restored from backup.
    // Claiming it is installed would hide it from search — exactly when
    // the user wants to reinstall it.
    expect([...installedRegistryKeys([], [entry])]).toEqual([]);
    expect([...installedRegistryKeys([flow({ id: 'unrelated' })], [entry])]).toEqual([]);
  });

  it('handles missing settings', () => {
    expect([...installedRegistryKeys([onDisk], undefined)]).toEqual([]);
  });
});

describe('flowTagCounts', () => {
  it('counts tag usage across the local library', () => {
    const counts = flowTagCounts([
      flow({ id: 'a', tags: ['review', 'prs'] }),
      flow({ id: 'b', tags: ['review'] }),
      flow({ id: 'c' }),
    ]);
    expect(counts.get('review')).toBe(2);
    expect(counts.get('prs')).toBe(1);
    expect(counts.has('missing')).toBe(false);
  });
});
