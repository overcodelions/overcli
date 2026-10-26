import { describe, expect, it } from 'vitest';
import { FAILING_AFTER, ToolHealth, classifyToolError, type ToolTrouble } from './toolHealth';
import { personOf } from './orgService';

function health() {
  let saved: ToolTrouble[] = [];
  const alerts: ToolTrouble[] = [];
  let now = 1_000_000;
  const h = new ToolHealth({ load: () => [], save: (a) => { saved = a; }, alert: (t) => alerts.push({ ...t }), now: () => now });
  return { h, alerts, saved: () => saved, tick: (ms: number) => { now += ms; } };
}

describe('tool health', () => {
  it('reads what an error says about the tool', () => {
    expect(classifyToolError('Request failed with status 403 Forbidden')).toBe('auth');
    expect(classifyToolError('Error: token has expired')).toBe('auth');
    expect(classifyToolError('This API version has been retired. Use v2.')).toBe('gone');
    expect(classifyToolError('Invalid argument: issueKey is required')).toBe('failing');
  });

  it('raises a sign-in failure at once, once a day, and clears on the next success', () => {
    const { h, alerts, tick } = health();
    h.observe({ tool: 'acme-tracker', ok: false, text: '401 Unauthorized', worker: 'Joe' });
    h.observe({ tool: 'acme-tracker', ok: false, text: '401 Unauthorized', worker: 'Triage' });
    expect(alerts).toHaveLength(1);
    expect(h.list()[0]).toMatchObject({ kind: 'auth', count: 2, workers: ['Joe', 'Triage'] });
    tick(25 * 3_600_000);
    h.observe({ tool: 'acme-tracker', ok: false, text: '401 Unauthorized' });
    expect(alerts).toHaveLength(2);
    h.observe({ tool: 'acme-tracker', ok: true, text: '{}' });
    expect(h.list()).toEqual([]);
  });

  it('waits for a run of other errors, and a success between starts over', () => {
    const { h, alerts } = health();
    for (let i = 0; i < FAILING_AFTER - 1; i++) h.observe({ tool: 'docs', ok: false, text: 'bad argument' });
    h.observe({ tool: 'docs', ok: true, text: 'ok' });
    for (let i = 0; i < FAILING_AFTER - 1; i++) h.observe({ tool: 'docs', ok: false, text: 'bad argument' });
    expect(alerts).toHaveLength(0);
    expect(h.list()).toEqual([]);
    h.observe({ tool: 'docs', ok: false, text: 'bad argument' });
    expect(alerts).toHaveLength(1);
  });

  it('tells a person from an account in who a tool signs in as', () => {
    expect(personOf('Lionel Farr on Jira')).toBe('Lionel Farr');
    expect(personOf('Acme Bot on Jira')).toBeNull();
    expect(personOf('svc-overgo@acme.com')).toBeNull();
    expect(personOf('jira-integration')).toBeNull();
  });
});
