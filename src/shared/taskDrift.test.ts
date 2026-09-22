import { describe, expect, it } from 'vitest';

import { describeDrift, driftedTasks, taskDrift } from './taskDrift';
import type { ServiceBinding, ServiceRuntime, ServiceSpec } from './services';

const spec = (over: Partial<ServiceSpec> & { id: string }): ServiceSpec => ({
  name: over.id,
  command: ['run'],
  config: {},
  ...over,
} as ServiceSpec);

const done = (id: string, over: Partial<ServiceRuntime> = {}): ServiceRuntime => ({
  serviceId: id,
  status: 'done',
  ranRef: 'master',
  ranCommit: 'a'.repeat(40),
  ...over,
});

const bound = (serviceId: string, over: Partial<ServiceBinding> = {}): ServiceBinding => ({
  serviceId,
  ref: 'master',
  path: `/checkouts/${serviceId}`,
  head: 'a'.repeat(40),
  ...over,
});

describe('taskDrift', () => {
  it('says nothing about a task that ran from the commit still checked out', () => {
    expect(taskDrift(done('publish'), bound('publish'))).toBeNull();
  });

  it('catches the branch it was rebound to after it ran', () => {
    expect(taskDrift(done('publish'), bound('publish', { ref: 'feat/x' }))).toEqual({
      kind: 'branch',
      ran: 'master',
      now: 'feat/x',
    });
  });

  it('catches commits made on the same branch since it ran', () => {
    expect(taskDrift(done('publish'), bound('publish', { head: 'b'.repeat(40) }))).toEqual({
      kind: 'commit',
      ran: 'a'.repeat(40),
      now: 'b'.repeat(40),
    });
  });

  // The warning is worth having only if it can be checked. A task that ran
  // before overcli recorded commits knows its branch and nothing else.
  it('claims no commit drift when the run recorded no commit', () => {
    expect(taskDrift(done('publish', { ranCommit: undefined }), bound('publish', { head: 'b'.repeat(40) })))
      .toBeNull();
  });

  it('says nothing about a task that has not finished', () => {
    expect(taskDrift({ status: 'starting' }, bound('publish'))).toBeNull();
  });
});

describe('driftedTasks', () => {
  const api = spec({ id: 'api', projectId: 'p', deps: ['publish'] });
  const publish = spec({ id: 'publish', projectId: 'p', task: true });

  it('reports a dependency that published from an older commit', () => {
    const drifted = driftedTasks(
      api,
      [api, publish],
      [done('publish')],
      [bound('api'), bound('publish', { head: 'b'.repeat(40) })],
    );
    expect(drifted).toEqual([
      { task: publish, drift: { kind: 'commit', ran: 'a'.repeat(40), now: 'b'.repeat(40) } },
    ]);
  });

  // The task's own checkout is consistent — it is simply not the branch the
  // service that needs it is starting from.
  it('reports a dependency sitting on another branch of the same project', () => {
    const drifted = driftedTasks(
      api,
      [api, publish],
      [done('publish')],
      [bound('api', { ref: 'feat/x' }), bound('publish')],
    );
    expect(drifted).toEqual([{ task: publish, drift: { kind: 'elsewhere', ran: 'master', now: 'feat/x' } }]);
  });

  it('leaves a task in another project alone, refs being its own business', () => {
    const elsewhere = spec({ id: 'publish', projectId: 'other', task: true });
    expect(
      driftedTasks(
        api,
        [api, elsewhere],
        [done('publish')],
        [bound('api', { ref: 'feat/x' }), bound('publish')],
      ),
    ).toEqual([]);
  });

  it('says nothing about a dependency that is not a task', () => {
    const db = spec({ id: 'publish', projectId: 'p' });
    expect(driftedTasks(api, [api, db], [{ serviceId: 'publish', status: 'ready' }], [bound('api'), bound('publish')]))
      .toEqual([]);
  });

  // Silence about a thing nobody checked reads as a pass. Runs survive a
  // restart, so `stopped` here means never — not "not since you reopened it".
  it('says so when nothing it ran installed what is there', () => {
    expect(
      driftedTasks(
        api,
        [api, publish],
        [{ serviceId: 'publish', status: 'stopped' }],
        [bound('api'), bound('publish')],
      ),
    ).toEqual([{ task: publish, drift: { kind: 'unknown' } }]);
  });
});

describe('describeDrift', () => {
  it('says what it does not know, rather than nothing', () => {
    expect(describeDrift('common-publish', { kind: 'unknown' }))
      .toBe('common-publish has not run here, so what it installs came from somewhere else');
  });

  it('names the branch a task ran from and the one this starts from', () => {
    expect(describeDrift('common-publish', { kind: 'elsewhere', ran: 'master', now: 'feat/x' }))
      .toBe('common-publish last ran from master; this starts from feat/x');
  });

  it('shortens commits, which is all anyone reads of them', () => {
    expect(describeDrift('common-publish', { kind: 'commit', ran: 'a'.repeat(40), now: 'b'.repeat(40) }))
      .toBe('common-publish last ran from aaaaaaa; bbbbbbb is checked out now');
  });
});
