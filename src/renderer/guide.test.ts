import { describe, expect, it } from 'vitest';
import {
  GUIDE_PAGES,
  GUIDE_URL,
  absolutizeGuideLinks,
  buildGuidePages,
  headingSlug,
  headingSlugs,
  resolveGuideLink,
} from './guide';

describe('GUIDE_PAGES', () => {
  it('bundles the guide from docs/guide, start page first', () => {
    expect(GUIDE_PAGES[0]?.slug).toBe('README');
    expect(GUIDE_PAGES.map((p) => p.slug)).toContain('getting-started');
    for (const page of GUIDE_PAGES) expect(page.source.length).toBeGreaterThan(0);
  });

  it('every link between guide pages points at a page that exists', () => {
    for (const page of GUIDE_PAGES) {
      const md = absolutizeGuideLinks(page.source, page.slug);
      for (const [, href] of md.matchAll(/\]\((https:[^)\s]+)\)/g)) {
        if (!href.startsWith(GUIDE_URL)) continue;
        const link = resolveGuideLink(href, GUIDE_PAGES);
        expect(link.kind, `${page.slug} → ${href}`).toBe('page');
      }
    }
  });
});

describe('buildGuidePages', () => {
  it('keeps the nav order, drops missing pages and appends unknown ones', () => {
    const pages = buildGuidePages({
      '/x/docs/guide/flows.md': '# Flows',
      '/x/docs/guide/README.md': '# Guide',
      '/x/docs/guide/extra.md': '# Something *new*',
    });
    expect(pages.map((p) => [p.slug, p.label])).toEqual([
      ['README', 'Start here'],
      ['flows', 'Flows'],
      ['extra', 'Something new'],
    ]);
  });
});

describe('absolutizeGuideLinks', () => {
  it('resolves sibling pages, anchors and repo files against the page', () => {
    const md = [
      '[a](concepts.md#run-modes)',
      '[b](../../deploy/README.md)',
      '[c](#local)',
      '[d](https://ollama.com)',
    ].join(' ');
    expect(absolutizeGuideLinks(md, 'flows')).toBe(
      [
        `[a](${GUIDE_URL}concepts.md#run-modes)`,
        '[b](https://github.com/overcodelions/overcli/blob/master/deploy/README.md)',
        `[c](${GUIDE_URL}flows.md#local)`,
        '[d](https://ollama.com)',
      ].join(' '),
    );
  });
});

describe('resolveGuideLink', () => {
  const pages = buildGuidePages({ 'README.md': '', 'concepts.md': '' });

  it('stays in the guide for its own pages', () => {
    expect(resolveGuideLink(`${GUIDE_URL}concepts.md#run-modes`, pages)).toEqual({
      kind: 'page',
      slug: 'concepts',
      anchor: 'run-modes',
    });
    expect(resolveGuideLink(`${GUIDE_URL}README.md`, pages)).toEqual({
      kind: 'page',
      slug: 'README',
      anchor: null,
    });
  });

  it('leaves for the browser otherwise', () => {
    expect(resolveGuideLink(`${GUIDE_URL}missing.md`, pages).kind).toBe('external');
    expect(resolveGuideLink('https://overcli.app', pages).kind).toBe('external');
  });
});

describe('headingSlug', () => {
  it('matches GitHub anchors', () => {
    expect(headingSlug('Rebound: a second model reviews each turn')).toBe(
      'rebound-a-second-model-reviews-each-turn',
    );
    expect(headingSlug('Trust: probation → trusted → autonomous')).toBe(
      'trust-probation--trusted--autonomous',
    );
    expect(headingSlugs(['Setup', 'Setup', 'Other'])).toEqual(['setup', 'setup-1', 'other']);
  });
});
