import type { FlowRun, FlowStep } from '@shared/flows/schema';

/// The step a queued correction will actually reach.
///   - running: the next step in order, which is how the runtime itself
///     defines "next" (see `prewarmNextParticipant`).
///   - paused: the step the run is parked in front of — known exactly, and
///     the moment a correction is most likely to be worth typing.
/// Null on the final step and on a finished run: there is nothing left to
/// carry a correction, so the Hold button is not offered at all rather than
/// taking words the run has nowhere to deliver.
export function steerRecipient(run: FlowRun): FlowStep | null {
  const steps = run.flowSnapshot.steps;
  if (run.state.kind === 'paused') {
    const nextStepId = run.state.nextStepId;
    return steps.find((s) => s.id === nextStepId) ?? null;
  }
  if (run.state.kind !== 'running') return null;
  // Hoisted: narrowing doesn't survive into the findIndex closure.
  const currentStepId = run.state.currentStepId;
  const idx = steps.findIndex((s) => s.id === currentStepId);
  if (idx < 0) return null;
  return steps[idx + 1] ?? null;
}

