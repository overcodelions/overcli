// Starter roles: ready-made entries for an org's role catalog, so a new org
// can hire a Developer, a QA, an Analyst, a PR Fixer or a Test Automation
// worker without writing the job first. Each is written for any org: what's
// particular to yours (your apps, your trackers, your house style) goes in
// Setup, the repo's own notes, or a line added at hire.
// They are offered, never imposed: an admin adds one to the catalog (Hire,
// or Setup → Role catalog), and from then on it is the org's own role, to
// edit like any other, under the same approvals and budgets.

import type { OrgRole } from './policy';

export interface StarterRole extends OrgRole {
  /// One line for the card: what it does for you.
  pitch: string;
  /// Where its tools come from, for an org that hasn't set them up yet.
  needs?: string;
}

export const STARTER_ROLES: StarterRole[] = [
  {
    name: 'Developer',
    pitch: 'Takes a ticket, changes the code, runs the tests and opens a pull request.',
    job:
      'Take a ticket or a request, make the change in the repo, run the tests, and open a pull request. ' +
      'Keep the change small and focused on what was asked, and follow the repo’s own conventions and its contributing notes. ' +
      'When CI fails on your pull request, read the failure and fix it. ' +
      'Say plainly in the pull request what you changed and why, and ask before anything that reaches outside the repo.',
    tools: [],
    budgetUSDPerMonth: 150,
    needs: 'A repo connected on Setup → Repos & workspaces.',
  },
  {
    name: 'QA',
    pitch: 'Tests a ticket’s feature environment, signed in, and reports what broke with steps and screenshots.',
    job:
      'Test a ticket’s change in the app it touches, before it ships. ' +
      'Open the app with the test-systems tool on the ticket’s feature environment (pass the ticket key), walk the journeys the ticket affects and the app’s own checklist, and take a screenshot of anything wrong. ' +
      'Report what you checked, what passed, and each problem with the steps to reproduce it. ' +
      'Never change settings or data beyond what the test needs, and never email or message real customers.',
    tools: ['test-systems'],
    budgetUSDPerMonth: 100,
    needs: 'An app on Setup → Apps to test.',
  },
  {
    name: 'Analyst',
    pitch: 'Answers questions from your data, read-only, and shows the query behind every number.',
    job:
      'Answer questions from the company’s data and write up what you find. ' +
      'Query the databases through the overdb tool, read-only, and show the query behind every number. ' +
      'Say how fresh the data is and what it leaves out, and when a question is ambiguous, ask before guessing. ' +
      'Keep reports short: the answer first, then the evidence, then the caveats.',
    tools: ['overdb'],
    budgetUSDPerMonth: 75,
    needs: 'A database on Setup → Databases.',
  },
  {
    name: 'PR Fixer',
    pitch: 'Keeps the team’s open pull requests mergeable: fixes broken builds, resolves conflicts and, for the people you choose, small review comments.',
    job:
      'Keep open pull requests mergeable. The server watches them and hands you the ones that need you: a build that went red, a branch that no longer merges, or new review comments on pull requests by the people you fix comments for. ' +
      'For each one, read the pull request with your git host tool and file one proposal that fixes it on the same branch, ending with a line [continue-branch: <the pull request’s source branch>]. ' +
      'For a failing test, work out whether the test or the code is wrong: fix the test only when the change meant to alter that behaviour, and never weaken, skip or delete a test to make it pass. A build that failed before any test ran is not yours. ' +
      'Conflicts are always yours: the server starts the merge and you resolve the markers. ' +
      'Fix a review comment only when it is clearly right and quick, and leave design questions and judgement calls to people. ' +
      'Never approve, merge or decline a pull request, and never push to a default branch.',
    tools: [],
    budgetUSDPerMonth: 150,
    teamPullRequests: true,
    needs: 'A repo or workspace on Setup → Repos & workspaces, and your git host’s tool on Setup → Tools.',
  },
  {
    name: 'Test Automation',
    pitch: 'Turns shipped tickets into end-to-end tests, in the test repo’s own framework and style.',
    job:
      'Turn tickets that are ready for automation into end-to-end tests. ' +
      'Find the tickets your job names (a status, a label or a linked automation request), and read each one’s acceptance criteria and comments. ' +
      'Write tests for what it changed in the test repo’s own framework and conventions, following its contributing notes. ' +
      'Prefer a few tests that cover the acceptance criteria end to end over many shallow ones, run them, and open one pull request per ticket that says which criteria each test covers. ' +
      'Never weaken an existing test to make a new one pass, and skip a ticket whose criteria are too vague to test, saying what is missing.',
    tools: ['test-systems'],
    budgetUSDPerMonth: 100,
    needs: 'A test repo on Setup → Repos & workspaces, and an app on Setup → Apps to test.',
  },
];

export function starterRole(name: string): StarterRole | undefined {
  const key = name.trim().toLowerCase();
  return STARTER_ROLES.find((r) => r.name.toLowerCase() === key);
}

/// The catalog entry a starter role becomes: just the role, none of the card's words.
export function asCatalogRole(r: StarterRole): OrgRole {
  return { name: r.name, job: r.job, tools: [...r.tools], budgetUSDPerMonth: r.budgetUSDPerMonth, ...(r.teamPullRequests ? { teamPullRequests: true } : {}) };
}
