// Once the server has pushed a worker's branch, the ticket it was for is told:
// a comment with what changed and the link to open the pull request, and the
// ticket moved on to review. The link only exists after the run has ended, so
// no step of the run could do it; the worker does it in a small run of its
// own, with its own tracker tool, as far as its trust lets it act.

import type { FlowRun } from '../../shared/flows/schema';
import { flowRunTitle } from '../../shared/flows/schema';
import type { Landed } from './landBranches';

/// The step id a trusted coding worker's grant names (TICKET_STEP_GRANT).
export const TICKET_STEP = 'ticket-update';

/// The first ticket key a run names in its title or ask (ACME-412).
export function ticketOf(run: Pick<FlowRun, 'userPrompt'> & Parameters<typeof flowRunTitle>[0]): string | null {
  const m = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/.exec(`${flowRunTitle(run)}\n${run.userPrompt ?? ''}`);
  return m ? m[1] : null;
}

/// Its tracker: the first of its tools that looks like Jira.
export function trackerOf(mcpServers: readonly string[] | undefined): string | null {
  return (mcpServers ?? []).find((s) => /jira|atlassian/i.test(s)) ?? null;
}

/// The flow's id for a tracker, by its tool's name.
export function ticketFlowId(server: string): string {
  return `org-ticket-actions-${server.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/// "Ticket actions": one step, the tracker's tools whole and nothing else.
/// Every worker with a tracker has it beside its other flows, so an ask that
/// only changes a ticket (a comment, an assignee, a status) runs here rather
/// than through a coding flow; and the comment after a push runs here too.
export function ticketFlowYaml(server: string): string {
  const tool = `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return [
    'name: Ticket actions',
    'description: |',
    `  Comments on, assigns or moves a ticket in ${server}, and nothing else: no code, no other tickets.`,
    '  For an ask that only changes a ticket.',
    'input: user_prompt',
    'steps:',
    `  - id: ${TICKET_STEP}`,
    '    model: { backend: claude, model: claude-sonnet-5-5 }',
    '    role: custom',
    '    effect: external',
    '    inputs: [user_prompt]',
    `    tools: [${tool}]`,
    '    system_prompt: |',
    ...[
      'Do exactly what the request asks on the ticket it names, with the tracker tools you have:',
      '- a comment: post it as asked, in plain words, with any links exactly as given;',
      '- an assignee: look the account up first, by the name or email given; if no account',
      '  matches, say so and leave the assignee as it is rather than guess;',
      '- a status: look up the ticket\'s transitions first and use the one that fits; if none',
      '  does, say so and leave it.',
      'Change nothing the request doesn\'t ask for: no other fields, no other tickets, no code.',
      'End with one line per change you made, and one per change you couldn\'t.',
    ].map((l) => `      ${l}`),
    '    output: ticket-update.md',
    '',
  ].join('\n');
}

/// What the worker is asked: the ticket, what the run found, and the links.
export function ticketPrompt(run: FlowRun, ticket: string, landed: Landed[]): string {
  const links = landed.filter((l) => l.url || l.branch).map((l) => `- ${l.repo}: ${l.url ?? `branch ${l.branch}`}`);
  const summary = (run.artifacts?.['pull-request.md']?.body ?? run.artifacts?.['review.md']?.body ?? '').trim().slice(0, 3000);
  return [
    `On ${ticket}: add one comment, two or three sentences on what changed and why, then the`,
    'link (or links) a person follows to review it, exactly as below. Then move the ticket to the',
    'status that means it is in review (often "Code Review" or "In Review").',
    '',
    `The work "${flowRunTitle(run)}" was pushed for review:`,
    ...links,
    ...(summary ? ['', 'What the run wrote about it:', summary] : []),
  ].join('\n');
}
