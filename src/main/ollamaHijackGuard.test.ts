import { describe, it, expect } from 'vitest';
import { hijackWouldCancelFlowStep } from './runner';

describe('hijackWouldCancelFlowStep', () => {
  const generating = { inFlight: {}, flowStepInFlight: true };

  it('refuses a user message typed while a flow step is generating', () => {
    expect(hijackWouldCancelFlowStep(generating, {})).toBe(true);
  });

  it('lets the flow drive its own next turn', () => {
    expect(hijackWouldCancelFlowStep(generating, { flowStep: true })).toBe(false);
  });

  it('allows a hijack once the step has settled', () => {
    expect(hijackWouldCancelFlowStep({ inFlight: undefined, flowStepInFlight: false }, {})).toBe(false);
  });

  // Ordinary chat outside a flow keeps its old behaviour: a new message
  // supersedes the one in flight.
  it('still lets a plain chat turn supersede the previous one', () => {
    expect(hijackWouldCancelFlowStep({ inFlight: {}, flowStepInFlight: false }, {})).toBe(false);
  });
});
