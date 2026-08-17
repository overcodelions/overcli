import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';

import type { Flow } from '../../shared/flows/schema';
import type { Worker } from '../../shared/flows/worker';
import { buildWorkerShare, describeImport, importWorkerYaml } from './workerShare';

function flow(id: string): Flow {
  return {
    id,
    name: `Flow ${id}`,
    input: 'user_prompt',
    participants: [
      { id: 'primary', name: 'Sonnet', backend: 'claude', model: 'claude-sonnet-4-6', kind: 'primary' },
    ],
    steps: [
      { id: 'step_1', participantId: 'primary', role: 'planner', inputs: ['user_prompt'], tools: [], output: 'plan.md' },
    ],
    source: 'user',
    filePath: `/tmp/${id}.yaml`,
  };
}

function worker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: 'w1',
    name: 'Release Nanny',
    jobDescription: 'Watch the release branch every morning and report what is not green.',
    projectPath: '/repo',
    cadence: { kind: 'daily', time: '09:00' },
    trust: 'trusted',
    caps: { maxItemsPerShift: 3, runIn: 'worktree' },
    budgetUSDPerMonth: 12,
    heartbeatModel: 'claude-sonnet-4-6',
    flowIds: ['nightly-review'],
    enabled: true,
    createdAt: 1,
    ...overrides,
  };
}

const ok = () => ({ ok: true }) as const;

describe('buildWorkerShare', () => {
  it('embeds the flows the worker references', () => {
    const share = buildWorkerShare({
      worker: worker(),
      library: [flow('nightly-review'), flow('unrelated')],
    });
    const doc = parse(share.yaml);
    expect(doc.flow_definitions.map((f: { id: string }) => f.id)).toEqual(['nightly-review']);
    expect(share.filename).toBe('release-nanny.worker.yaml');
    expect(share.missingFlowIds).toEqual([]);
  });

  it('reports a referenced flow the library no longer has', () => {
    const share = buildWorkerShare({
      worker: worker({ flowIds: ['nightly-review', 'deleted'] }),
      library: [flow('nightly-review')],
    });
    expect(share.missingFlowIds).toEqual(['deleted']);
    expect(parse(share.yaml).flows).toEqual(['nightly-review', 'deleted']);
  });
});

describe('importWorkerYaml', () => {
  const shareYaml = () =>
    buildWorkerShare({ worker: worker(), library: [flow('nightly-review')] }).yaml;

  it('installs a flow the library does not have', () => {
    const saveFlow = vi.fn(ok);
    const res = importWorkerYaml({ yaml: shareYaml(), existingFlowIds: [], saveFlow });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(saveFlow).toHaveBeenCalledTimes(1);
    expect(res.result.notes.installedFlowIds).toEqual(['nightly-review']);
    expect(res.result.bundle.worker.name).toBe('Release Nanny');
  });

  it('never overwrites a flow the library already has', () => {
    const saveFlow = vi.fn(ok);
    const res = importWorkerYaml({
      yaml: shareYaml(),
      existingFlowIds: ['nightly-review'],
      saveFlow,
    });
    expect(saveFlow).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.notes.reusedFlowIds).toEqual(['nightly-review']);
    expect(res.result.notes.installedFlowIds).toEqual([]);
  });

  it('treats a flow that would not save as missing', () => {
    const res = importWorkerYaml({
      yaml: shareYaml(),
      existingFlowIds: [],
      saveFlow: () => ({ ok: false, error: 'disk full' }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.notes.failedFlowIds).toEqual([{ id: 'nightly-review', error: 'disk full' }]);
    expect(res.result.notes.missingFlowIds).toEqual(['nightly-review']);
  });

  it('passes a parse failure straight through', () => {
    const res = importWorkerYaml({ yaml: 'name: not a worker\n', existingFlowIds: [], saveFlow: ok });
    expect(res.ok).toBe(false);
  });

  it('carries an unsupplied flow id through to the notes', () => {
    const yaml = buildWorkerShare({
      worker: worker({ flowIds: ['nightly-review', 'deleted'] }),
      library: [flow('nightly-review')],
    }).yaml;
    const res = importWorkerYaml({ yaml, existingFlowIds: [], saveFlow: ok });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.notes.missingFlowIds).toEqual(['deleted']);
  });
});

describe('describeImport', () => {
  it('says nothing when nothing happened', () => {
    expect(
      describeImport({ installedFlowIds: [], reusedFlowIds: [], missingFlowIds: [], failedFlowIds: [] }),
    ).toBe('');
  });

  it('leads with what arrived and ends with what is missing', () => {
    const line = describeImport({
      installedFlowIds: ['a'],
      reusedFlowIds: ['b'],
      missingFlowIds: ['c'],
      failedFlowIds: [],
    });
    expect(line.indexOf('Added')).toBeLessThan(line.indexOf('Missing'));
    expect(line).toContain('Kept your own b');
  });
});
