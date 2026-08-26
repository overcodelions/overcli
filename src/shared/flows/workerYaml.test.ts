import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import type { Flow } from './schema';
import type { Worker } from './worker';
import {
  parseWorkerYaml,
  serializeWorker,
  workerShareFilename,
  WORKER_YAML_KIND,
} from './workerYaml';

function flow(id: string): Flow {
  return {
    id,
    name: `Flow ${id}`,
    input: 'user_prompt',
    participants: [
      {
        id: 'primary',
        name: 'Claude Sonnet 4.6',
        backend: 'claude',
        model: 'claude-sonnet-4-6',
        kind: 'primary',
      },
    ],
    steps: [
      {
        id: 'step_1',
        participantId: 'primary',
        role: 'planner',
        inputs: ['user_prompt'],
        tools: [],
        output: 'plan.md',
      },
    ],
    source: 'user',
    filePath: `/tmp/${id}.yaml`,
  };
}

function worker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: 'worker-uuid',
    name: 'Release Nanny',
    jobDescription: 'Watch the release branch every morning and report what is not green.',
    projectPath: '/Users/someone/private/repo',
    cadence: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] },
    trust: 'autonomous',
    caps: { maxItemsPerShift: 3, runIn: 'worktree' },
    budgetUSDPerMonth: 12,
    heartbeatModel: 'claude-sonnet-4-6',
    flowIds: ['nightly-review'],
    enabled: true,
    createdAt: 1_700_000_000_000,
    shiftCount: 41,
    lastShiftAt: 1_800_000_000_000,
    order: 2,
    ...overrides,
  };
}

function shareOf(w: Worker = worker(), flows = [flow('nightly-review')]) {
  return serializeWorker({ worker: w, flows });
}

describe('serializeWorker', () => {
  it('carries the job and embeds the flows behind it', () => {
    const doc = parse(shareOf());
    expect(doc.kind).toBe(WORKER_YAML_KIND);
    expect(doc.name).toBe('Release Nanny');
    expect(doc.job_description).toContain('release branch');
    expect(doc.cadence).toEqual({ kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] });
    expect(doc.flows).toEqual(['nightly-review']);
    expect(doc.flow_definitions).toHaveLength(1);
    expect(doc.flow_definitions[0].id).toBe('nightly-review');
    expect(doc.flow_definitions[0].steps).toHaveLength(1);
  });

  it('leaves this install behind: no id, trust, project path or history', () => {
    const body = shareOf();
    expect(body).not.toContain('worker-uuid');
    expect(body).not.toContain('autonomous');
    expect(body).not.toContain('/Users/someone/private/repo');
    const doc = parse(body);
    expect(doc.trust).toBeUndefined();
    expect(doc.created_at).toBeUndefined();
    expect(doc.shift_count).toBeUndefined();
    expect(doc.order).toBeUndefined();
  });

  it('never writes a worker that runs in the working copy', () => {
    const doc = parse(shareOf(worker({ caps: { maxItemsPerShift: 2, runIn: 'cwd' } })));
    expect(doc.caps.run_in).toBe('worktree');
  });

  it('quotes times so a YAML 1.1 reader cannot turn them into minutes', () => {
    const body = shareOf(worker({ cadence: { kind: 'daily', time: '9:00' } }));
    expect(body).toContain("time: '9:00'");
  });

  it('serializes an interval cadence with its window', () => {
    const doc = parse(
      shareOf(
        worker({
          cadence: {
            kind: 'interval',
            everyMinutes: 60,
            days: [1, 2, 3, 4, 5],
            window: { start: '08:00', end: '17:00' },
          },
        }),
      ),
    );
    expect(doc.cadence).toEqual({
      kind: 'interval',
      every_minutes: 60,
      days: [1, 2, 3, 4, 5],
      window: { start: '08:00', end: '17:00' },
    });
  });

  it('still lists a flow id it could not resolve', () => {
    const doc = parse(shareOf(worker({ flowIds: ['nightly-review', 'gone'] })));
    expect(doc.flows).toEqual(['nightly-review', 'gone']);
    expect(doc.flow_definitions).toHaveLength(1);
  });
});

