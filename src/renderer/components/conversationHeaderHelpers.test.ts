import { describe, expect, it } from 'vitest';
import {
  effortLabel,
  enabledBackends,
  isBackendEnabled,
  modeLabel,
  permissionTone,
  pickDefaultBackend,
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
  it('labels an empty override as automatic effort', () => {
    expect(effortLabel('')).toBe('Auto effort');
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
  it('returns all five when nothing is disabled', () => {
    expect(enabledBackends({})).toEqual(['claude', 'codex', 'gemini', 'copilot', 'ollama']);
  });

  it('filters out only the explicitly disabled', () => {
    expect(
      enabledBackends({ disabledBackends: { ollama: true, gemini: true, copilot: true } }),
    ).toEqual(['claude', 'codex']);
  });
});

describe('pickDefaultBackend', () => {
  const ready = { kind: 'ready' } as const;
  const missing = { kind: 'missing' } as const;
  const signedOut = { kind: 'unauthenticated' } as const;

  it('picks the first READY backend, not the first listed one', () => {
    // The regression this exists for: a machine with only Codex installed
    // opened every conversation on Claude and failed on the first send.
    expect(
      pickDefaultBackend({}, { claude: missing, codex: ready, gemini: missing }),
    ).toBe('codex');
  });

  it('honours an explicit preference even when it is not ready', () => {
    // The user asked for it; a probe is not grounds to override them.
    expect(
      pickDefaultBackend({ preferredBackend: 'gemini' }, { gemini: missing, codex: ready }),
    ).toBe('gemini');
  });

  it('ignores a preference for a backend that is disabled in settings', () => {
    expect(
      pickDefaultBackend(
        { preferredBackend: 'gemini', disabledBackends: { gemini: true } },
        { claude: missing, codex: ready },
      ),
    ).toBe('codex');
  });

  it('never picks a disabled backend, however healthy', () => {
    expect(
      pickDefaultBackend({ disabledBackends: { claude: true } }, { claude: ready, codex: ready }),
    ).toBe('codex');
  });

  it('falls back to enabled order when health has not been probed yet', () => {
    expect(pickDefaultBackend({})).toBe('claude');
    expect(pickDefaultBackend({}, {})).toBe('claude');
  });

  it('falls back to enabled order when nothing is ready', () => {
    // Signed-out counts as not ready: better to land on the list default
    // than to silently prefer whichever CLI happens to be signed out.
    expect(
      pickDefaultBackend({}, { claude: signedOut, codex: missing }),
    ).toBe('claude');
  });

  it('keeps list order among several ready backends', () => {
    expect(pickDefaultBackend({}, { claude: ready, codex: ready })).toBe('claude');
  });

  it('falls back to claude when every backend is disabled', () => {
    expect(
      pickDefaultBackend({
        disabledBackends: {
          claude: true,
          codex: true,
          gemini: true,
          copilot: true,
          ollama: true,
        },
      }),
    ).toBe('claude');
  });
});
