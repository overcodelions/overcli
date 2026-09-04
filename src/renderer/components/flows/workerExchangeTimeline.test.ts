import { describe, expect, it } from 'vitest';

import type { FlowWorkerExchange } from '@shared/flows/schema';
import type { StreamEvent } from '@shared/types';
import { matchWorkerExchangesToEvents, placeWorkerExchanges } from './workerExchangeTimeline';

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

function user(id: string, timestamp: number, text: string): StreamEvent {
  return { id, timestamp, raw: '', revision: 0, kind: { type: 'localUser', text } };
}

function toolResult(id: string, timestamp: number): StreamEvent {
  return {
    id,
    timestamp,
    raw: '',
    revision: 0,
    kind: { type: 'toolResult', results: [{ id: 'tu', content: 'ok', isError: false }] },
  } as StreamEvent;
}

describe('placeWorkerExchanges', () => {
  it('keeps a matched exchange under the turn that asked', () => {
    const result = placeWorkerExchanges(
      [assistant('question-event', 100, '<worker_question>Blue or green?</worker_question>')],
      [exchange('exchange-1', 110, 'Blue or green?')],
    );

    expect(result.byEventId.get('question-event')?.map((x) => x.id)).toEqual(['exchange-1']);
    expect(result.anchored.has('exchange-1')).toBe(true);
    expect(result.leading).toEqual([]);
  });

  it('drops an unmatched exchange in where it was asked, not at the end', () => {
    // The bug this exists for: the card used to be appended after everything,
    // so answering the question put your own reply ABOVE the question you were
    // answering, and every later message pushed it further out of place.
    const events = [
      assistant('before', 100, 'Working on it.'),
      user('reply', 200, 'i ssoed again so your login should be fixed'),
      assistant('after', 300, 'Retrying now.'),
    ];
    const result = placeWorkerExchanges(events, [exchange('stuck', 150, 'unmatchable question')]);

    expect(result.byEventId.get('before')?.map((x) => x.id)).toEqual(['stuck']);
    expect(result.byEventId.has('reply')).toBe(false);
    expect(result.byEventId.has('after')).toBe(false);
    expect(result.anchored.has('stuck')).toBe(false);
    expect(result.leading).toEqual([]);
  });

  it('anchors only to events the transcript actually draws', () => {
    // `renderAfterEvent` fires for rendered events only, so anchoring to a
    // tool result the user has hidden would delete the bubble rather than
    // move it.
    const events = [
      assistant('spoke', 100, 'Working on it.'),
      toolResult('tool', 150),
      assistant('silent', 160, '   '),
    ];
    const result = placeWorkerExchanges(events, [exchange('stuck', 200, 'unmatchable')]);

    expect(result.byEventId.get('spoke')?.map((x) => x.id)).toEqual(['stuck']);
  });

  it('puts an exchange older than the whole transcript above it', () => {
    // The common case, not an edge one: replayed history is only the last
    // ~1.5MB of a session, so a run that stalled early has no asking turn on
    // screen to anchor to. It belongs at the top, where it happened.
    const result = placeWorkerExchanges(
      [assistant('later', 500, 'Carrying on.')],
      [exchange('ancient', 100, 'unmatchable')],
    );

    expect(result.byEventId.size).toBe(0);
    expect(result.leading.map((x) => x.id)).toEqual(['ancient']);
  });

  it('orders several exchanges sharing one anchor by when they were asked', () => {
    const result = placeWorkerExchanges(
      [assistant('only', 100, 'Working on it.')],
      [exchange('second', 300, 'b'), exchange('first', 200, 'a')],
    );

    expect(result.byEventId.get('only')?.map((x) => x.id)).toEqual(['first', 'second']);
  });
});
