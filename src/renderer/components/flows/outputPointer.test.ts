import { describe, expect, it } from 'vitest';
import { parseOutputHandoff } from './outputPointer';

describe('parseOutputHandoff', () => {
  it('reads the pointer a re-asked step actually replies with', () => {
    // Verbatim from a run: the whole reply was this one tag, which rendered
    // as an empty bubble before the handoff chip existed.
    const handoff = parseOutputHandoff(
      '<output name="release_readiness_report.md" file="release-readiness-2026-08-23.md" />',
    );
    expect(handoff).toEqual({
      name: 'release_readiness_report.md',
      file: 'release-readiness-2026-08-23.md',
    });
  });

  it('tolerates single quotes, attribute order, and surrounding whitespace', () => {
    expect(parseOutputHandoff("\n  <output file='draft.md' name='report.md'/>  \n")).toEqual({
      name: 'report.md',
      file: 'draft.md',
    });
  });

  it('treats an immediately-closed tag as a handoff with no file', () => {
    expect(parseOutputHandoff('<output name="report.md"></output>')).toEqual({
      name: 'report.md',
      file: null,
    });
  });

  it('ignores a block with a body — that renders as markdown', () => {
    expect(
      parseOutputHandoff('<output name="report.md">\n# Report\n\nbody\n</output>'),
    ).toBeNull();
  });

  it('ignores a pointer with prose around it', () => {
    expect(
      parseOutputHandoff('Done — here it is.\n\n<output name="report.md" file="draft.md" />'),
    ).toBeNull();
  });

  it('ignores ordinary replies and unnamed tags', () => {
    expect(parseOutputHandoff('Report written and filed. Verdict is **GO**.')).toBeNull();
    expect(parseOutputHandoff('<output file="draft.md" />')).toBeNull();
    expect(parseOutputHandoff('')).toBeNull();
  });
});
