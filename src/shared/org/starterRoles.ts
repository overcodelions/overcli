// Starter roles: three ready-made entries for an org's role catalog, so a new
// org can hire a Developer, a QA or an Analyst without writing the job first.
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
];

export function starterRole(name: string): StarterRole | undefined {
  const key = name.trim().toLowerCase();
  return STARTER_ROLES.find((r) => r.name.toLowerCase() === key);
}

/// The catalog entry a starter role becomes: just the role, none of the card's words.
export function asCatalogRole(r: StarterRole): OrgRole {
  return { name: r.name, job: r.job, tools: [...r.tools], budgetUSDPerMonth: r.budgetUSDPerMonth };
}