describe('parseWorkerYaml', () => {
  it('round-trips a shared worker back into a hireable one', () => {
    const res = parseWorkerYaml(shareOf());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bundle.worker.name).toBe('Release Nanny');
    expect(res.bundle.worker.cadence).toEqual({
      kind: 'daily',
      time: '09:00',
      days: [1, 2, 3, 4, 5],
    });
    expect(res.bundle.worker.caps).toEqual({ maxItemsPerShift: 3, runIn: 'worktree' });
    expect(res.bundle.worker.budgetUSDPerMonth).toBe(12);
    expect(res.bundle.worker.heartbeatModel).toBe('claude-sonnet-4-6');
    expect(res.bundle.worker.flowIds).toEqual(['nightly-review']);
    expect(res.bundle.flows.map((f) => f.id)).toEqual(['nightly-review']);
    expect(res.bundle.flows[0].steps).toHaveLength(1);
    expect(res.missingFlowIds).toEqual([]);
  });

  it('round-trips an interval cadence', () => {
    const res = parseWorkerYaml(
      shareOf(
        worker({
          cadence: { kind: 'interval', everyMinutes: 90, window: { start: '08:00', end: '17:00' } },
        }),
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bundle.worker.cadence).toEqual({
      kind: 'interval',
      everyMinutes: 90,
      days: undefined,
      window: { start: '08:00', end: '17:00' },
    });
  });

  it('refuses a run_in the sender asked for', () => {
    const res = parseWorkerYaml(`
kind: worker
name: Sneaky
job_description: Do the thing that needs at least twenty characters of description.
caps:
  max_items_per_shift: 99
  run_in: cwd
flows: [x]
`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bundle.worker.caps.runIn).toBe('worktree');
    expect(res.bundle.worker.caps.maxItemsPerShift).toBe(5);
  });

  it('reports flow ids the file did not carry', () => {
    const res = parseWorkerYaml(shareOf(worker({ flowIds: ['nightly-review', 'gone'] })));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.missingFlowIds).toEqual(['gone']);
  });

  it('falls back to the embedded definitions when `flows:` is missing', () => {
    const body = shareOf().replace('flows:\n  - nightly-review\n', '');
    const res = parseWorkerYaml(body);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bundle.worker.flowIds).toEqual(['nightly-review']);
  });

  it('refuses a file from a newer format rather than misreading it', () => {
    const res = parseWorkerYaml(shareOf().replace('version: 1', 'version: 2'));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('v2');
  });

  it('accepts a file that predates the version field', () => {
    expect(parseWorkerYaml(shareOf().replace('version: 1\n', '')).ok).toBe(true);
  });

  it('says so when handed a flow', () => {
    const res = parseWorkerYaml('name: A flow\nsteps:\n  - id: step_1\n');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('flow');
  });

  it('rejects a worker with no usable job description', () => {
    const res = parseWorkerYaml('kind: worker\nname: Thin\njob_description: too short\n');
    expect(res.ok).toBe(false);
  });

  it('rejects unparseable YAML without throwing', () => {
    expect(parseWorkerYaml('kind: worker\n  : :\n- [').ok).toBe(false);
  });

  it('ignores keys it does not know', () => {
    const res = parseWorkerYaml(`${shareOf()}\nfuture_key: whatever\n`);
    expect(res.ok).toBe(true);
  });
});

describe('workerShareFilename', () => {
  it('slugs the name and keeps the double extension', () => {
    expect(workerShareFilename('Release Nanny')).toBe('release-nanny.worker.yaml');
    expect(workerShareFilename('  QBR / weekly!  ')).toBe('qbr-weekly.worker.yaml');
    expect(workerShareFilename('///')).toBe('worker.worker.yaml');
  });
});

describe('heartbeat backend travels with the model', () => {
  it('writes heartbeat_backend when the worker records one', () => {
    const yaml = shareOf(worker({ heartbeatBackend: 'codex' }));
    expect(yaml).toContain('heartbeat_backend: codex');
  });

  it('omits it when unset, so the file stays importable by an older build', () => {
    const yaml = shareOf();
    expect(yaml).not.toContain('heartbeat_backend');
  });

  it('round-trips the pair', () => {
    const yaml = shareOf(worker({ heartbeatBackend: 'gemini' }));
    const res = parseWorkerYaml(yaml);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bundle.worker.heartbeatBackend).toBe('gemini');
    expect(res.bundle.worker.heartbeatModel).toBe('claude-sonnet-4-6');
  });

  it('leaves it unset for a file that predates the field', () => {
    // The pre-field path: no backend recorded, so the importer runs the model
    // through tier translation against whatever backend is default.
    const res = parseWorkerYaml(shareOf());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bundle.worker.heartbeatBackend).toBeUndefined();
  });

  it('drops a backend name we do not ship', () => {
    // A bogus value would pin the worker to a CLI that does not exist, where
    // falling back to translation is the safer outcome.
    const res = parseWorkerYaml(shareOf().replace('heartbeat_model:', 'heartbeat_backend: gpt4all\nheartbeat_model:'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bundle.worker.heartbeatBackend).toBeUndefined();
  });
});


describe('an on-demand cadence in a share file', () => {
  it('writes the marker as a word rather than an empty value', () => {
    const doc = parse(shareOf(worker({ cadence: null })));
    expect(doc.cadence).toBe('onDemand');
  });

  it('round-trips back to no clock', () => {
    const res = parseWorkerYaml(shareOf(worker({ cadence: null })));
    expect(res.ok).toBe(true);
    expect(res.ok && res.bundle.worker.cadence).toBeNull();
  });
});

describe('MCP allowlists across a share', () => {
  it('omits the key when the worker inherits everything', () => {
    // Absent is the pre-field default, and writing it out as an empty list
    // would import as "this job needs no servers" — the opposite.
    expect(parse(shareOf()).mcp_servers).toBeUndefined();
  });

  it('round-trips a named allowlist', () => {
    const doc = parse(shareOf(worker({ mcpServers: ['atlassian', 'slack'] })));
    expect(doc.mcp_servers).toEqual(['atlassian', 'slack']);
    const parsed = parseWorkerYaml(shareOf(worker({ mcpServers: ['atlassian', 'slack'] })));
    expect(parsed.ok && parsed.bundle.worker.mcpServers).toEqual(['atlassian', 'slack']);
  });

  it('round-trips an explicitly empty allowlist', () => {
    // "This job needs no connected services" is a real answer and the
    // cheapest a worker gets — it must survive the trip.
    const yaml = shareOf(worker({ mcpServers: [] }));
    expect(parse(yaml).mcp_servers).toEqual([]);
    const parsed = parseWorkerYaml(yaml);
    expect(parsed.ok && parsed.bundle.worker.mcpServers).toEqual([]);
  });
});
