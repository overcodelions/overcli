import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { buildBackendEnv } from './backendPaths';

describe('buildBackendEnv', () => {
  it('prepends the preferred binary dir and preserves the existing PATH', () => {
    const existing = ['/usr/bin', '/bin'].join(path.delimiter);
    const out = buildBackendEnv({ PATH: existing, FOO: 'bar' }, '/opt/claude/bin/claude');
    expect(out.FOO).toBe('bar');
    const parts = (out.PATH ?? '').split(path.delimiter);
    expect(parts[0]).toBe('/opt/claude/bin');
    expect(parts).toContain('/usr/bin');
    expect(parts).toContain('/bin');
  });

  it('deduplicates entries so the preferred dir does not appear twice', () => {
    const out = buildBackendEnv(
      { PATH: ['/opt/tool/bin', '/usr/bin'].join(path.delimiter) },
      '/opt/tool/bin/tool',
    );
    const parts = (out.PATH ?? '').split(path.delimiter);
    const occurrences = parts.filter((p) => p === '/opt/tool/bin').length;
    expect(occurrences).toBe(1);
    expect(parts[0]).toBe('/opt/tool/bin');
  });

  it('is a no-op-preserving shape when no preferred binary is supplied', () => {
    const out = buildBackendEnv({ PATH: '/usr/bin' });
    const parts = (out.PATH ?? '').split(path.delimiter);
    expect(parts).toContain('/usr/bin');
    // Common-bin dirs were injected — PATH should not be empty.
    expect(parts.length).toBeGreaterThan(1);
  });

  it('ignores a preferred binary with no directory component', () => {
    const out = buildBackendEnv({ PATH: '/usr/bin' }, 'claude');
    // No bare "." should appear at the front — the "." fallback path is skipped.
    const parts = (out.PATH ?? '').split(path.delimiter);
    expect(parts[0]).not.toBe('.');
  });
});
