/// How a link inside a preview frame reaches the user's browser.
///
/// On its own it never did. A preview frame is sandboxed onto an opaque
/// origin with no `allow-top-navigation`, so a `target="_top"` link is
/// refused; a same-frame navigation to https: is refused too, by the app's
/// own `frame-src` (see src/renderer/index.html). And main's
/// bounce-to-the-browser handlers (src/main/index.ts) only ever see
/// main-frame navigations and window.open — `will-navigate` does not fire
/// for a subframe — so nothing in the frame had a route to
/// `shell.openExternal`. Clicking a link in a rendered .html page or React
/// component simply did nothing.
///
/// The one route out is a popup: `allow-popups` on the frame plus the
/// interception below, which turns a click on an external link into a
/// `window.open`. That reaches Electron's `setWindowOpenHandler`, which
/// denies the popup and hands the URL to the OS through the same
/// `isSafeExternalUrl` allowlist every other link in the app goes through.
/// The frame gains nothing it can act on itself — every popup is denied.

/// Frames that are denied popups — a .html document, see `HtmlPreview` —
/// hand the URL to the app instead, as a message it opens only while the
/// click that sent it is still a live user activation (see
/// `acceptLinkMessage`). Anything the page's own script posts outside a
/// click is ignored, so this is no wider than the popup route it replaces.
export const OPEN_LINK_MESSAGE = 'overcli:open-link';

/// Only absolute http(s) links are intercepted, resolved against the
/// document's base. In-page anchors, `file:` refs and anything with an
/// exotic scheme keep whatever behaviour they had.
const linkScript = (open: string) => `
(function () {
  function handle(event) {
    if (event.defaultPrevented) return;
    var node = event.target;
    var anchor = node && node.closest ? node.closest('a[href]') : null;
    if (!anchor) return;
    var url;
    try { url = new URL(anchor.getAttribute('href') || '', document.baseURI); } catch (e) { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    event.preventDefault();
    ${open}
  }
  document.addEventListener('click', handle);
  // Middle-click fires auxclick, not click, and would otherwise be swallowed
  // by the sandbox with no handler having seen it.
  document.addEventListener('auxclick', function (event) {
    if (event.button === 1) handle(event);
  });
})();
`;

export function previewLinkScriptTag(route: 'popup' | 'parent' = 'popup'): string {
  const open =
    route === 'popup'
      ? "window.open(url.href, '_blank', 'noopener');"
      : `window.parent.postMessage({ type: '${OPEN_LINK_MESSAGE}', href: url.href }, '*');`;
  return `<script>${linkScript(open)}</script>`;
}

/// The URL a preview frame asked to open, if the app should open it: the
/// message came from that frame, is the link message, and arrived while a
/// user activation is live. A click inside a frame activates its ancestors
/// too, and a script cannot mint one, so this is exactly "someone clicked".
export function acceptLinkMessage(
  event: Pick<MessageEvent, 'source' | 'data'>,
  frame: Window | null | undefined,
  activated: boolean,
): string | null {
  if (!frame || event.source !== frame || !activated) return null;
  const data = event.data as { type?: unknown; href?: unknown } | null;
  if (!data || data.type !== OPEN_LINK_MESSAGE || typeof data.href !== 'string') return null;
  try {
    const url = new URL(data.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/// The markdown preview renders with scripts off, so its anchors are tagged
/// at build time instead — same destination, since `target="_blank"` in a
/// frame with `allow-popups` is also a window.open.
///
/// Runs over HTML this app generated and DOMPurify already sanitized (which
/// strips `target` itself — it isn't in the allowed-attribute list), so the
/// anchors it matches are the plain `<a href="…">` marked emits.
export function targetExternalLinks(html: string): string {
  return html.replace(/<a\s+([^>]*)>/gi, (match, attrs: string) => {
    if (!/href\s*=\s*"https?:\/\//i.test(attrs)) return match;
    if (/\btarget\s*=/i.test(attrs)) return match;
    return `<a ${attrs.trim()} target="_blank" rel="noopener noreferrer">`;
  });
}
