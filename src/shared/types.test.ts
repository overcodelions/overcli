import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from './types';

describe('DEFAULT_SETTINGS', () => {
  it('matches the documented defaults (regression guard)', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      backendPaths: {},
      backendDefaultModels: {},
      defaultPermissionMode: 'plan',
      defaultEffort: '',
      agentBranchPrefix: 'agent/',
      showCost: false,
      autoDowngrade: true,
      theme: 'system',
      sidebarWidth: 260,
      editorPaneWidth: 540,
    });
  });

  it('is a plain object the caller can clone without surprises', () => {
    const clone = { ...DEFAULT_SETTINGS };
    clone.theme = 'dark';
    expect(DEFAULT_SETTINGS.theme).toBe('system');
  });
});
