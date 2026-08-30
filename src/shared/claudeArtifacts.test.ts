import { describe, it, expect } from 'vitest';
import { CLAUDE_ARTIFACT_ENV, claudeArtifactEnv, isDesignUnavailableNotice } from './claudeArtifacts';

describe('claudeArtifactEnv', () => {
  it('sets the gate var when enabled', () => {
    expect(claudeArtifactEnv(true)).toEqual({ [CLAUDE_ARTIFACT_ENV]: '1' });
  });

  // The CLI reads an explicitly falsy value as "artifacts off", which is not
  // the same as leaving the decision alone — so the off state must produce no
  // key at all rather than a '0'.
  it('omits the var entirely when off or unset', () => {
    expect(claudeArtifactEnv(false)).toEqual({});
    expect(claudeArtifactEnv(undefined)).toEqual({});
  });
});

describe('isDesignUnavailableNotice', () => {
  it('matches the gated /design usage line', () => {
    expect(isDesignUnavailableNotice('Usage: /design consent | /design revoke')).toBe(true);
  });

  it('tolerates surrounding whitespace and case', () => {
    expect(isDesignUnavailableNotice('  usage: /design consent | /design revoke  ')).toBe(true);
    expect(isDesignUnavailableNotice('Usage: /design consent  |  /design revoke')).toBe(true);
  });

  it('does not match a reply that merely mentions the command', () => {
    expect(isDesignUnavailableNotice('Run /design consent to grant access.')).toBe(false);
    expect(isDesignUnavailableNotice('Usage: /design consent | /design revoke — and then some')).toBe(false);
    expect(isDesignUnavailableNotice('')).toBe(false);
  });
});
