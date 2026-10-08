import { describe, expect, it } from 'vitest';
import { exchangeOutcome, groupExchanges, plainLine } from './roomView';
import type { TeamMessage } from '@shared/flows/team';

let ids = 0;
const msg = (exchange: number, speaker: TeamMessage['speaker'], text: string, extra: Partial<TeamMessage> = {}): TeamMessage => ({
  id: `m${++ids}`,
  speaker,
  text,
  at: 1_000 + ids,
  exchange,
  ...extra,
});
const you = { kind: 'you' } as const;
const mira = { kind: 'member', workerId: 'mira', name: 'Mira' } as const;
const lena = { kind: 'member', workerId: 'lena', name: 'Lena' } as const;
const coordinator = { kind: 'coordinator' } as const;

describe('groupExchanges', () => {
  it('groups consecutive messages by exchange, in order', () => {
    const list = [msg(0, you, 'a'), msg(0, mira, 'b'), msg(1, you, 'c'), msg(1, lena, 'd'), msg(1, coordinator, 'e')];
    expect(groupExchanges(list).map((e) => [e.n, e.messages.length])).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });
});

describe('exchangeOutcome', () => {
  it('prefers the wrap-up, as plain text', () => {
    const out = exchangeOutcome([
      msg(0, you, 'Per language?'),
      msg(0, mira, 'Yes'),
      msg(0, coordinator, '**Per language.** See [the spec](x.md).', { wrapUp: true }),
    ]);
    expect(out).toEqual({ kind: 'landed', text: 'Per language. See the spec.' });
  });

  it('says who reported back on handed-off work', () => {
    const out = exchangeOutcome([
      msg(2, you, '@Lena redo D-01'),
      msg(2, lena, 'On it', { handoff: { title: 'Redo D-01', assignments: [], status: 'started', stage: 6 } }),
      msg(2, lena, 'Redrew D-01 and D-02.', { workReport: { stage: 6 } }),
    ]);
    expect(out).toEqual({ kind: 'work', text: 'Lena reported back · Redrew D-01 and D-02.' });
  });

  it('names proposed work, and otherwise the last answer', () => {
    expect(
      exchangeOutcome([msg(3, you, 'x'), msg(3, lena, 'I can', { handoff: { title: 'Draw it', assignments: [], status: 'proposed' } })]),
    ).toEqual({ kind: 'proposed', text: 'Work proposed: Draw it' });
    expect(exchangeOutcome([msg(4, you, 'x'), msg(4, mira, 'One view'), msg(4, lena, 'Another', { failed: true })])).toEqual({
      kind: 'open',
      text: 'Mira: One view',
    });
    expect(exchangeOutcome([msg(5, you, 'x')])).toEqual({ kind: 'open', text: 'No answer' });
  });
});

describe('plainLine', () => {
  it('drops code blocks and markdown marks onto one line', () => {
    expect(plainLine('# Title\n\n```ts\nx\n```\n- `a` and _b_')).toBe('Title - a and b');
  });
});
