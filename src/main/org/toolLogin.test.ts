import { describe, expect, it } from 'vitest';
import { checkLogin, checkLoginByCall, loginProbes } from './toolLogin';

const answer = (status: number, body: unknown) => async () => ({ status, text: async () => JSON.stringify(body) });

describe('checking a tool’s sign-in', () => {
  const jira = { JIRA_URL: 'https://acme.atlassian.net', JIRA_USERNAME: 'pat@acme.example', JIRA_API_TOKEN: 'tok' };

  it('asks Jira who the keys are, and says who', async () => {
    const seen: string[] = [];
    const res = await checkLogin(jira, 5, async (url, init) => {
      seen.push(`${url} ${init.headers?.Authorization?.slice(0, 6)}`);
      return { status: 200, text: async () => JSON.stringify({ displayName: 'Pat Example' }) };
    });
    expect(seen).toEqual(['https://acme.atlassian.net/rest/api/2/myself Basic ']);
    expect(res).toEqual({ state: 'ok', as: 'Pat Example on Jira', at: 5 });
  });

  it('says plainly when Jira refuses them, and what to do', async () => {
    expect(await checkLogin(jira, 5, answer(401, { message: 'Client must be authenticated' }))).toEqual({
      state: 'rejected',
      reason: 'Jira didn’t accept JIRA_USERNAME / JIRA_API_TOKEN (401). Use a plain API token (not one “with scopes”), made by the account whose email is in JIRA_USERNAME.',
      at: 5,
    });
  });

  it('knows Confluence, GitHub and Linear, and nothing it can’t check', () => {
    expect(loginProbes({ CONFLUENCE_URL: 'https://acme.atlassian.net', CONFLUENCE_USERNAME: 'p', CONFLUENCE_API_TOKEN: 't' })[0].url).toBe('https://acme.atlassian.net/wiki/rest/api/user/current');
    expect(loginProbes({ GITHUB_TOKEN: 'x' })[0].url).toBe('https://api.github.com/user');
    expect(loginProbes({ LINEAR_API_KEY: 'x' })[0].method).toBe('POST');
    expect(loginProbes({ JIRA_URL: 'acme.atlassian.net', JIRA_USERNAME: 'p', JIRA_API_TOKEN: 't' })).toEqual([]);
    expect(loginProbes({ SOMETHING: 'x' })).toEqual([]);
  });

  it('for a tool it doesn’t know, reads one harmless call for a refusal', async () => {
    const list = async () => ({ ok: true as const, tools: [{ name: 'create_thing', inputSchema: {} }, { name: 'list_things', inputSchema: { required: [] } }] });
    expect(await checkLoginByCall(list, async () => ({ ok: true, text: 'Error: 401 Unauthorized' }), 'acme', 7)).toMatchObject({ state: 'rejected', reason: expect.stringContaining('list_things') });
    expect(await checkLoginByCall(list, async () => ({ ok: true, text: '[{"id":1}]' }), 'acme', 7)).toEqual({ state: 'ok', at: 7 });
    expect(await checkLoginByCall(async () => ({ ok: true as const, tools: [{ name: 'create_thing' }] }), async () => ({ ok: true, text: '' }), 'acme', 7)).toBeNull();
  });
});
