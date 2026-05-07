import { describe, expect, it } from 'vitest';
import {
  effortLabel,
  enabledBackends,
  isBackendEnabled,
  modeLabel,
  permissionTone,
} from './conversationHeaderHelpers';

describe('modeLabel', () => {
  it('renders human-friendly names for each mode', () => {
    expect(modeLabel('plan')).toBe('Plan');
    expect(modeLabel('auto')).toBe('Auto');
    expect(modeLabel('acceptEdits')).toBe('Accept edits');
    expect(modeLabel('bypassPermissions')).toBe('Bypass (dangerous)');
    expect(modeLabel('default')).toBe('Default');
  });
});

describe('permissionTone', () => {
  it('warns visually for the riskiest modes', () => {
    expect(permissionTone('bypassPermissions')).toBe('#f97a5a');
    expect(permissionTone('acceptEdits')).toBe('#f7b267');
  });

  it('returns undefined for safe modes', () => {
    expect(permissionTone('plan')).toBeUndefined();
    expect(permissionTone('default')).toBeUndefined();
    expect(permissionTone('auto')).toBeUndefined();
  });
});

describe('effortLabel', () => {
  it('returns the placeholder when effort is empty', () => {
    expect(effortLabel('')).toBe('Effort');
  });

  it('title-cases the effort name', () => {
    expect(effortLabel('low')).toBe('Low');
    expect(effortLabel('medium')).toBe('Medium');
    expect(effortLabel('high')).toBe('High');
    expect(effortLabel('max')).toBe('Max');
  });
});

describe('isBackendEnabled', () => {
  it('treats undefined disabled map as everything-enabled', () => {
    expect(isBackendEnabled({}, 'claude')).toBe(true);
  });

  it('only treats `true` as disabled', () => {
    expect(isBackendEnabled({ disabledBackends: { claude: true } }, 'claude')).toBe(false);
    expect(isBackendEnabled({ disabledBackends: { claude: false } }, 'claude')).toBe(true);
  });
});

describe('enabledBackends', () => {
  it('returns all four when nothing is disabled', () => {
    expect(enabledBackends({})).toEqual(['claude', 'codex', 'gemini', 'ollama']);
  });

  it('filters out only the explicitly disabled', () => {
    expect(
      enabledBackends({ disabledBackends: { ollama: true, gemini: true } }),
    ).toEqual(['claude', 'codex']);
  });
});
