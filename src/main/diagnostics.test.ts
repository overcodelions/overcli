import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSilentLog, listSilentLog, logSilent } from './diagnostics';

beforeEach(() => clearSilentLog());
afterEach(() => clearSilentLog());

describe('silentLog', () => {
  it('starts empty', () => {
    expect(listSilentLog()).toEqual([]);
  });

  it('records Error instances with stack', () => {
    logSilent('test.scope', new Error('boom'));
    const list = listSilentLog();
    expect(list).toHaveLength(1);
    expect(list[0].scope).toBe('test.scope');
    expect(list[0].message).toBe('boom');
    expect(list[0].stack).toContain('Error: boom');
  });

  it('records strings', () => {
    logSilent('s', 'something failed');
    const list = listSilentLog();
    expect(list[0].message).toBe('something failed');
    expect(list[0].stack).toBeUndefined();
  });

  it('records objects via JSON', () => {
    logSilent('s', { code: 42 });
    expect(listSilentLog()[0].message).toBe('{"code":42}');
  });

  it('caps the in-memory buffer at 500 entries', () => {
    for (let i = 0; i < 750; i++) logSilent('many', new Error(`#${i}`));
    const list = listSilentLog();
    expect(list).toHaveLength(500);
    expect(list[0].message).toBe('#250');
    expect(list[499].message).toBe('#749');
  });

  it('clear empties the buffer', () => {
    logSilent('s', new Error('x'));
    expect(listSilentLog()).toHaveLength(1);
    clearSilentLog();
    expect(listSilentLog()).toEqual([]);
  });
});
