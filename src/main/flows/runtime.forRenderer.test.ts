// What a run update carries to the renderer. Each artifact was capped, but
// not their sum: a run with many large artifacts cloned N × the cap on
// every update, and deleting a run sent everything uncapped.

import { describe, expect, it, vi } from 'vitest';

vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

import { FlowRuntimeImpl, RENDERER_ARTIFACT_MAX, RENDERER_RUN_ARTIFACTS_MAX, forRenderer } from './runtime';
import type { AppSettings, MainToRendererEvent, UUID } from '../../shared/types';
import type { FlowArtifact, FlowRun } from '../../shared/flows/schema';

const big = (name: string, step: string): FlowArtifact => ({ name, kind: 'text', body: 'x'.repeat(RENDERER_ARTIFACT_MAX + 10), producedByStepId: step, producedAt: 1 });

function run(steps: number): FlowRun {
  const ids = Array.from({ length: steps }, (_, i) => `s${i}`);
  const artifacts = Object.fromEntries(ids.map((id) => [`${id}.txt`, big(`${id}.txt`, id)]));
  return {
    id: 'run-big' as UUID,
    flowId: 'f',
    flowSnapshot: { id: 'f', name: 'F', input: 'user_prompt', participants: [], steps: ids.map((id) => ({ id, participantId: 'p', role: 'implementer', inputs: [], output: `${id}.txt` })), source: 'user', filePath: '/tmp/f.yaml' },
    projectPath: '/tmp/does-not-matter',
    conversationIds: {},
    artifacts,
    state: { kind: 'done' },
    createdAt: 1,
    // Each step's attempt holds the very artifact the map does.
    attempts: ids.map((id) => ({ stepId: id, outcome: 'success', artifact: artifacts[`${id}.txt`] })),
  } as unknown as FlowRun;
}

const total = (r: FlowRun) =>
  [...new Set([...Object.values(r.artifacts), ...r.attempts.flatMap((a) => (a.artifact ? [a.artifact] : []))])].reduce((n, a) => n + a.body.length, 0);

describe('forRenderer', () => {
  it('caps the sum of artifact text, not only each one', () => {
    const out = forRenderer(run(10));
    // Capped bodies carry a short marker past the budget; shared ones count once.
    expect(total(out)).toBeLessThan(RENDERER_RUN_ARTIFACTS_MAX + 10 * 200);
    // The newest outputs are spent on first.
    expect(out.artifacts['s9.txt'].body.length).toBeGreaterThan(RENDERER_ARTIFACT_MAX);
    expect(out.artifacts['s0.txt'].body).toMatch(/^\[…[\d,]+ more characters not shown/);
    expect(out.attempts[0].artifact).toBe(out.artifacts['s0.txt']);
  });

  it('sends a deleted run capped, and keeps the full body reachable until then', () => {
    const emitted: MainToRendererEvent[] = [];
    const runner = { prewarm: () => {}, dropIfPrewarmed: () => {}, stop: () => {} };
    const rt = new FlowRuntimeImpl(runner as never, (e) => emitted.push(e), () => [], () => ({ backends: {} }) as unknown as AppSettings);
    const r = run(6);
    (rt as never as { runs: Map<UUID, FlowRun> }).runs.set(r.id, r);
    expect(rt.artifactBody(r.id, 's5')).toHaveLength(RENDERER_ARTIFACT_MAX + 10);
    expect(rt.artifactBody(r.id, 'nope')).toBeNull();

    expect(rt.deleteRun({ runId: r.id, force: true })).toEqual({ ok: true });
    const update = emitted.find((e) => e.type === 'flowRunUpdate');
    if (update?.type !== 'flowRunUpdate') throw new Error('no update');
    expect(update.run.state.kind).toBe('aborted');
    expect(total(update.run)).toBeLessThan(RENDERER_RUN_ARTIFACTS_MAX + 6 * 200);
  });
});
