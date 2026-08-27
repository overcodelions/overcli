import { describe, expect, it } from 'vitest';

import {
  PROFILE_MAX_FACTS,
  answered,
  coerceProfile,
  parsePersonalization,
  personalizationInstruction,
  prefillFromProfile,
  profileKey,
  rememberAnswers,
  type PersonalizationQuestion,
  type UserProfile,
} from './personalize';

function q(over: Partial<PersonalizationQuestion> = {}): PersonalizationQuestion {
  return {
    key: 'reports_to',
    label: 'Reports to',
    found: 'Dave Kim',
    question: 'Who do you report to?',
    answer: '',
    ...over,
  };
}

const REPLY = [
  'This worker names its owner in a few places.',
  '<personalize>',
  JSON.stringify({
    details: [
      { key: 'reports_to', label: 'Reports to', found: 'Dave Kim', question: 'Who do you report to?' },
      {
        key: 'Digest Channel',
        label: 'Digest channel',
        found: '#eng-leads',
        question: 'Which channel should the digest go to?',
      },
    ],
  }),
  '</personalize>',
].join('\n');

describe('parsePersonalization', () => {
  it('reads the tagged block and normalizes keys', () => {
    const questions = parsePersonalization(REPLY);
    expect(questions).not.toBeNull();
    expect(questions!.map((x) => x.key)).toEqual(['reports_to', 'digest_channel']);
    expect(questions![1].found).toBe('#eng-leads');
    expect(questions!.every((x) => x.answer === '')).toBe(true);
  });

  it('distinguishes "nothing to personalize" from "no parseable answer"', () => {
    // An empty details array is a real finding — the worker is generic.
    expect(parsePersonalization('<personalize>{"details":[]}</personalize>')).toEqual([]);
    // No block at all is a failed turn, and the caller must not read it as
    // "this worker is generic" and silently skip the pass.
    expect(parsePersonalization('I could not do that.')).toBeNull();
    expect(parsePersonalization('<personalize>not json</personalize>')).toBeNull();
  });

  it('drops rows it could not draw or that quote nothing', () => {
    const questions = parsePersonalization(
      `<personalize>${JSON.stringify({
        details: [
          { key: 'a', label: 'A', question: 'Q?' }, // no `found`: invented, not observed
          { key: 'b', label: '', found: 'x', question: 'Q?' },
          { key: 'c', label: 'C', found: 'x', question: '' },
          { key: 'd', label: 'D', found: 'x', question: 'Q?' },
          { key: 'd', label: 'D again', found: 'y', question: 'Q?' }, // duplicate key
        ],
      })}</personalize>`,
    );
    expect(questions!.map((x) => x.key)).toEqual(['d']);
  });

  it('caps a runaway key', () => {
    expect(profileKey('  Slack Channel!!  ')).toBe('slack_channel');
    expect(profileKey('x'.repeat(200)).length).toBe(60);
  });
});

describe('prefillFromProfile', () => {
  const profile: UserProfile = {
    facts: [{ key: 'reports_to', label: 'Reports to', value: 'Priya', updatedAt: 5 }],
  };

  it('fills known answers and marks where they came from', () => {
    const [known, unknown] = prefillFromProfile([q(), q({ key: 'digest_channel' })], profile);
    expect(known.answer).toBe('Priya');
    expect(known.fromProfile).toBe(true);
    expect(unknown.answer).toBe('');
    expect(unknown.fromProfile).toBeUndefined();
  });

  it('is a no-op for an install that has never answered anything', () => {
    const questions = [q()];
    expect(prefillFromProfile(questions, null)).toBe(questions);
    expect(prefillFromProfile(questions, { facts: [] })).toBe(questions);
  });
});

