// @vitest-environment jsdom
//
// renderMarkdownHtml runs marked + DOMPurify, so it needs a DOM.

import { describe, expect, it } from 'vitest';
import { renderMarkdownHtml } from './Markdown';

describe('renderMarkdownHtml', () => {
  it('keeps a reply that is only disallowed raw HTML visible', () => {
    // A flow step's bare pointer: `marked` emits it as a raw HTML block,
    // DOMPurify drops the element, and a self-closing tag leaves no children
    // — so without the fallback the bubble renders empty.
    const html = renderMarkdownHtml(
      '<output name="release_readiness_report.md" file="draft.md" />',
    );
    expect(html).toContain('release_readiness_report.md');
    expect(html).toContain('draft.md');
    // Escaped, not live markup.
    expect(html).not.toMatch(/<output\b/);
  });

  it('renders ordinary markdown unchanged by the fallback', () => {
    const html = renderMarkdownHtml('# Heading\n\nSome **bold** text.');
    expect(html).toContain('<h1');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('# Heading</code>');
  });

  it('does not fall back for an image-only reply', () => {
    const html = renderMarkdownHtml('![alt](https://example.com/a.png)');
    expect(html).toContain('<img');
  });

  it('leaves an empty source empty', () => {
    expect(renderMarkdownHtml('   ').trim()).toBe('');
  });

  it('still strips genuinely dangerous HTML', () => {
    const html = renderMarkdownHtml('<script>alert(1)</script>');
    expect(html).not.toMatch(/<script/);
  });
});
