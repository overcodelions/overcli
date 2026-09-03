import { describe, it, expect } from 'vitest';
import { isChromeUnavailableNotice } from './claudeChrome';

describe('isChromeUnavailableNotice', () => {
  // Verbatim from `claude -p --chrome "/chrome"` on 2.1.258. Note this same
  // line comes back WITHOUT --chrome too, which is exactly why the notice
  // must not be treated as "the setting is off".
  it('matches the CLI line', () => {
    expect(isChromeUnavailableNotice("/chrome isn't available in this environment.")).toBe(true);
  });

  it('tolerates surrounding whitespace and a missing period', () => {
    expect(isChromeUnavailableNotice("  /chrome isn't available in this environment  ")).toBe(true);
  });

  it('does not match the unknown-command reply', () => {
    expect(isChromeUnavailableNotice('Unknown command: /chrome')).toBe(false);
  });

  it('does not match prose that merely mentions it', () => {
    expect(
      isChromeUnavailableNotice("I tried /chrome but it isn't available in this environment."),
    ).toBe(false);
  });

  it('does not match the /design gate line', () => {
    expect(isChromeUnavailableNotice('Usage: /design consent | /design revoke')).toBe(false);
  });
});
