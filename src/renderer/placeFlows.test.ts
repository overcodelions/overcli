import { describe, it, expect } from 'vitest';
import type { Flow } from '@shared/flows/schema';
import { starredFlowsForPlace } from './placeFlows';

const flow = (id: string, over: Partial<Flow> = {}): Flow =>
  ({ id, name: id, source: 'user', filePath: `/lib/${id}.yaml`, ...over }) as Flow;

const repo = { folders: ['/code/overcli'], everyday: false };

describe('starredFlowsForPlace', () => {
  it('offers only starred flows, by name', () => {
    const flows = [flow('review'), flow('bugfix'), flow('docs')];
    const got = starredFlowsForPlace(flows, ['user:review', 'user:bugfix'], repo);
    expect(got.map((f) => f.id)).toEqual(['bugfix', 'review']);
  });

  it('keeps a project flow to its own folder', () => {
    const here = flow('here', { source: 'project', filePath: '/code/overcli/.overcli/flows/here.yaml' });
    const there = flow('there', { source: 'project', filePath: '/code/overdb/.overcli/flows/there.yaml' });
    // A sibling whose name only starts the same must not count as inside.
    const lookalike = flow('lookalike', { source: 'project', filePath: '/code/overcli-old/f.yaml' });
    const got = starredFlowsForPlace([here, there, lookalike], ['project:here', 'project:there', 'project:lookalike'], repo);
    expect(got.map((f) => f.id)).toEqual(['here']);
  });

  it('matches a project flow in any workspace member', () => {
    const f = flow('m', { source: 'project', filePath: '/code/overdb/flows/m.yaml' });
    const ws = { folders: ['/code/ws', '/code/overcli', '/code/overdb'], everyday: false };
    expect(starredFlowsForPlace([f], ['project:m'], ws)).toHaveLength(1);
  });

  it('skips archived and generated flows', () => {
    const flows = [flow('old', { archived: true }), flow('gen', { source: 'generated' })];
    expect(starredFlowsForPlace(flows, ['user:old', 'generated:gen'], repo)).toEqual([]);
  });

  it('offers a documents folder only the flows tagged for it', () => {
    const docs = { folders: ['/notes'], everyday: true };
    const flows = [flow('pr-review'), flow('brief', { tags: ['Documents'] })];
    expect(starredFlowsForPlace(flows, ['user:pr-review', 'user:brief'], docs).map((f) => f.id)).toEqual(['brief']);
  });

  it('caps the list', () => {
    const flows = ['a', 'b', 'c', 'd'].map((id) => flow(id));
    expect(starredFlowsForPlace(flows, flows.map((f) => `user:${f.id}`), repo)).toHaveLength(3);
  });
});
