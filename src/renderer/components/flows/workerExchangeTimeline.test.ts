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

  it('places the reply inline when the question spans several paragraphs', () => {
    // Regression: the runtime records the LAST paragraph of an untagged
    // question, but this matcher used to propose the WHOLE message. Any
    // multi-paragraph question therefore failed to match, and its answer fell
    // out of the transcript into the pane's trailing fallback list — where it
    // sat at the bottom and drifted further down as new events arrived.
    const asked = [
      'No — not all of them. Of the 10 fix versions being set, 4 have release',
      'dates already in the past.',
      '',
      'This was flagged as an advisory in an earlier pass but I dropped the',
      'callout when I rewrote it.',
      '',
      'Want me to add it back to the report, and should I hold those writes?',
    ].join('\n');
    const recorded = 'Want me to add it back to the report, and should I hold those writes?';

    const result = matchWorkerExchangesToEvents(
      [assistant('question-event', 100, asked)],
      [exchange('exchange-1', 110, recorded)],
    );

    expect(result.get('question-event')?.id).toBe('exchange-1');
  });

  it('does not match tag-shaped text through the legacy plain-text fallback', () => {
    const result = matchWorkerExchangesToEvents(
      [
        assistant(
          'question-event',
          100,
          '<scr<script>ipt>alert(1)</script>Blue or green?</script>',
        ),
      ],
      [exchange('exchange-1', 110, 'alert(1)Blue or green?')],
    );

    expect(result.size).toBe(0);
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
