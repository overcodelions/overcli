import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../serviceLogContext', () => ({
  attachMentionedServiceLogs: async (prompt: string) => prompt,
}));
const noteUserTurn = vi.fn();
vi.mock('../../flowsStore', () => ({
  useFlowsStore: { getState: () => ({ noteUserTurn }) },
}));

import { sendParticipantTurn } from './participantTurn';
import type { FlowRun } from '@shared/flows/schema';

const invoke = vi.fn();
beforeEach(() => {
  invoke.mockReset();
  noteUserTurn.mockReset();
  (globalThis as unknown as { window: unknown }).window = { overcli: { invoke } };
});

const run = {
  id: 'run-1',
  projectPath: '/repo',
  chrome: false,
  conversationIds: { reviewer: 'conv-r' },
  sessionIdsByParticipant: { reviewer: 'sess-r' },
  modelOverrides: { reviewer: 'claude-opus-5-5' },
  flowSnapshot: {
    participants: [
      { id: 'reviewer', backend: 'claude', model: 'claude-sonnet-5' },
      { id: 'builder', backend: 'claude', model: 'claude-sonnet-5' },
    ],
  },
} as unknown as FlowRun;

describe('sendParticipantTurn', () => {
  it('resumes the step’s own session, with its model override, and notes the user turn', async () => {
    const conv = await sendParticipantTurn({ run, participantId: 'reviewer', prompt: 'Why approve?' });
    expect(conv).toBe('conv-r');
    expect(invoke).toHaveBeenCalledWith(
      'runner:send',
      expect.objectContaining({
        conversationId: 'conv-r',
        sessionId: 'sess-r',
        model: 'claude-opus-5-5',
        prompt: 'Why approve?',
        displayText: 'Why approve?',
        cwd: '/repo',
      }),
    );
    expect(noteUserTurn).toHaveBeenCalledWith('run-1');
  });

  it('starts a conversation for a participant that has not spoken', async () => {
    const conv = await sendParticipantTurn({ run, participantId: 'builder', prompt: 'hi' });
    expect(conv).not.toBe('conv-r');
    expect(invoke.mock.calls[0][1]).toMatchObject({ conversationId: conv, sessionId: undefined, model: 'claude-sonnet-5' });
  });

  it('refuses a participant the run does not have', async () => {
    await expect(sendParticipantTurn({ run, participantId: 'ghost', prompt: 'x' })).rejects.toThrow();
  });
});
