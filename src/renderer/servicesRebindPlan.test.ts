import { describe, expect, it } from 'vitest';
import { bulkRefOptions, handoffOffer, planBulkRebind, planChangedFilesRebind, planPinRebind } from './servicesRebindPlan';
import type { ServiceSpec } from '@shared/services';
import type { WorktreeChoice } from './worktreeChoices';

function spec(over: Partial<ServiceSpec> & { id: string }): ServiceSpec {
  return {
    name: over.id,
    runner: 'command',
    command: ['true'],
    ready: { kind: 'none' },
    selfReloads: false,
    config: {},
    ...over,
  };
}

function choice(ref: string, path: string): WorktreeChoice {
  return { ref, path, primary: ref === 'master', detached: false };
}

const services = [
  spec({ id: 'api' }),
  spec({ id: 'web' }),
  spec({ id: 'security', pinnedRef: 'master' }),
];

const choices = {
  api: [choice('master', '/repos/api'), choice('feat/x', '/wt/api-x')],
  web: [choice('master', '/repos/web'), choice('feat/x', '/wt/web-x')],
  security: [choice('master', '/repos/security')],
};

const onMaster = { api: 'master', web: 'master', security: 'master' };

describe('planBulkRebind', () => {
  it('resolves the branch to each service’s own checkout', () => {
    // The same ref is a different directory in every repo.
    const plan = planBulkRebind(services, choices, onMaster, 'feat/x');
    expect(plan.targets).toEqual([
      { serviceId: 'api', ref: 'feat/x', path: '/wt/api-x' },
      { serviceId: 'web', ref: 'feat/x', path: '/wt/web-x' },
    ]);
  });

  it('leaves a pinned service where it is', () => {
    const plan = planBulkRebind(services, choices, onMaster, 'feat/x');
    expect(plan.skipped).toContainEqual({ serviceId: 'security', reason: 'pinned' });
  });

  it('moves a pinned service to the ref it is pinned to', () => {
    // A pin refuses a move somewhere ELSE; going where the pin points is what
    // it asked for. Refusing that stranded any service whose pin had been
    // written without its move landing — every later attempt planned the move
    // and then skipped it, so it could never come back.
    const stranded = [spec({ id: 'security', pinnedRef: 'master' })];
    const plan = planBulkRebind(stranded, choices, { security: 'feat/x' }, 'master');
    expect(plan.skipped).toEqual([]);
    expect(plan.targets).toEqual([
      { serviceId: 'security', ref: 'master', path: '/repos/security' },
    ]);
  });

  it('says which services do not have the branch rather than quietly skipping them', () => {
    // One flow usually touches two of six repos; the other four not having
    // the branch is unremarkable, but it should be visible before the move.
    const plan = planBulkRebind([spec({ id: 'api' }), spec({ id: 'db' })], choices, {}, 'feat/x');
    expect(plan.skipped).toEqual([{ serviceId: 'db', reason: 'no-such-ref' }]);
  });

  it('does not move a service that is already there', () => {
    const plan = planBulkRebind(services, choices, { api: 'feat/x', web: 'master' }, 'feat/x');
    expect(plan.targets.map((t) => t.serviceId)).toEqual(['web']);
    expect(plan.skipped).toContainEqual({ serviceId: 'api', reason: 'already-there' });
  });
});

describe('bulkRefOptions', () => {
  it('offers the refs the most services can reach first', () => {
    expect(bulkRefOptions(choices)).toEqual([
      { ref: 'master', reachable: 3 },
      { ref: 'feat/x', reachable: 2 },
    ]);
  });

  it('still offers a ref only one service has', () => {
    // Moving one service is a perfectly ordinary thing to want.
    const options = bulkRefOptions({ api: [choice('solo', '/wt/solo')] });
    expect(options).toEqual([{ ref: 'solo', reachable: 1 }]);
  });

  it('counts a repo once even if a ref appears twice in its list', () => {
    const options = bulkRefOptions({ api: [choice('dup', '/a'), choice('dup', '/b')] });
    expect(options).toEqual([{ ref: 'dup', reachable: 1 }]);
  });
});

describe('planPinRebind', () => {
  it('replaces an older pin and pins services already on the chosen branch', () => {
    const plan = planPinRebind(services, choices, onMaster, 'feat/x');
    expect(plan.targets.map((target) => target.serviceId)).toEqual(['api', 'web']);
    expect(plan.pinIds).toEqual(['api', 'web']);
    expect(plan.skipped).toContainEqual({ serviceId: 'security', reason: 'no-such-ref' });
  });

  it('does not restart a service merely to pin the branch it is already on', () => {
    const plan = planPinRebind([spec({ id: 'api' })], choices, { api: 'feat/x' }, 'feat/x');
    expect(plan.targets).toEqual([]);
    expect(plan.pinIds).toEqual(['api']);
    expect(plan.skipped).toContainEqual({ serviceId: 'api', reason: 'already-there' });
  });
});

