// ChangesBar indexes `PLAIN[f.commitState]` with no fallback (see the badge
// lookup in ChangesBar.tsx), so `PLAIN`'s keys must exactly match
// `CommitState`'s members or a plain-language user hits `undefined.label`.
// `shared/plainLanguage.ts` redeclares the union on purpose rather than
// importing it from renderer/, so this parity check lives here instead —
// the one place already allowed to depend on both.

import { describe, expect, it } from 'vitest';
import { PLAIN } from '@shared/plainLanguage';
import type { CommitState } from './ChangesBar';

describe('PLAIN vs CommitState', () => {
  it('has exactly the keys ChangesBar can look up', () => {
    const commitStates: CommitState[] = ['committed', 'uncommitted', 'both'];
    expect(Object.keys(PLAIN).sort()).toEqual([...commitStates].sort());
  });
});
