import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSilentLog, listSilentLog, log, logSilent } from './diagnostics';

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

  it('records levels', () => {
    log('info', 'x', 'hello');
    log('warn', 'y', 'careful');
    const list = listSilentLog();
    expect(list[0].level).toBe('info');
    expect(list[0].message).toBe('hello');
    expect(list[1].level).toBe('warn');
  });

  it('logSilent records at error level', () => {
    logSilent('s', new Error('boom'));
    expect(listSilentLog()[0].level).toBe('error');
  });

  it('normalizes a malformed level to info instead of storing it raw', () => {
    // The diagnostics:log IPC path can forward an undefined/garbage level
    // from a malformed renderer payload; it must not poison the buffer entry.
    log(undefined as unknown as 'info', 'x', 'no level');
    log('verbose' as unknown as 'info', 'y', 'bad level');
    const list = listSilentLog();
    expect(list[0].level).toBe('info');
    expect(list[0].message).toBe('no level');
    expect(list[1].level).toBe('info');
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