describe('personalizationInstruction', () => {
  it('names each answered detail with the value it replaces', () => {
    const text = personalizationInstruction(
      [q({ answer: 'Priya' }), q({ key: 'digest_channel', label: 'Digest channel', found: '#eng-leads', answer: '#platform' })],
      'Chief of Staff',
    )!;
    expect(text).toContain('Reports to: currently "Dave Kim" — mine is "Priya".');
    expect(text).toContain('Digest channel: currently "#eng-leads" — mine is "#platform".');
    expect(text).toContain('Chief of Staff');
  });

  it('skips blanks, so an unanswered row leaves the worker alone', () => {
    const text = personalizationInstruction([q({ answer: 'Priya' }), q({ key: 'tz', found: 'CET' })], 'X')!;
    expect(text).toContain('Priya');
    expect(text).not.toContain('CET');
  });

  it('is null when nothing was answered — there is no empty revision to run', () => {
    expect(personalizationInstruction([q(), q({ key: 'tz', answer: '   ' })], 'X')).toBeNull();
    expect(personalizationInstruction([], 'X')).toBeNull();
  });

  it('answered() trims before judging', () => {
    expect(answered([q({ answer: ' ' }), q({ key: 'tz', answer: 'CET' })]).map((x) => x.key)).toEqual(['tz']);
  });
});

describe('rememberAnswers', () => {
  it('replaces a fact rather than accumulating contradictions', () => {
    const first = rememberAnswers(null, [q({ answer: 'Priya' })], 100);
    const second = rememberAnswers(first, [q({ answer: 'Sam' })], 200);
    expect(second.facts).toHaveLength(1);
    expect(second.facts[0]).toMatchObject({ key: 'reports_to', value: 'Sam', updatedAt: 200 });
  });

  it('keeps unrelated facts and stores answers trimmed', () => {
    const profile = rememberAnswers(null, [q({ answer: 'Priya' })], 100);
    const next = rememberAnswers(profile, [q({ key: 'timezone', label: 'Timezone', answer: ' CET ' })], 200);
    expect(next.facts.map((f) => f.key).sort()).toEqual(['reports_to', 'timezone']);
    expect(next.facts.find((f) => f.key === 'timezone')!.value).toBe('CET');
  });

  it('leaves the profile untouched when everything was skipped', () => {
    const profile: UserProfile = { facts: [{ key: 'a', label: 'A', value: 'x', updatedAt: 1 }] };
    expect(rememberAnswers(profile, [q()], 200)).toBe(profile);
    expect(rememberAnswers(null, [], 200)).toEqual({ facts: [] });
  });

  it('caps the pile, dropping the oldest', () => {
    const many = Array.from({ length: PROFILE_MAX_FACTS + 5 }, (_, i) =>
      q({ key: `k${i}`, label: `K${i}`, answer: 'v' }),
    );
    const profile = rememberAnswers(null, many, 100);
    expect(profile.facts).toHaveLength(PROFILE_MAX_FACTS);
  });
});

describe('coerceProfile', () => {
  it('survives junk on disk', () => {
    expect(coerceProfile(null)).toEqual({ facts: [] });
    expect(coerceProfile({ facts: 'nope' })).toEqual({ facts: [] });
    expect(
      coerceProfile({
        facts: [
          { key: 'Reports To', value: 'Priya', updatedAt: 3 },
          { key: 'reports_to', value: 'Someone else', updatedAt: 9 },
          { key: 'blank', value: '   ' },
          'garbage',
        ],
      }),
      // The newer answer wins the collision, whatever order the file lists them in.
    ).toEqual({
      facts: [{ key: 'reports_to', label: 'reports_to', value: 'Someone else', updatedAt: 9 }],
    });
  });

  it('sorts newest first', () => {
    const { facts } = coerceProfile({
      facts: [
        { key: 'old', label: 'Old', value: 'a', updatedAt: 1 },
        { key: 'new', label: 'New', value: 'b', updatedAt: 9 },
      ],
    });
    expect(facts.map((f) => f.key)).toEqual(['new', 'old']);
  });
});
