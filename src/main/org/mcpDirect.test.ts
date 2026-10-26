import { describe, expect, it } from 'vitest';
import { unwrapResult } from './mcpDirect';
import { readShape } from './watchSetup';

describe('unwrapResult', () => {
  const answer = { total: 1, issues: [{ id: '1', key: 'ACME-412', status: { name: 'In Progress' } }] };

  it('takes the answer out of a { result: "<json>" } wrapper, so a watch finds the ticket in it', () => {
    const wrapped = { result: JSON.stringify(answer) };
    expect(readShape(wrapped, 'ACME-412')).toBeNull();
    expect(unwrapResult(wrapped)).toEqual(answer);
    expect(readShape(unwrapResult(wrapped), 'ACME-412')).toMatchObject({ itemsPath: 'issues', idPath: 'key', statusPath: 'status.name', status: 'In Progress' });
  });

  it('leaves real structured answers, and wrapped plain text, as they are', () => {
    expect(unwrapResult(answer)).toBe(answer);
    expect(unwrapResult({ result: 'All good' })).toEqual({ result: 'All good' });
    expect(unwrapResult({ a: '{}', b: '{}' })).toEqual({ a: '{}', b: '{}' });
    expect(unwrapResult(null)).toBeNull();
  });
});
