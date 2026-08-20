import { describe, expect, it } from 'vitest';
import { effortForBackend, effortSupported } from './effort';

const settings = (
  defaultEffort: '' | 'low' | 'medium' | 'high' | 'max',
  perBackend?: Record<string, '' | 'low' | 'medium' | 'high' | 'max'>,
) => ({ defaultEffort, backendDefaultEfforts: perBackend }) as Parameters<typeof effortForBackend>[0];

describe('effortForBackend', () => {
  it('falls back to the global default when the backend has no entry', () => {
    expect(effortForBackend(settings('high'), 'claude')).toBe('high');
  });

  it('prefers the per-backend override', () => {
    expect(effortForBackend(settings('high', { claude: 'medium' }), 'claude')).toBe('medium');
  });

  it('leaves other backends on the global default', () => {
    const s = settings('high', { claude: 'medium' });
    expect(effortForBackend(s, 'claude')).toBe('medium');
    expect(effortForBackend(s, 'codex')).toBe('high');
  });

  it('lets an explicit Auto override a non-Auto default', () => {
    // The whole point of the per-backend map: pinning one backend to Auto
    // while the global default stays high must not read as "unset".
    expect(effortForBackend(settings('high', { codex: '' }), 'codex')).toBe('');
  });

  it('handles settings saved before the per-backend map existed', () => {
    expect(effortForBackend({ defaultEffort: 'low' }, 'claude')).toBe('low');
  });

  it('falls back to the global default with no backend', () => {
    expect(effortForBackend(settings('max', { claude: 'low' }), undefined)).toBe('max');
  });
});

describe('effortSupported', () => {
  it('covers the backends with a reasoning knob and no others', () => {
    expect(effortSupported('claude')).toBe(true);
    expect(effortSupported('codex')).toBe(true);
    expect(effortSupported('gemini')).toBe(false);
    expect(effortSupported('ollama')).toBe(false);
    expect(effortSupported('copilot')).toBe(false);
  });
});
