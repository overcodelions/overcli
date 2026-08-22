// The SDK's `pathToClaudeCodeExecutable` must be undefined (not null) when no
// install is found — null would suppress the SDK's own fallback resolution.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const resolveBackendPath = vi.fn();
vi.mock('./backendPaths', () => ({ resolveBackendPath: (...a: unknown[]) => resolveBackendPath(...a) }));

import { claudeSdkExecutablePath } from './claudeSdkExecutable';

beforeEach(() => {
  resolveBackendPath.mockReset();
});

describe('claudeSdkExecutablePath', () => {
  it('returns the resolved install path', () => {
    resolveBackendPath.mockReturnValue('/usr/local/bin/claude');
    expect(claudeSdkExecutablePath()).toBe('/usr/local/bin/claude');
  });

  it('converts a null resolution to undefined', () => {
    resolveBackendPath.mockReturnValue(null);
    expect(claudeSdkExecutablePath()).toBeUndefined();
  });

  it('forwards the settings override and asks for the claude backend', () => {
    resolveBackendPath.mockReturnValue('/opt/claude');
    claudeSdkExecutablePath('/opt/claude');
    expect(resolveBackendPath).toHaveBeenCalledWith('claude', '/opt/claude');
  });
});
