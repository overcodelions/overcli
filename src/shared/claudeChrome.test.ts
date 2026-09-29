import { describe, it, expect } from 'vitest';
import { chromeCommandVerdict, isChromeUnavailableNotice, lastChromeToolFailure } from './claudeChrome';

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

describe('chromeCommandVerdict', () => {
  const on = { backend: 'claude', chromeOn: true };
  const off = { backend: 'claude', chromeOn: false };

  it('rewrites /chrome <prose> to the prose when the tools are attached', () => {
    expect(chromeCommandVerdict('/chrome navigate to cnn', on)).toEqual({
      kind: 'rewrite',
      prose: 'navigate to cnn',
    });
  });

  it('blocks the same input when they are not, keeping the prose', () => {
    expect(chromeCommandVerdict('/chrome navigate to cnn', off)).toEqual({
      kind: 'blocked',
      prose: 'navigate to cnn',
    });
  });

  it('leaves a bare /chrome alone — that really is a picker request', () => {
    expect(chromeCommandVerdict('/chrome', on)).toEqual({ kind: 'pass' });
    expect(chromeCommandVerdict('  /chrome  ', off)).toEqual({ kind: 'pass' });
  });

  it('spans newlines and trims the captured prose', () => {
    expect(chromeCommandVerdict('/chrome navigate to cnn\nthen read it  ', on)).toEqual({
      kind: 'rewrite',
      prose: 'navigate to cnn\nthen read it',
    });
  });

  // The CLI only intercepts the exact lowercase token, so anything else is
  // already an ordinary prompt and must not be rewritten out from under the
  // user.
  it('does not touch inputs the CLI would not intercept', () => {
    expect(chromeCommandVerdict('/CHROME navigate to cnn', on)).toEqual({ kind: 'pass' });
    expect(chromeCommandVerdict('/chromecast something', on)).toEqual({ kind: 'pass' });
    expect(chromeCommandVerdict('use /chrome to navigate', on)).toEqual({ kind: 'pass' });
    expect(chromeCommandVerdict('navigate to cnn', on)).toEqual({ kind: 'pass' });
  });

  it('is claude-only — no other backend has the command', () => {
    expect(chromeCommandVerdict('/chrome navigate to cnn', { backend: 'codex', chromeOn: true }))
      .toEqual({ kind: 'pass' });
    expect(chromeCommandVerdict('/chrome navigate to cnn', { chromeOn: true }))
      .toEqual({ kind: 'pass' });
  });
});

describe('lastChromeToolFailure', () => {
  const user = { kind: { type: 'localUser' } };
  const use = (id: string, name: string) => ({
    kind: { type: 'assistant', info: { toolUses: [{ id, name }] } },
  });
  const result = (id: string, isError: boolean, content = 'x') => ({
    kind: { type: 'toolResult', results: [{ id, content, isError }] },
  });
  const nav = 'mcp__claude-in-chrome__navigate';

  it('reports a failed browser call in the latest turn', () => {
    expect(lastChromeToolFailure([user, use('a', nav), result('a', true, 'not connected')])).toEqual({
      id: 'a',
      content: 'not connected',
    });
  });

  it('clears once a later browser call in the turn succeeds', () => {
    expect(
      lastChromeToolFailure([user, use('a', nav), result('a', true), use('b', nav), result('b', false)]),
    ).toBeNull();
  });

  it('ignores failures from other tools', () => {
    expect(lastChromeToolFailure([user, use('a', 'Bash'), result('a', true)])).toBeNull();
  });

  it('forgets a failure from an earlier turn', () => {
    expect(lastChromeToolFailure([user, use('a', nav), result('a', true), user])).toBeNull();
  });
});
