import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}));

import { protocol } from 'electron';
import {
  PREVIEW_SCHEME,
  documentIdFromUrl,
  handlePreviewProtocol,
  publishPreviewDocument,
  resetPreviewDocuments,
} from './previewProtocol';

/// Serve a published url through the registered protocol handler, the way
/// the frame would.
async function fetchPreview(url: string): Promise<Response> {
  const handle = vi.mocked(protocol.handle);
  handle.mockClear();
  handlePreviewProtocol();
  const handler = handle.mock.calls.at(-1)?.[1] as (req: { url: string }) => Response;
  return handler({ url });
}

beforeEach(() => {
  resetPreviewDocuments();
});

describe('publishPreviewDocument', () => {
  it('hands back an unguessable url on its own scheme', () => {
    const res = publishPreviewDocument('<html><body>hi</body></html>');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.url.startsWith(`${PREVIEW_SCHEME}://render/`)).toBe(true);
    expect(documentIdFromUrl(res.url)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives every publish its own url', () => {
    const a = publishPreviewDocument('<html>a</html>');
    const b = publishPreviewDocument('<html>b</html>');
    expect(a.ok && b.ok && a.url).not.toBe(b.ok && b.url);
  });

  it('rejects an empty document', () => {
    expect(publishPreviewDocument('')).toEqual({ ok: false, error: 'Preview document is empty.' });
  });

  it('rejects a document past the size ceiling', () => {
    const huge = 'x'.repeat(33 * 1024 * 1024);
    expect(publishPreviewDocument(huge)).toEqual({
      ok: false,
      error: 'Preview document is too large to render.',
    });
  });
});

describe('documentIdFromUrl', () => {
  it('reads the id out of a preview url', () => {
    expect(documentIdFromUrl('overcli-preview://render/abc-123')).toBe('abc-123');
  });

  it('returns null for a url with no document', () => {
    expect(documentIdFromUrl('overcli-preview://render/')).toBeNull();
    expect(documentIdFromUrl('not a url')).toBeNull();
  });
});

describe('the policy a served document carries', () => {
  it('lets a hand-written page load the CDN scripts it is built from', async () => {
    const published = publishPreviewDocument('<html><body>page</body></html>', 'document');
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const res = await fetchPreview(published.url);
    const csp = res.headers.get('content-security-policy') ?? '';
    // React + Babel from unpkg, Tailwind from its CDN, and the eval an
    // in-page JSX compiler runs on — without these the page paints blank.
    expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval' https:");
    expect(await res.text()).toContain('page');
  });

  it('still refuses remote script for a bundle Overcli compiled itself', async () => {
    const published = publishPreviewDocument('<html><body>bundle</body></html>');
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const csp = (await fetchPreview(published.url)).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).not.toContain('https: ;');
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('never grants a preview anything by default', async () => {
    const published = publishPreviewDocument('<html></html>', 'document');
    if (!published.ok) return;
    const csp = (await fetchPreview(published.url)).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-src 'none'");
  });

  it('404s a url whose document has been evicted', async () => {
    const published = publishPreviewDocument('<html></html>');
    if (!published.ok) return;
    resetPreviewDocuments();
    expect((await fetchPreview(published.url)).status).toBe(404);
  });
});
