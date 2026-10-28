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
  return ticketKey(`${flowRunTitle(run)}\n${run.userPrompt ?? ''}`);
}

/// The first ticket key in some text.
export function ticketKey(text: string): string | null {
  return /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/.exec(text)?.[1] ?? null;
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
      '- a status: look up the ticket\'s transitions first, with their fields (Jira: expand',
      '  transitions.fields), and use the one that fits; if none does, say so and leave it.',
      'A transition may require fields (a root cause, when the bug was introduced, a problem type,',
      'a yes/no). Where they go depends on the transition:',
      '- it has a screen (fields come back with it): send them in the transition call itself;',
      '- it has none (no fields come back, or Jira refuses with "requires …"): its rule only',
      '  checks the ticket, so set them with an edit first, then transition. Read the ticket\'s',
      '  edit metadata (Jira: expand editmeta) for each field\'s id, which differs by project, and',
      '  its allowed values; a field missing from it can\'t be set by you, so say so.',
      'Fill each from what the request says, what the run found and your job\'s rules for these',
      'fields; for an option field, use one of its allowed values exactly ("No", not "N"). Never',
      'invent a value nothing here supports: name each field you couldn\'t fill and why, and',
      'leave the status as it is.',
      'Change nothing else: no fields beyond those the request or a transition needs, no other',
      'tickets, no code.',
      'End with one line per change you made, and one per change you couldn\'t.',
    ].map((l) => `      ${l}`),
    '    output: ticket-update.md',
    '',
  ].join('\n');
}

/// What the worker is asked: the ticket, what the run found, and the links.
/// The run's plan and review ride along, not only its pull request, because
/// a transition into review often asks for the root cause and when the bug
/// came in, and that is where the run wrote them down.
export function ticketPrompt(run: FlowRun, ticket: string, landed: Landed[]): string {
  const links = landed.filter((l) => l.url || l.branch).map((l) => `- ${l.repo}: ${l.url ?? `branch ${l.branch}`}`);
  const said = (name: string, max: number) => (run.artifacts?.[name]?.body ?? '').trim().slice(0, max);
  const found = [
    ['The pull request it wrote', said('pull-request.md', 4000)],
    ['Its plan, with what it found', said('plan.md', 3000)],
    ['Its review', said('review.md', 1500)],
  ].filter(([, body]) => body);
  return [
    `On ${ticket}: add one comment, two or three sentences on what changed and why, then the`,
    'link (or links) a person follows to review it, exactly as below. Then move the ticket to the',
    'status that means it is in review (often "Code Review" or "In Review"). If that transition',
    'requires fields such as a root cause (RCA), the date the bug was introduced or a problem type,',
    'fill them in the transition from what the run found below.',
    '',
    `The work "${flowRunTitle(run)}" was pushed for review:`,
    ...links,
    ...found.flatMap(([head, body]) => ['', `${head}:`, body]),
  ].join('\n');
}
