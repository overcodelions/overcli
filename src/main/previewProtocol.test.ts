import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}));

import {
  PREVIEW_SCHEME,
  documentIdFromUrl,
  publishPreviewDocument,
  resetPreviewDocuments,
} from './previewProtocol';

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
