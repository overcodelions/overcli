// Once the server has added a worker's fixes to someone's open pull request,
// the review comments it fixed get a reply under each, and a red build or a
// conflict it fixed gets one comment on the pull request; each says the
// commit, and each ends with OWN_MARK so the PR watcher never counts it. The commit only exists
// after the run has ended, so no step of the run could say "fixed in …"; the
// worker does it in a small run of its own, with its own git host tool, the
// way the ticket gets its comment (ticketFollowUp.ts).

import type { FlowRun } from '../../shared/flows/schema';
import { flowRunTitle } from '../../shared/flows/schema';
import type { Landed } from './landBranches';
import { OWN_MARK } from './prWatch';

/// The step id a trusted coding worker's grant names (REPLIES_STEP_GRANT).
export const REPLIES_STEP = 'pr-replies';

/// Its git host's tool: the first of its tools that looks like one.
export function gitHostOf(mcpServers: readonly string[] | undefined): string | null {
  return (mcpServers ?? []).find((s) => /bitbucket|github|gitlab/i.test(s)) ?? null;
}

export function repliesFlowId(server: string): string {
  return `org-pr-replies-${server.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/// "Pull request replies": one step, the host's tools and nothing else.
export function repliesFlowYaml(server: string): string {
  const tool = `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return [
    'name: Pull request replies',
    'description: |',
    `  Says on a pull request in ${server} what was fixed, and nothing else: no code, no approvals, no merges.`,
    '  Run after its fixes were pushed to that pull request.',
    'input: user_prompt',
    'steps:',
    `  - id: ${REPLIES_STEP}`,
    '    model: { backend: claude, model: claude-sonnet-5-5 }',
    '    role: custom',
    '    effect: external',
    '    inputs: [user_prompt]',
    `    tools: [${tool}]`,
    '    system_prompt: |',
    ...[
      'On the pull request the request names, with the tools you have:',
      '- each review comment the work fixed: reply under that comment, in one or two plain sentences, with the commit;',
      '- a red build or a conflict the work fixed: ONE comment on the pull request, two or three plain sentences:',
      '  what was wrong (the failing test and why, or the files that conflicted), what changed, and the commit.',
      '  If a test was wrong rather than the code, say so and why.',
      `End every comment and reply with a new line reading exactly: ${OWN_MARK}`,
      'Never post the same thing twice: if one of yours already reports this commit, leave it.',
      'Change nothing else: no approvals, no resolving or deleting comments, no merges, no other pull requests.',
      'End with one line per comment or reply you posted, and one per one you could not.',
    ].map((l) => `      ${l}`),
    '    output: pr-replies.md',
    '',
  ].join('\n');
}

/// What the worker is asked: which pull request, what it was asked to fix,
/// and what it says it changed, with the commit each repo got.
export function repliesPrompt(run: FlowRun, landed: Array<Landed & { commit?: string }>): string {
  const said = (name: string, max: number) => (run.artifacts?.[name]?.body ?? '').trim().slice(0, max);
  const pushed = landed.filter((l) => l.updated && l.branch).map((l) => `- ${l.repo}: added to ${l.branch}${l.commit ? ` as commit ${l.commit}` : ''}`);
  return [
    'Fixes were just pushed to an open pull request. Say on it what was fixed, as your step says.',
    '',
    `The work "${flowRunTitle(run)}":`,
    ...pushed,
    '',
    'What it was asked to do (the pull request and its comments are named here):',
    (run.userPrompt ?? '').trim().slice(0, 4000),
    ...(said('pull-request.md', 3000) ? ['', 'What it says it changed:', said('pull-request.md', 3000)] : []),
  ].join('\n');
}
