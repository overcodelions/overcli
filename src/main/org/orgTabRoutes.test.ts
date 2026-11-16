import { describe, expect, it } from 'vitest';
import { ORG_TAB_SLOW_MS, orgTabAllowed, orgTabTimeout } from './orgTabRoutes';

describe('orgTabAllowed', () => {
  it('lets through the daily loop and one worker\'s management', () => {
    for (const [m, p] of [
      ['GET', '/api/waiting'],
      ['GET', '/api/workers'],
      ['GET', '/api/workers/w-1/detail'],
      ['GET', '/api/workers/w-1/runs?limit=20&before=123'],
      ['GET', '/api/runs/r-1/steps'],
      ['POST', '/api/answer'],
      ['POST', '/api/approval'],
      ['POST', '/api/runs/r-1/stop'],
      ['POST', '/api/workers/w-1/paused'],
      ['POST', '/api/workers/w-1/update'],
      ['POST', '/api/workers/Mario%20Rossi/run'],
      ['GET', '/api/workers/w-1/tuning'],
      ['POST', '/api/workers/w-1/review'],
      ['POST', '/api/workers/w-1/reviews/rv-1/suggestions/s-1'],
      ['POST', '/api/workers/w-1/reviews/rv-1/suggestions/s-1/undo'],
      ['GET', '/api/workers/w-1/tuning/try/o-1?before=r-1'],
      ['POST', '/api/workers/w-1/suggest-job'],
    ]) expect(orgTabAllowed(m, p), `${m} ${p}`).toBe(true);
  });

  it('keeps org-wide admin, secrets and publishing on the console', () => {
    for (const [m, p] of [
      ['GET', '/api/admin/rules'],
      ['POST', '/api/admin/rules'],
      ['POST', '/api/admin/people/offboard'],
      ['GET', '/api/admin/secrets'],
      ['POST', '/api/publish'],
      ['POST', '/api/signout'],
      ['POST', '/api/devices'],
      ['GET', '/mcp'],
    ]) expect(orgTabAllowed(m, p), `${m} ${p}`).toBe(false);
  });

  it('refuses the wrong method, path tricks and a query on a change', () => {
    expect(orgTabAllowed('POST', '/api/waiting')).toBe(false);
    expect(orgTabAllowed('GET', '/api/answer')).toBe(false);
    expect(orgTabAllowed('GET', '/api/workers/../admin/rules')).toBe(false);
    expect(orgTabAllowed('GET', '/api/workers/w-1/detail/../../admin')).toBe(false);
    expect(orgTabAllowed('GET', '//evil.example/api/waiting')).toBe(false);
    expect(orgTabAllowed('GET', 'https://evil.example/api/waiting')).toBe(false);
    expect(orgTabAllowed('POST', '/api/answer?x=1')).toBe(false);
    expect(orgTabAllowed('GET', '/api/workers/a/b/detail')).toBe(false);
    // fetch would resolve these to /api/journal, /api/push, /api/run.
    expect(orgTabAllowed('GET', '/api/workers/%2e%2e/journal')).toBe(false);
    expect(orgTabAllowed('POST', '/api/runs/%2E%2E/push')).toBe(false);
    expect(orgTabAllowed('POST', '/api/workers/.%2e/run')).toBe(false);
    expect(orgTabAllowed('GET', '/api/workers/a%2Fb/detail')).toBe(false);
    expect(orgTabAllowed('GET', '/api/workers/./detail')).toBe(false);
  });
});

describe('orgTabTimeout', () => {
  it('waits minutes for what the server has its model write, and the usual time for the rest', () => {
    for (const p of ['/api/workers/w-1/suggest-job', '/api/workers/w-1/review', '/api/workers/w-1/how-it-works/suggest', '/api/workers/w-1/tuning/try']) expect(orgTabTimeout('POST', p), p).toBe(ORG_TAB_SLOW_MS);
    expect(orgTabTimeout('POST', '/api/workers/w-1/update')).toBeUndefined();
    expect(orgTabTimeout('GET', '/api/workers/w-1/tuning/try/o-1')).toBeUndefined();
    expect(orgTabTimeout('POST', '/api/answer')).toBeUndefined();
  });
});
