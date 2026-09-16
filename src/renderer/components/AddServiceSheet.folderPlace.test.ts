import { describe, expect, it } from 'vitest';

import { folderPlace } from './AddServiceSheet';

describe('folderPlace', () => {
  it('names the service id after the folder', () => {
    expect(folderPlace('/Users/dev/acme-stats-svc').id).toMatch(/^folder-acme-stats-svc-/);
  });

  it('keeps two folders of the same name apart', () => {
    expect(folderPlace('/Users/dev/one/api').id).not.toBe(folderPlace('/Users/dev/two/api').id);
  });

  it('is the same id every time, so re-adding replaces rather than duplicates', () => {
    expect(folderPlace('/Users/dev/api').id).toBe(folderPlace('/Users/dev/api').id);
  });

  it('runs in the folder itself, under no project', () => {
    expect(folderPlace('/Users/dev/api')).toMatchObject({
      path: '/Users/dev/api',
      projectId: undefined,
    });
  });

  it('takes the last segment of a Windows path too', () => {
    expect(folderPlace('C:\\src\\acme-api').id).toMatch(/^folder-acme-api-/);
  });
});
