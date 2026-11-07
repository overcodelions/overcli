import { describe, expect, it } from 'vitest';
import { suggestTeamFor } from './processLibrary';

const stage = (words: string[]) => ({ kind: 'team', words }) as never;
const team = (purpose: string) => ({ id: 't', name: 'Team', purpose });

describe('matching a stage to a team by its words', () => {
  it('takes a word with regex characters as plain text, rather than throwing', () => {
    expect(() => suggestTeamFor(stage(['c++', 'rust']), [team('writes c++ and rust')])).not.toThrow();
    expect(suggestTeamFor(stage(['c++', 'rust']), [team('writes c++ and rust')])?.team.id).toBe('t');
  });

  it('doesn’t let a dot or a backslash match more than itself', () => {
    expect(suggestTeamFor(stage(['a.b', 'x.y']), [team('axb and xzy')])).toBeNull();
    expect(suggestTeamFor(stage(['a\\b', 'x\\y']), [team('ab and xy')])).toBeNull();
    expect(suggestTeamFor(stage(['a.b', 'x.y']), [team('a.b and x.y')])?.team.id).toBe('t');
  });

  it('still matches a word with a slash in it', () => {
    expect(suggestTeamFor(stage(['pr/faq', 'launch']), [team('writes the pr/faq for launch')])?.team.id).toBe('t');
  });
});
