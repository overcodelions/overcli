import { describe, expect, it } from 'vitest';
import { suggestWorkspaceName } from './suggestWorkspaceName';

describe('suggestWorkspaceName', () => {
  it('uses a shared prefix as the name', () => {
    expect(suggestWorkspaceName(['acme-web', 'acme-api', 'acme-infra'])).toBe('acme');
  });

  it('ignores a prefix too short to mean anything', () => {
    expect(suggestWorkspaceName(['ab-web', 'ab-api'])).toBe('ab-web + ab-api');
  });

  it('joins two unrelated names', () => {
    expect(suggestWorkspaceName(['storefront', 'billing'])).toBe('storefront + billing');
  });

  it('summarises three or more unrelated names', () => {
    expect(suggestWorkspaceName(['storefront', 'billing', 'search'])).toBe('storefront + 2 more');
  });

  it('handles none and one', () => {
    expect(suggestWorkspaceName([])).toBe('');
    expect(suggestWorkspaceName(['acme-web'])).toBe('acme-web');
  });
});
