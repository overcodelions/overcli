import { afterEach, describe, expect, it } from 'vitest';
import { parseOrgPolicy } from '../../shared/org/policy';
import { resolveStepEffect } from '../flows/runtime';
import { setWebReadsTrusted } from '../flows/trustedCommands';
import { reachesOutside } from './orgService';

afterEach(() => setWebReadsTrusted(() => false));

describe('why a step asks first', () => {
  it('says what in the step reaches outside', () => {
    expect(reachesOutside({ role: 'researcher', tools: ['WebFetch', 'Read', 'Grep'] })).toEqual(['opens web pages']);
    expect(reachesOutside({ role: 'shipper', tools: ['Bash(git diff:*)', 'Bash(git push:*)'] })).toEqual(['ships its work (a push, a message or a publish)', 'runs git push']);
    expect(reachesOutside({ role: 'implementer', tools: ['mcp__jira__add_comment'] })).toEqual(['may change Jira (add comment)']);
    // What it changes leads; what it only reads is one line at the end.
    expect(
      reachesOutside({
        role: 'custom',
        tools: ['Read', 'Write', 'Edit', 'Bash', 'mcp__acme-tracker__note_list', 'mcp__acme-sales-official__search-records', 'mcp__claude_ai_Acme_Wiki__createIssue', 'mcp__claude_ai_Acme_Wiki__getIssue'],
      }),
    ).toEqual(['may change Acme Wiki (create issue)', 'runs shell commands', 'reads Acme Tracker, Acme Sales, Acme Wiki']);
  });
});

describe('reading the web on the org server', () => {
  const capture = { id: 'capture', role: 'researcher' as const, tools: ['WebFetch', 'Read', 'Glob', 'Grep'], output: 'capture.md' };

  it('asks first unless the server trusts web reads, and the org can turn that back on', () => {
    expect(resolveStepEffect(capture)).toBe('external');
    let needsApproval = false;
    setWebReadsTrusted(() => !needsApproval);
    expect(resolveStepEffect(capture)).toBe('local');
    expect(resolveStepEffect({ ...capture, tools: ['WebFetch', 'Bash'] })).toBe('external');
    needsApproval = true;
    expect(resolveStepEffect(capture)).toBe('external');
  });

  it('is a rule: safe fetches unless set, and the old switch still read', () => {
    expect(parseOrgPolicy({ name: 'Acme' }).policy.webFetch).toBe('safe');
    expect(parseOrgPolicy({ name: 'Acme', webNeedsApproval: true }).policy.webFetch).toBe('ask');
    expect(parseOrgPolicy({ name: 'Acme', webNeedsApproval: false }).policy.webFetch).toBe('any');
    expect(parseOrgPolicy({ name: 'Acme', webNeedsApproval: true, webFetch: 'safe' }).policy).toMatchObject({ webFetch: 'safe', webNeedsApproval: false });
    expect(parseOrgPolicy({ name: 'Acme', webFetch: 'sometimes' }).warnings.join(' ')).toContain('webFetch');
    const own = parseOrgPolicy({ name: 'Acme', ownDomains: ['acme.atlassian.net', 'not a site'] });
    expect(own.policy.ownDomains).toEqual(['acme.atlassian.net']);
    expect(own.warnings.join(' ')).toContain('ownDomains');
  });
});

describe('a step that only reads its trackers', () => {
  it('stays local even with the built-in Write and Edit beside them', async () => {
    const { resolveStepEffect } = await import('../flows/runtime');
    const step = { id: 'piece', role: 'custom' as const, output: 'piece.md', systemPromptOverride: 'Do your piece. Write files into your working folder.', tools: ['Read', 'Write', 'Edit', 'mcp__acme-tracker__feature_list', 'mcp__acme-tracker__release_list', 'mcp__zendesk__search'] };
    expect(resolveStepEffect(step)).toBe('local');
    expect(resolveStepEffect({ ...step, tools: [...step.tools, 'mcp__claude_ai_Acme_Wiki__createIssue'] })).toBe('external');
    // Words alone don't make it ask: nothing it may use could create one,
    // and a call off its list is refused on an unattended run.
    expect(resolveStepEffect({ ...step, systemPromptOverride: 'Create a Jira ticket for each finding.' })).toBe('local');
  });
});

