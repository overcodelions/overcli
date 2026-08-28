// `--permissions` has to be REACHABLE before it can be a policy.
//
// The bug this locks down: `resolvePermissionMode` clamped to `acceptEdits`
// only when `run.workerId` was set. A flow run launched by the CLI has no
// worker, so it fell through to `bypassPermissions` — and `backends/claude.ts`
// deliberately drops `--permission-prompt-tool` in that mode, so the run
// emitted NO permission requests at all. `--permissions deny` therefore
// answered nothing and restrained nothing, while reading in `--help` as
// containment. A flag that claims a boundary it does not hold is worse than no
// flag, because people plan around it.

import { describe, expect, it, vi } from 'vitest';

import { useTestHost } from '../testHost';

useTestHost('/tmp/overcli-unattended-tests');

vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

import { FlowRuntimeImpl } from './runtime';
import type { Flow, FlowRun, FlowStep } from '../../shared/flows/schema';
import { DEFAULT_SETTINGS } from '../../shared/types';

function step(over: Partial<FlowStep> = {}): FlowStep {
  return {
    id: 's1',
    participantId: 'primary',
    role: 'implementer',
    inputs: [],
    tools: ['Read'],
    output: 'out.md',
    ...over,
  };
}

function flow(backend: 'claude' | 'ollama' = 'claude'): Flow {
  return {
    id: 'f',
    name: 'F',
    input: 'user_prompt',
    participants: [{ id: 'primary', name: 'P', backend, model: 'm' }],
    steps: [step()],
    source: 'user',
    filePath: '/tmp/f.yaml',
  };
}

/// `resolvePermissionMode` is private and the class is 5000 lines; building a
/// real instance with stub deps is cheaper and truer than carving an export
/// out of it. Nothing the method touches comes from the constructor.
function modeFor(runPatch: Partial<FlowRun>, s: FlowStep = step()): string {
  const rt = new FlowRuntimeImpl(
    {} as never,
    () => {},
    () => [],
    () => DEFAULT_SETTINGS,
    () => [],
  );
  const run = { flowSnapshot: flow(), ...runPatch } as FlowRun;
  return (rt as unknown as { resolvePermissionMode(r: FlowRun, st: FlowStep): string })
    .resolvePermissionMode(run, s);
}

describe('resolvePermissionMode', () => {
  it('is unchanged for an ordinary app run — a human is there to answer', () => {
    expect(modeFor({})).toBe('bypassPermissions');
  });

  it('clamps an unattended run, so the permission tap can actually answer', () => {
    expect(modeFor({ unattended: true })).toBe('acceptEdits');
  });

  it('still clamps a worker with no external-action grant', () => {
    expect(modeFor({ workerId: 'w' })).toBe('acceptEdits');
  });

  it('leaves an explicitly granted unattended run alone', () => {
    // --permissions auto-approve sets no clamp: the caller asked for the
    // unrestrained mode, and there is nothing for a tap to add.
    expect(modeFor({ unattended: true, allowExternalActions: true })).toBe('bypassPermissions');
  });

  it('never overrides a mode the step set for itself', () => {
    expect(modeFor({ unattended: true }, step({ permissionMode: 'plan' }))).toBe('plan');
  });
});

// The other half of the policy, and the one that actually bites.
//
// A step's `tools:` becomes `--allowedTools`, which PRE-AUTHORISES those tools
// at the CLI — they emit no permission request, so an event-stream tap can
// never refuse them. Verified empirically before this existed: `overcli run
// --permissions deny` on a flow declaring `tools: [Bash]` created the file.
describe('unattendedAllowedTools', () => {
  function enabledToolsFor(run: Partial<FlowRun>, s: FlowStep = step({ tools: ['Read', 'Bash'] })) {
    return run.unattended
      ? s.tools.filter((t) => (run.unattendedAllowedTools ?? []).includes(t))
      : s.tools;
  }

  it('leaves an ordinary app run untouched', () => {
    expect(enabledToolsFor({})).toEqual(['Read', 'Bash']);
  });

  it('pre-authorises nothing under deny, so every call reaches the tap', () => {
    expect(enabledToolsFor({ unattended: true, unattendedAllowedTools: [] })).toEqual([]);
  });

  it('keeps only the intersection under allow-list', () => {
    expect(enabledToolsFor({ unattended: true, unattendedAllowedTools: ['Read'] })).toEqual(['Read']);
  });

  it('cannot widen a step beyond what it declared', () => {
    // --allow-tool Bash on a step that only asked for Read must not grant Bash.
    expect(
      enabledToolsFor({ unattended: true, unattendedAllowedTools: ['Read', 'Bash'] }, step({ tools: ['Read'] })),
    ).toEqual(['Read']);
  });
});