describe('handoffOffer', () => {
  it('offers a rebind when a finished flow left a branch the stack can reach', () => {
    expect(handoffOffer(services, choices, onMaster, 'feat/x')).toEqual({
      ref: 'feat/x',
      serviceIds: ['api', 'web'],
    });
  });

  it('offers nothing when the stack is already on that branch', () => {
    // An offer to do what is already done is noise.
    const there = { api: 'feat/x', web: 'feat/x', security: 'master' };
    expect(handoffOffer(services, choices, there, 'feat/x')).toBeNull();
  });

  it('offers nothing for a branch no service has', () => {
    expect(handoffOffer(services, choices, onMaster, 'feat/elsewhere')).toBeNull();
  });

  it('offers nothing when the run had no worktree', () => {
    expect(handoffOffer(services, choices, onMaster, undefined)).toBeNull();
  });

  it('does not offer to move only pinned services', () => {
    const pinnedOnly = [spec({ id: 'security', pinnedRef: 'master' })];
    expect(handoffOffer(pinnedOnly, choices, onMaster, 'feat/x')).toBeNull();
  });
});

describe('planChangedFilesRebind', () => {
  const stack = [
    spec({ id: 'acme-api', subpath: 'api' }),
    spec({ id: 'acme-web', subpath: './web/' }),
    spec({ id: 'billing' }),
  ];
  const repoChoices = {
    'acme-api': [choice('master', '/repos/acme'), choice('feat/x', '/wt/acme-x')],
    'acme-web': [choice('master', '/repos/acme'), choice('feat/x', '/wt/acme-x')],
    billing: [choice('master', '/repos/billing')],
  };
  const onMain = { 'acme-api': '/repos/acme', 'acme-web': '/repos/acme', billing: '/repos/billing' };

  it('moves only the services whose subpath holds a changed file', () => {
    const plan = planChangedFilesRebind(stack, onMain, repoChoices, [{ path: '/wt/acme-x' }], [
      'web/src/app.ts',
      'README.md',
    ]);
    expect(plan.targets).toEqual([{ serviceId: 'acme-web', ref: 'feat/x', path: '/wt/acme-x' }]);
    expect(plan.pinned).toEqual([]);
    expect(plan.alreadyThere).toEqual([]);
  });

  it('treats a service with no subpath as owning its whole repo', () => {
    const plan = planChangedFilesRebind(
      [spec({ id: 'billing' })],
      onMain,
      { billing: [choice('master', '/repos/billing'), choice('fix/y', '/wt/billing-y')] },
      [{ path: '/wt/billing-y' }],
      ['anything.ts'],
    );
    expect(plan.targets).toEqual([{ serviceId: 'billing', ref: 'fix/y', path: '/wt/billing-y' }]);
  });

  it('ignores services from repos the conversation did not touch', () => {
    const plan = planChangedFilesRebind(stack, onMain, repoChoices, [{ path: '/wt/acme-x' }], ['api/a.ts']);
    expect(plan.targets.map((t) => t.serviceId)).toEqual(['acme-api']);
  });

  it('strips a workspace member prefix before matching subpaths', () => {
    const plan = planChangedFilesRebind(
      stack,
      onMain,
      repoChoices,
      [{ path: '/wt/acme-x', prefix: 'acme' }],
      ['acme/api/a.ts', 'billing/api/b.ts'],
    );
    expect(plan.targets.map((t) => t.serviceId)).toEqual(['acme-api']);
  });

  it('reports a pin in the way instead of planning a move the engine will refuse', () => {
    const plan = planChangedFilesRebind(
      [spec({ id: 'acme-api', subpath: 'api', pinnedRef: 'master' })],
      onMain,
      repoChoices,
      [{ path: '/wt/acme-x' }],
      ['api/a.ts'],
    );
    expect(plan.targets).toEqual([]);
    expect(plan.pinned).toEqual([
      { serviceId: 'acme-api', pinnedRef: 'master', target: { serviceId: 'acme-api', ref: 'feat/x', path: '/wt/acme-x' } },
    ]);
  });

  it('marks owners already running from the checkout', () => {
    const plan = planChangedFilesRebind(
      stack,
      { ...onMain, 'acme-api': '/wt/acme-x/' },
      repoChoices,
      [{ path: '/wt/acme-x' }],
      ['api/a.ts'],
    );
    expect(plan.alreadyThere).toEqual(['acme-api']);
    expect(plan.targets).toEqual([]);
  });
});
