import { describe, expect, it } from 'vitest';
import { DOCS_JS, docsHref, plainText, renderDocsPage } from './docsPages';

describe('the docs at /docs', () => {
  it('maps links between the docs to /docs addresses', () => {
    expect(docsHref('admins.md#setup--secrets')).toBe('/docs/admins#setup--secrets');
    expect(docsHref('../aws.md#secrets-policy')).toBe('/docs/aws#secrets-policy');
    expect(docsHref('../README.md')).toBe('/docs/operator');
    expect(docsHref('README.md')).toBe('/docs');
    expect(docsHref('https://api.slack.com/apps')).toBe('https://api.slack.com/apps');
  });

  it('renders each page with its sections anchored, and nothing else', () => {
    const admins = renderDocsPage('/docs/admins')!;
    expect(admins).toContain('<title>For admins · overgo docs</title>');
    expect(admins).toContain('id="setup--secrets"');
    expect(admins).toContain('aria-current="page"');
    expect(renderDocsPage('/docs/security')).toContain('href="/docs/admins#setup--secrets"');
    expect(renderDocsPage('/docs')).toContain('href="/docs/overview"');
    expect(renderDocsPage('/docs/../package')).toBeNull();
    expect(renderDocsPage('/docs/nope')).toBeNull();
  });

  it('groups the sidebar, lists the page\'s sections and links the next page', () => {
    const security = renderDocsPage('/docs/security')!;
    expect(security).toContain('<div class="docs-group">Run it</div>');
    expect(security).toMatch(/<aside class="docs-toc"[^>]*>.*href="#reading-the-web"/s);
    expect(security).toMatch(/class="docs-pager".*← Previous.*Next →/s);
    expect(security).toContain('Google Cloud <span class="docs-alpha">alpha</span>');
    // The CSP runs no inline script and allows no style attributes.
    expect(security).not.toMatch(/style="/);
    expect(security).not.toMatch(/<script>(?!\s*<\/script>)/);
  });

  it('draws GitHub alert blocks as callouts', () => {
    const security = renderDocsPage('/docs/security')!;
    expect(security).toContain('<blockquote class="callout warning"><p class="callout-title">The risk</p>');
    expect(security).toContain('<blockquote class="callout tip"><p class="callout-title">What to do</p>');
    expect(security).not.toContain('[!WARNING]');
  });

  it('carries a search index of every page, and a script that parses', () => {
    const page = renderDocsPage('/docs')!;
    const index = JSON.parse(/id="docs-index">([^<]*)</.exec(page)![1]) as Array<{ t: string; u: string; h: string[][] }>;
    expect(index.map((p) => p.u)).toContain('/docs/security');
    expect(index.find((p) => p.u === '/docs/security')!.h.map((h) => h[1])).toContain('reading-the-web');
    expect(() => new Function(DOCS_JS)).not.toThrow();
  });

  it('draws a flow block as a diagram, keeping its text escaped', () => {
    const overview = renderDocsPage('/docs/overview')!;
    expect(overview).toContain('<figure class="flow">');
    expect(overview).toMatch(/<span class="flow-n">1<\/span><div><b>Who should take it\?<\/b>/);
    expect(overview).toContain('Open a pull request: &lt;link&gt;');
    expect(overview).not.toContain('language-flow');
    // Section titles come escaped from marked once, not twice.
    expect(overview).not.toContain('&amp;quot;');
  });

  it('leaves no markup in the text of a heading, even a tag inside a tag', () => {
    expect(plainText('Run <code>npm test</code> first')).toBe('Run npm test first');
    expect(plainText('<<b>script>alert(1)<</b>/script>')).not.toMatch(/[<>]/);
    expect(plainText('a &amp; b')).toBe('a &amp; b');
  });
});
