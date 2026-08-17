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

/// Only absolute http(s) links are intercepted, resolved against the
/// document's base. In-page anchors, `file:` refs and anything with an
/// exotic scheme keep whatever behaviour they had.
const LINK_SCRIPT = `
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
    window.open(url.href, '_blank', 'noopener');
  }
  document.addEventListener('click', handle);
  // Middle-click fires auxclick, not click, and would otherwise be swallowed
  // by the sandbox with no handler having seen it.
  document.addEventListener('auxclick', function (event) {
    if (event.button === 1) handle(event);
  });
})();
`;

export function previewLinkScriptTag(): string {
  return `<script>${LINK_SCRIPT}</script>`;
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
