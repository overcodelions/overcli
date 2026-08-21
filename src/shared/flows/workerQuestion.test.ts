import { describe, expect, it } from 'vitest';

import {
  extractWorkerQuestion,
  normalizedWorkerQuestion,
  workerQuestionCandidates,
} from './workerQuestion';

describe('extractWorkerQuestion', () => {
  it('prefers the explicit protocol tag', () => {
    expect(extractWorkerQuestion('<worker_question>Blank or Unknown?</worker_question>')).toBe(
      'Blank or Unknown?',
    );
  });

  it('records only the LAST paragraph of an untagged question', () => {
    expect(extractWorkerQuestion('I checked the inputs.\n\nWhich fallback should I use?')).toBe(
      'Which fallback should I use?',
    );
  });

  it('ignores ordinary prose and tag-shaped text', () => {
    expect(extractWorkerQuestion('I checked the inputs and found no answer.')).toBeNull();
    expect(
      extractWorkerQuestion('<scr<script>ipt>alert(1)</script>Which fallback?</script>'),
    ).toBeNull();
  });
});

describe('workerQuestionCandidates', () => {
  it('offers both the last paragraph and the whole message', () => {
    // The runtime records the last paragraph; older builds recorded the whole
    // message. Both must find their event, or the answer strands at the bottom
    // of the transcript.
    const text = 'Here is what I found.\n\nSecond paragraph of context.\n\nShould I proceed?';
    expect(workerQuestionCandidates(text)).toEqual([
      'Should I proceed?',
      text,
    ]);
  });

  it('collapses to one candidate for a single-paragraph question', () => {
    expect(workerQuestionCandidates('Should I proceed?')).toEqual(['Should I proceed?']);
  });

  it('returns every tagged question and never falls back when tags are present', () => {
    expect(
      workerQuestionCandidates(
        '<worker_question>First?</worker_question> and <worker_question>Second?</worker_question>',
      ),
    ).toEqual(['First?', 'Second?']);
  });

  it('returns nothing for prose or tag-shaped text', () => {
    expect(workerQuestionCandidates('No question here.')).toEqual([]);
    expect(workerQuestionCandidates('<b>Which one?</b>')).toEqual([]);
  });

  it('agrees with extractWorkerQuestion on what the runtime records', () => {
    const text = 'Context line.\n\nA second line.\n\nWhich fallback should I use?';
    expect(workerQuestionCandidates(text)[0]).toBe(extractWorkerQuestion(text));
  });
});

describe('normalizedWorkerQuestion', () => {
  it('ignores case and whitespace shape', () => {
    expect(normalizedWorkerQuestion('  Should   I\nproceed? ')).toBe(
      normalizedWorkerQuestion('should i proceed?'),
    );
  });
});
