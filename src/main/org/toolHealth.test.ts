import { describe, expect, it } from 'vitest';
import { FAILING_AFTER, ToolHealth, classifyToolError, errorGist, missingScopes, type ToolTrouble } from './toolHealth';
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

describe('a file a tool would not write', () => {
  it('is the call’s fault, not a sign-in problem', () => {
    expect(classifyToolError('### Error\nError: File access denied: /data/projects/x.png is outside allowed roots. Allowed roots: /tmp/a')).toBe('failing');
    expect(classifyToolError('401 Unauthorized')).toBe('auth');
  });
});

describe('a browser tool’s errors', () => {
  const report = '### Error\nProvide either "text" or "regex" to search for.\n### Page\n- Page URL: https://app.acme.dev/x\n- HTTP status: 403\n### Events\n- New console entries: tmp/a.log';

  it('aren’t a sign-in problem because the page it was on said 403', () => {
    expect(classifyToolError(report)).toBe('failing');
    expect(classifyToolError(report, 'test-systems')).toBe('failing');
    expect(classifyToolError('### Error\nHTTP 403 Forbidden\n### Page\n- x')).toBe('auth');
  });

  it('are a sign-in problem for apps to test only when a test account can’t sign in', () => {
    expect(classifyToolError('Still on Billing’s sign-in page 30 seconds after signing in.', 'test-systems')).toBe('auth');
    expect(classifyToolError('Billing has no test account yet.', 'test-systems')).toBe('auth');
    expect(classifyToolError('Timeout waiting for 403 Forbidden text', 'test-systems')).toBe('failing');
  });

  it('don’t raise an alarm on one bad call, and keep the page out of what’s said', () => {
    const alerts: unknown[] = [];
    const h = new ToolHealth({ load: () => [], save: () => {}, alert: (t) => alerts.push(t), now: () => 1 });
    h.observe({ tool: 'test-systems', ok: false, text: report, worker: 'Robin' });
    expect(alerts).toEqual([]);
    for (let i = 0; i < FAILING_AFTER; i++) h.observe({ tool: 'test-systems', ok: false, text: report, worker: 'Robin' });
    expect(alerts).toHaveLength(1);
    expect(h.list()[0].lastError).not.toContain('HTTP status');
  });
});

describe('a key missing a permission', () => {
  const bb403 = 'Error: Access denied for api. Verify your credentials and permissions.\nHTTP Status: 403\n\nRaw API Response:\n{\n  "message": "Your credentials lack one or more required privilege scopes.",\n  "detail": {\n    "granted": ["read:repository:bitbucket"],\n    "required": ["read:workspace:bitbucket"]\n  }\n}';

  it('is not a sign-in failure, and names what it needs', () => {
    expect(classifyToolError(bb403)).toBe('scope');
    expect(classifyToolError('HTTP 403: Resource not accessible by personal access token')).toBe('scope');
    expect(classifyToolError('{"ok":false,"error":"missing_scope","needed":"files:write"}')).toBe('scope');
    expect(missingScopes(bb403)).toEqual(['read:workspace:bitbucket']);
    expect(missingScopes('{"error":"missing_scope","needed":"files:write,im:write"}')).toEqual(['files:write', 'im:write']);
    expect(classifyToolError('403 Forbidden')).toBe('auth');
  });

  it('waits for a run before raising, and a later sign-in failure takes over', () => {
    const { h, alerts } = health();
    h.observe({ tool: 'bitbucket', ok: false, text: bb403, worker: 'Triage' });
    h.observe({ tool: 'bitbucket', ok: false, text: bb403 });
    expect(alerts).toHaveLength(0);
    expect(h.list()).toEqual([]);
    for (let i = 2; i < FAILING_AFTER; i++) h.observe({ tool: 'bitbucket', ok: false, text: bb403 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'scope', missing: ['read:workspace:bitbucket'] });

    const fresh = health();
    fresh.h.observe({ tool: 'bitbucket', ok: false, text: bb403 });
    fresh.h.observe({ tool: 'bitbucket', ok: false, text: '401 Unauthorized' });
    expect(fresh.alerts).toHaveLength(1);
    expect(fresh.alerts[0].kind).toBe('auth');
  });

  it('keeps the whole error, and leads with what the API said', () => {
    const wrapped = 'Error: Access denied for api. Verify your credentials and permissions. Ensure your Bitbucket API token/app password has sufficient privileges and hasn\'t expired. If using a workspace/repository name, check that it\'s spelled correctly.\n' + bb403.slice(bb403.indexOf('HTTP Status'));
    const { h } = health();
    h.observe({ tool: 'bitbucket', ok: false, text: wrapped });
    const [t] = (h as unknown as { all: ToolTrouble[] }).all;
    expect(t.lastError).toContain('"required": ["read:workspace:bitbucket"]');
    expect(t.gist).toBe('Your credentials lack one or more required privilege scopes. (HTTP 403) Needs: read:workspace:bitbucket.');
    expect(errorGist('401 Unauthorized')).toBeUndefined();
  });

  it('clears on the next call that works', () => {
    const { h } = health();
    for (let i = 0; i < FAILING_AFTER; i++) h.observe({ tool: 'bitbucket', ok: false, text: bb403 });
    expect(h.list()).toHaveLength(1);
    h.observe({ tool: 'bitbucket', ok: true, text: '{}' });
    expect(h.list()).toEqual([]);
  });
});
