import { describe, expect, it } from 'vitest';

import type { FlowWorkerExchange } from '@shared/flows/schema';
import type { StreamEvent } from '@shared/types';
import { matchWorkerExchangesToEvents } from './workerExchangeTimeline';

function assistant(id: string, timestamp: number, text: string): StreamEvent {
  return {
    id,
    timestamp,
    raw: '',
    revision: 0,
    kind: {
      type: 'assistant',
      info: { model: 'claude-sonnet-5', text, toolUses: [], thinking: [] },
    },
  };
}

function exchange(id: string, askedAt: number, question: string): FlowWorkerExchange {
  return {
    id,
    stepId: 'ask-worker',
    participantId: 'primary',
    askedAt,
    question,
    status: 'answered',
    answeredAt: askedAt + 1,
    answer: 'blue',
  };
}

describe('matchWorkerExchangesToEvents', () => {
  it('places a worker reply after its tagged flow question', () => {
    const result = matchWorkerExchangesToEvents(
      [assistant('question-event', 100, '<worker_question>Blue or green?</worker_question>')],
      [exchange('exchange-1', 110, 'Blue or green?')],
    );

    expect(result.get('question-event')?.id).toBe('exchange-1');
  });

  it('supports older transcripts that ended in a plain question', () => {
    const result = matchWorkerExchangesToEvents(
      [assistant('question-event', 100, 'Blue or green?')],
      [exchange('exchange-1', 110, 'Blue or green?')],
    );

    expect(result.get('question-event')?.id).toBe('exchange-1');
  });

  it('pairs repeated questions one-to-one using the nearest timestamp', () => {
    const result = matchWorkerExchangesToEvents(
      [
        assistant('first-event', 100, '<worker_question>Blue or green?</worker_question>'),
        assistant('second-event', 300, '<worker_question>Blue or green?</worker_question>'),
      ],
      [
        exchange('second-exchange', 310, 'Blue or green?'),
        exchange('first-exchange', 110, 'Blue or green?'),
      ],
    );

    expect(result.get('first-event')?.id).toBe('first-exchange');
    expect(result.get('second-event')?.id).toBe('second-exchange');
  });
});
