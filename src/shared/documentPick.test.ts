// What an agent turn puts in front of a non-engineer afterwards. The rule
// that matters: a marketing deck, never the python that generated it.

import { describe, expect, it } from 'vitest';
import {
  isDocumentLikePath,
  isEverydayProject,
  isProseDocumentPath,
  pickDocumentToShow,
} from './everydayProjects';

describe('isDocumentLikePath', () => {
  it('counts the things a business user calls a document', () => {
    for (const p of ['BRIEF.md', 'a/b/deck.pptx', 'budget.csv', 'report.pdf', 'notes.docx']) {
      expect(isDocumentLikePath(p)).toBe(true);
    }
  });

  it('does not count the scripts an agent writes alongside them', () => {
    for (const p of ['tools/build_brief_deck.py', 'tools/export_preview.sh', 'src/main.ts', 'Makefile']) {
      expect(isDocumentLikePath(p)).toBe(false);
    }
  });
});

describe('pickDocumentToShow', () => {
  it('picks the deck, not the build script that made it', () => {
    expect(
      pickDocumentToShow([
        'tools/build_brief_deck.py',
        'tools/export_preview.sh',
        'marketing-101/brief/MKTG101-curriculum-brief.pptx',
      ]),
    ).toBe('marketing-101/brief/MKTG101-curriculum-brief.pptx');
  });

  it('prefers the shallowest document when several qualify', () => {
    expect(pickDocumentToShow(['a/b/c/deep.md', 'BRIEF.md'])).toBe('BRIEF.md');
  });

  it('opens nothing when a turn only touched code', () => {
    expect(pickDocumentToShow(['tools/build.py', 'run.sh'])).toBeUndefined();
    expect(pickDocumentToShow([])).toBeUndefined();
  });
});

describe('isProseDocumentPath', () => {
  it('accepts markdown anywhere, so a README in a repo gets the edit bar too', () => {
    expect(isProseDocumentPath('/repo/README.md')).toBe(true);
    expect(isProseDocumentPath('/repo/docs/adr/0001-thing.markdown')).toBe(true);
  });

  it('refuses source, which is what flows and agents are for', () => {
    for (const p of ['/repo/src/runtime.ts', '/repo/build.py', '/repo/notes.txt']) {
      expect(isProseDocumentPath(p)).toBe(false);
    }
  });
});

// The bug this predicate exists to stop: a project MOVED out of the managed
// folder kept the documents grid (flag-or-path call sites) while silently
// losing auto-save and the split default (path-only call sites).
describe('isEverydayProject', () => {
  it('recognises a scaffolded project wherever the folder now lives', () => {
    expect(
      isEverydayProject({ path: '/Users/me/Desktop/Moved out', everyday: true }),
    ).toBe(true);
  });

  it('recognises one made before the flag existed, by where it sits', () => {
    expect(
      isEverydayProject({ path: '/Users/me/Documents/Overcli Projects/Marketing101' }),
    ).toBe(true);
  });

  it('leaves an ordinary repo alone', () => {
    expect(isEverydayProject({ path: '/Users/me/git-services/overcli' })).toBe(false);
    expect(isEverydayProject({ path: '/Users/me/git-services/overcli', everyday: false })).toBe(false);
  });
});
