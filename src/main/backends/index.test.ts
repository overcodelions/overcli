import { describe, expect, it } from 'vitest';
import type { Backend } from '../../shared/types';
import { getBackendSpec } from './index';

describe('getBackendSpec', () => {
  it('returns a spec for every backend in the union', () => {
    const all: Backend[] = ['claude', 'codex', 'gemini', 'ollama'];
    for (const name of all) {
      const spec = getBackendSpec(name);
      expect(spec).toBeDefined();
      expect(spec.name).toBe(name);
      expect(typeof spec.buildArgs).toBe('function');
      expect(typeof spec.buildEnvelope).toBe('function');
    }
  });
});
