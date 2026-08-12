import { describe, expect, it } from 'vitest';
import { collectHtmlAssetRefs, inlineHtmlAssets, isLocalAssetRef } from './htmlPreview';

describe('collectHtmlAssetRefs', () => {
  it('finds stylesheet links, media sources, and css url() refs', () => {
    const html = [
      '<link rel="stylesheet" href="styles.css">',
      "<link rel='preload' href='ignored.css'>",
      '<img src="assets/logo.png" alt="">',
      '<video poster="poster.jpg"></video>',
      '<style>body { background: url(bg/hero.webp); }</style>',
      '<div style="background-image:url(\'inline.png\')"></div>',
    ].join('\n');
    expect(collectHtmlAssetRefs(html)).toEqual([
      'styles.css',
      'assets/logo.png',
      'poster.jpg',
      'bg/hero.webp',
      'inline.png',
    ]);
  });

  it('skips remote and inline refs', () => {
    const html = [
      '<link rel="stylesheet" href="https://cdn.example.com/a.css">',
      '<link rel="stylesheet" href="//cdn.example.com/b.css">',
      '<img src="data:image/png;base64,AAAA">',
      '<style>a { background: url(#gradient); }</style>',
    ].join('\n');
    expect(collectHtmlAssetRefs(html)).toEqual([]);
  });

  it('reads unquoted and multi-valued rel attributes', () => {
    const html = '<link rel=stylesheet href=main.css><link rel="alternate stylesheet" href="alt.css">';
    expect(collectHtmlAssetRefs(html)).toEqual(['main.css', 'alt.css']);
  });
});

describe('isLocalAssetRef', () => {
  it.each(['styles.css', './a/b.css', '../up.css', '/root.css'])('accepts %s', (ref) => {
    expect(isLocalAssetRef(ref)).toBe(true);
  });

  it.each(['http://x/a.css', 'https://x/a.css', '//x/a.css', 'data:text/css,a', '#frag', '  '])(
    'rejects %s',
    (ref) => {
      expect(isLocalAssetRef(ref)).toBe(false);
    },
  );
});

describe('inlineHtmlAssets', () => {
  it('replaces a stylesheet link with its text', () => {
    const out = inlineHtmlAssets('<head><link rel="stylesheet" href="styles.css"></head>', {
      'styles.css': { ok: true, kind: 'css', text: 'body{color:red}' },
    });
    expect(out).toContain('<style>\nbody{color:red}\n</style>');
    expect(out).not.toContain('<link');
  });

  it('rewrites media sources and css url() refs to data urls', () => {
    const out = inlineHtmlAssets(
      '<img src="logo.png"><style>body{background:url(logo.png)}</style>',
      { 'logo.png': { ok: true, kind: 'data', dataUrl: 'data:image/png;base64,AAAA' } },
    );
    expect(out).toBe(
      '<img src="data:image/png;base64,AAAA"><style>body{background:url("data:image/png;base64,AAAA")}</style>',
    );
  });

  it('leaves unresolved refs untouched so the rest still renders', () => {
    const html = '<link rel="stylesheet" href="missing.css"><img src="gone.png">';
    expect(
      inlineHtmlAssets(html, { 'missing.css': { ok: false, error: 'nope' } }),
    ).toBe(html);
  });

  it('does not touch remote stylesheet links', () => {
    const html = '<link rel="stylesheet" href="https://cdn.example.com/a.css">';
    expect(inlineHtmlAssets(html, {})).toBe(html);
  });
});
