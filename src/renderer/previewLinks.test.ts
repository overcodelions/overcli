import { describe, expect, it } from 'vitest';
import { acceptLinkMessage, OPEN_LINK_MESSAGE, previewLinkScriptTag, targetExternalLinks } from './previewLinks';

describe('previewLinkScriptTag', () => {
  it('opens external links in a popup, which main bounces to the browser', () => {
    const tag = previewLinkScriptTag();
    expect(tag.startsWith('<script>')).toBe(true);
    expect(tag).toContain("window.open(url.href, '_blank', 'noopener')");
    // Delegated, so links a page's own script adds later are covered too.
    expect(tag).toContain("document.addEventListener('click'");
    expect(tag).toContain("document.addEventListener('auxclick'");
  });

  it('cannot close its own script tag', () => {
    expect(previewLinkScriptTag().indexOf('</script')).toBe(previewLinkScriptTag().length - 9);
  });
});

describe('targetExternalLinks', () => {
  it('sends http(s) links to a new context', () => {
    expect(targetExternalLinks('<a href="https://example.com">x</a>')).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>',
    );
    expect(targetExternalLinks('<a href="http://example.com" title="t">x</a>')).toContain(
      'target="_blank"',
    );
  });

  it('leaves in-page anchors and other schemes alone', () => {
    for (const html of [
      '<a href="#section">x</a>',
      '<a href="notes.md">x</a>',
      '<a href="mailto:someone@example.com">x</a>',
    ]) {
      expect(targetExternalLinks(html)).toBe(html);
    }
  });

  it('does not override a target the markup already set', () => {
    const html = '<a href="https://example.com" target="_self">x</a>';
    expect(targetExternalLinks(html)).toBe(html);
  });

  it('handles several links in one document', () => {
    const out = targetExternalLinks(
      '<p><a href="https://a.example">a</a> and <a href="#b">b</a> and <a href="https://c.example">c</a></p>',
    );
    expect(out.match(/target="_blank"/g)).toHaveLength(2);
  });
});

describe('previewLinkScriptTag parent route', () => {
  it('posts the link to the app instead of opening a popup', () => {
    const tag = previewLinkScriptTag('parent');
    expect(tag).toContain(OPEN_LINK_MESSAGE);
    expect(tag).not.toContain('window.open');
  });
});

describe('acceptLinkMessage', () => {
  const frame = {} as Window;
  const msg = (data: unknown, source: unknown = frame) => ({ source: source as Window, data });

  it('opens a clicked https link from its own frame', () => {
    expect(acceptLinkMessage(msg({ type: OPEN_LINK_MESSAGE, href: 'https://meet.example.com/abc' }), frame, true)).toBe(
      'https://meet.example.com/abc',
    );
  });

  it('ignores a message sent with no click behind it', () => {
    expect(acceptLinkMessage(msg({ type: OPEN_LINK_MESSAGE, href: 'https://example.com' }), frame, false)).toBeNull();
  });

  it('ignores other frames, other messages and other schemes', () => {
    expect(acceptLinkMessage(msg({ type: OPEN_LINK_MESSAGE, href: 'https://example.com' }, {}), frame, true)).toBeNull();
    expect(acceptLinkMessage(msg({ type: 'other', href: 'https://example.com' }), frame, true)).toBeNull();
    expect(acceptLinkMessage(msg({ type: OPEN_LINK_MESSAGE, href: 'slack://open' }), frame, true)).toBeNull();
    expect(acceptLinkMessage(msg(null), frame, true)).toBeNull();
  });
});
