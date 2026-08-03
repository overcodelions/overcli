/// Inlining for the HTML preview iframe.
///
/// The iframe runs with `sandbox=""`, which puts the document on an opaque
/// origin, and an opaque-origin document may not load `file://`
/// subresources — so a sibling `styles.css` reached through `<base>` is
/// silently blocked and the page renders unstyled. We instead collect the
/// local refs a document mentions, have the main process read them (under
/// the same registered-root guard as every other fs handler), and fold the
/// bytes into the document itself before handing it to the iframe.

import type { HtmlPreviewAsset } from '@shared/types';

const LINK_TAG = /<link\b[^>]*>/gi;
const MEDIA_TAG = /<(?:img|source|video|audio|embed|input)\b[^>]*>/gi;
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

/// Every local file the document points at: stylesheet links, media `src`
/// / `poster` attributes, and `url(...)` refs inside `<style>` blocks or
/// inline `style` attributes.
export function collectHtmlAssetRefs(html: string): string[] {
  const refs = new Set<string>();
  for (const tag of html.match(LINK_TAG) ?? []) {
    if (!isStylesheetLink(tag)) continue;
    const href = attributeValue(tag, 'href');
    if (href && isLocalAssetRef(href)) refs.add(href);
  }
  for (const tag of html.match(MEDIA_TAG) ?? []) {
    for (const name of ['src', 'poster']) {
      const value = attributeValue(tag, name);
      if (value && isLocalAssetRef(value)) refs.add(value);
    }
  }
  for (const match of html.matchAll(CSS_URL)) {
    if (isLocalAssetRef(match[2])) refs.add(match[2]);
  }
  return [...refs];
}

/// Refs that point at a file on disk next to the document. Absolute URLs
/// are left alone — the sandbox still lets the iframe fetch them, and
/// rewriting them would be wrong anyway.
export function isLocalAssetRef(ref: string): boolean {
  const trimmed = ref.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#')) return false;
  if (trimmed.startsWith('//')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

/// Replace each resolved ref with its bytes. Refs that failed to resolve
/// are left exactly as they were, so a document with one missing asset
/// still previews with the rest of its styling.
export function inlineHtmlAssets(html: string, assets: Record<string, HtmlPreviewAsset>): string {
  const css = (ref: string) => {
    const asset = assets[ref];
    return asset?.ok && asset.kind === 'css' ? asset.text : null;
  };
  const dataUrl = (ref: string) => {
    const asset = assets[ref];
    return asset?.ok && asset.kind === 'data' ? asset.dataUrl : null;
  };

  let out = html.replace(LINK_TAG, (tag) => {
    if (!isStylesheetLink(tag)) return tag;
    const href = attributeValue(tag, 'href');
    const text = href ? css(href) : null;
    return text == null ? tag : `<style>\n${text}\n</style>`;
  });

  out = out.replace(MEDIA_TAG, (tag) => {
    let next = tag;
    for (const name of ['src', 'poster']) {
      const value = attributeValue(next, name);
      const url = value ? dataUrl(value) : null;
      if (url != null && value) next = replaceAttributeValue(next, name, url);
    }
    return next;
  });

  return out.replace(CSS_URL, (match, _quote: string, ref: string) => {
    const url = dataUrl(ref);
    return url == null ? match : `url("${url}")`;
  });
}

function isStylesheetLink(tag: string): boolean {
  const rel = attributeValue(tag, 'rel');
  return !!rel && rel.toLowerCase().split(/\s+/).includes('stylesheet');
}

function attributeValue(tag: string, name: string): string | null {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'),
  );
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

function replaceAttributeValue(tag: string, name: string, value: string): string {
  return tag.replace(
    new RegExp(`(\\b${name}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`, 'i'),
    (_m, prefix: string) => `${prefix}"${value.replace(/"/g, '&quot;')}"`,
  );
}
