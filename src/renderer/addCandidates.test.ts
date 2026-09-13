import { describe, expect, it } from 'vitest';
import {
  buildCandidates,
  filterCandidates,
  planAdds,
  type CandidateGroup,
} from './addCandidates';
import type { ImportSet, ImportedService } from '@shared/servicesImport';
import type { ServiceProposal } from '@shared/services';

const imported = (name: string, options = 3): ImportedService => ({
  name,
  options: Array.from({ length: options }, (_, i) => ({ key: `-Dk${i}`, value: 'v' })),
  env: {},
  moduleHint: 'AcmeREST',
  source: 'intellij',
});

const set = (source: ImportSet['source'], names: string[]): ImportSet => ({
  source,
  file: `.idea/${source}`,
  services: names.map((n) => ({ ...imported(n), source })),
});

const proposal = (name: string, confidence: ServiceProposal['confidence'] = 'high') =>
  ({
    projectId: 'p1',
    serviceId: `svc-${name}`,
    proposal: {
      spec: {
        id: `svc-${name}`,
        name,
        runner: 'gradle' as const,
        command: ['./gradlew', `:${name}:bootRun`],
        ready: { kind: 'none' as const },
        selfReloads: false,
        config: {},
      },
      confidence,
      evidence: [],
    },
  }) as { projectId: string; serviceId: string; proposal: ServiceProposal };

function groups(over: Partial<Parameters<typeof buildCandidates>[0]> = {}): CandidateGroup[] {
  return buildCandidates({
    imports: [
      {
        stackId: 'w1',
        projectId: 'p1',
        projectName: 'gitrepo',
        sets: [set('tiltfile', ['billing-rest']), set('intellij', ['AcmeREST', 'AcmeProcessor'])],
      },
    ],
    detected: [
      { stackId: 'w1', projectId: 'p1', projectName: 'gitrepo', found: [proposal('admin-console-ui')] },
    ],
    existing: new Set(),
    ...over,
  });
}

describe('ranking what to offer', () => {
  it('puts the file that states the options above the one that guesses', () => {
    // The whole argument of the screen: evidence first, guesses last.
    expect(groups().map((g) => g.title)).toEqual([
      'Your IntelliJ run configurations',
      'Your Tiltfile resources',
      'Read from your build files',
    ]);
  });

  it('marks which groups state the options', () => {
    const g = groups();
    expect(g.filter((x) => x.stated).length).toBe(2);
    expect(g[g.length - 1].stated).toBe(false);
  });

  it('collapses detection into one group, not one per project', () => {
    const g = groups({
      detected: [
        { stackId: 'w1', projectId: 'p1', projectName: 'a', found: [proposal('one')] },
        { stackId: 'w1', projectId: 'p2', projectName: 'b', found: [proposal('two')] },
      ],
    });
    const detected = g.filter((x) => !x.stated);
    expect(detected).toHaveLength(1);
    expect(detected[0].items).toHaveLength(2);
  });

  it('never offers a service that is already added', () => {
    const g = groups({ existing: new Set(['svc-admin-console-ui']) });
    expect(g.some((x) => !x.stated)).toBe(false);
  });

  it('flags detection that wants a second look', () => {
    const g = groups({
      detected: [
        { stackId: 'w1', projectId: 'p1', projectName: 'a', found: [proposal('maybe', 'low')] },
      ],
    });
    expect(g[g.length - 1].items[0].uncertain).toBe(true);
  });
});

describe('group headers', () => {
  it('name the project a config file came from', () => {
    expect(groups().filter((g) => g.stated).every((g) => g.projectName === 'gitrepo')).toBe(true);
  });
});

describe('searching', () => {
  it('matches on name, module, command and project', () => {
    expect(filterCandidates(groups(), 'console-ui').flatMap((g) => g.items.map((i) => i.name))).toEqual(
      ['admin-console-ui'],
    );
    expect(filterCandidates(groups(), 'acmerest')[0].items[0].name).toBe('AcmeREST');
  });

  it('drops a group with nothing left rather than showing an empty heading', () => {
    expect(filterCandidates(groups(), 'nothing-matches-this')).toEqual([]);
  });
});

describe('performing the add', () => {
  it('keeps an imported set together so it factors into a base plus differences', () => {
    // Five configurations of one module sent one at a time are five unrelated
    // services repeating the same forty options.
    const g = groups();
    const stated = new Set(g.filter((x) => x.stated).flatMap((x) => x.items.map((i) => i.key)));
    const plan = planAdds(g, stated);
    const intellij = plan.imports.find((i) => i.services.length === 2);
    expect(intellij?.services.map((s) => s.name)).toEqual(['AcmeREST', 'AcmeProcessor']);
  });

  it('sends detected services as plain adds', () => {
    const g = groups();
    const all = new Set(g.flatMap((x) => x.items.map((i) => i.key)));
    const plan = planAdds(g, all);
    expect(plan.detected).toHaveLength(1);
    expect(plan.detected[0].item.serviceId).toBe('svc-admin-console-ui');
  });

  it('sends nothing for a group with nothing ticked', () => {
    const plan = planAdds(groups(), new Set());
    expect(plan.imports).toEqual([]);
    expect(plan.detected).toEqual([]);
  });
});
