/// The document that hosts a compiled React component.
///
/// It is published to main and served over `overcli-preview://` (see
/// src/main/previewProtocol.ts) rather than handed to the iframe as
/// srcDoc, because a srcDoc frame inherits the app's `script-src 'self'`
/// and the bundle would never run.
///
/// The frame itself is `sandbox="allow-scripts"` and deliberately not
/// `allow-same-origin`: the component executes on an opaque origin with no
/// reach into Overcli's DOM, storage, or IPC. It is the user's own code,
/// but it is also code an agent just wrote, and the isolation costs
/// nothing — everything it needs is already inlined by the bundler.

import type { ReactPreviewBundleResult } from '@shared/types';

type SuccessfulBundle = Extract<ReactPreviewBundleResult, { ok: true }>;

export type PreviewBackground = 'light' | 'dark';

export function buildReactPreviewDocument(
  bundle: SuccessfulBundle,
  background: PreviewBackground,
): string {
  const dark = background === 'dark';
  return [
    '<!DOCTYPE html>',
    `<html lang="en"${dark ? ' class="dark"' : ''}>`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${shellStyles(dark)}</style>`,
    styleTag(bundle.tailwindCss),
    styleTag(bundle.css),
    '</head>',
    '<body>',
    `<div id="${bundle.rootElementId}"></div>`,
    `<script>${escapeScript(bundle.js)}</script>`,
    '</body>',
    '</html>',
  ].join('');
}

/// The bare minimum so an unstyled component is still legible, and a
/// visible box for the errors the bundle's boundary renders. Anything
/// more would fight the design being previewed.
function shellStyles(dark: boolean): string {
  return `
    :root { color-scheme: ${dark ? 'dark' : 'light'}; }
    html, body { margin: 0; padding: 0; min-height: 100%; }
    body { background: ${dark ? '#0b0f14' : '#ffffff'}; color: ${dark ? '#e6edf3' : '#111827'}; }
    .overcli-preview-error {
      margin: 12px;
      padding: 12px 14px;
      border: 1px solid ${dark ? '#5b2330' : '#f3c2c2'};
      border-radius: 8px;
      background: ${dark ? '#241419' : '#fff5f5'};
      color: ${dark ? '#ffb4b4' : '#9b1c1c'};
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `;
}

function styleTag(css: string | undefined): string {
  if (!css || !css.trim()) return '';
  return `<style>${escapeStyle(css)}</style>`;
}

/// A `</script>` anywhere in a bundled string literal would close the tag
/// early and leave the rest of the bundle as page text.
function escapeScript(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script');
}

function escapeStyle(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}
