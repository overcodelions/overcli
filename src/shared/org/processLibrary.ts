// The process library: ways SaaS companies commonly run recurring work
// across teams, written as processes to start from. Each says when to use it
// and what comes out, and each stage says why it's there, which team does it
// (the crew a team needs for it) and who usually decides. Using one matches
// its team stages to the teams you have (suggestTeamFor) and offers to make
// the ones you don't.

import type { ProcessStage, ProcessStageKind } from './process';

export type ProcessCategory = 'Product' | 'Engineering' | 'Customers' | 'Go to market' | 'Security and operations';

export interface LibraryStage {
  key: string;
  name: string;
  kind: ProcessStageKind;
  /// The stage's job: goes in the team's brief, or what deciders look for.
  ask: string;
  /// Why the stage is there: the practice it stands for.
  why: string;
  /// team: the roles a team doing it needs, for matching and for making one.
  crew?: string[];
  /// team: who usually leads it. people: who usually decides.
  who: string;
  /// team: words a fitting team's name, purpose or roles tend to use.
  words?: string[];
  /// Days to wait after the stage before, and how it repeats (process.ts).
  delayDays?: number;
  repeat?: { everyDays: number; times: number };
}

export interface LibraryProcess {
  id: string;
  name: string;
  category: ProcessCategory;
  /// One line: what goes in and what comes out.
  summary: string;
  /// When to use it, and the practice behind it.
  about: string;
  /// What a finished item leaves behind.
  outcome: string;
  /// What starts one: the kinds of things people put in.
  intake: string;
  /// It changes code: pick where the code lives, so each stage builds on the last's branch.
  changesCode?: boolean;
  stages: LibraryStage[];
}

export const PROCESS_LIBRARY: LibraryProcess[] = [
  {
    id: 'idea-to-launch',
    changesCode: true,
    name: 'Idea to launch',
    category: 'Product',
    summary: 'An idea becomes a PR/FAQ, a prototype, a decision, a build, a launch and a check on adoption.',
    about:
      'Working backwards: write the press release and FAQ before building, so the customer and the problem are clear. A prototype tests the idea cheaply, and one explicit decision separates discovery (building the right thing) from delivery (building it right). Adoption is checked after launch, and what it finds feeds the next ideas.',
    outcome: 'A PR/FAQ, a tested prototype, a recorded decision, shipped code with docs, and an adoption read-out.',
    intake: 'Feature ideas, customer requests, gaps sales keeps hearing about.',
    stages: [
      { key: 'prfaq', name: 'PR/FAQ and MLP', kind: 'team', ask: 'Write the press release and FAQ for this idea, and define the minimum lovable product: who it is for, the problem, what is in and what is out.', why: 'Writing the announcement first forces clarity on the customer and the problem before anyone builds.', crew: ['Product manager who writes PR/FAQs', 'Market and competitor analyst', 'Voice-of-customer analyst', 'Challenger who tests the claims'], who: 'Product lead', words: ['product', 'prfaq', 'pr/faq', 'roadmap', 'strategy', 'idea'] },
      { key: 'proto', name: 'Prototype', kind: 'team', ask: 'Build a clickable prototype of the MLP and list what to test with customers.', why: 'A prototype is the cheapest way to learn whether the idea works for people.', crew: ['UX designer', 'Prototype builder', 'Usability reviewer'], who: 'Design lead', words: ['design', 'ux', 'prototype', 'research'] },
      { key: 'validate', name: 'Validate and approve', kind: 'people', ask: 'Read the PR/FAQ and try the prototype. Approve to build it, send it back with what to change, or stop it.', why: 'One recorded decision between discovery and delivery stops half-validated ideas reaching engineering.', who: 'Head of product, with an engineering lead' },
      { key: 'build', name: 'Develop', kind: 'team', ask: 'Build the MLP as specified, with tests, as pull requests.', why: 'Small, reviewed pull requests against a clear spec keep delivery predictable.', crew: ['Spec writer who turns epics into stories', 'Developer', 'Code reviewer'], who: 'Engineering lead', words: ['engineering', 'dev', 'build', 'web', 'app', 'code', 'platform'] },
      { key: 'ship', name: 'Test and deploy', kind: 'team', ask: 'Test the change end to end, fix what breaks and prepare the release.', why: 'A separate test pass catches what the builders are too close to see.', crew: ['QA engineer', 'Release manager'], who: 'QA lead', words: ['qa', 'test', 'release', 'deploy', 'quality'] },
      { key: 'launch', name: 'Launch and docs', kind: 'team', ask: 'Write the announcement, the help docs and the release notes, and brief sales and support.', why: 'A feature nobody hears about or understands might as well not exist.', crew: ['Product marketer', 'Technical writer', 'Enablement writer'], who: 'Product marketing lead', words: ['marketing', 'launch', 'docs', 'content', 'gtm', 'enablement'] },
      { key: 'verify', name: 'Verify bugs and adoption', kind: 'team', delayDays: 14, repeat: { everyDays: 7, times: 4 }, ask: 'After launch, check adoption and bug reports against the PR/FAQ and say what to change next.', why: 'Closing the loop turns a launch into evidence for the next decision. Two weeks in there is adoption to read, and four weekly reads show the trend.', crew: ['Product analyst', 'Support analyst'], who: 'Product manager', words: ['analytics', 'data', 'insight', 'support', 'adoption'] },
    ],
  },
  {
    id: 'bug-to-fix',
    changesCode: true,
    name: 'Bug report to fix',
    category: 'Engineering',
    summary: 'A reported bug is triaged, reproduced, fixed, approved and confirmed with whoever reported it.',
    about:
      'Triage first so severity, not volume, sets the order. A reproduction and a root cause come before the fix, so the fix addresses the cause and gets a test that keeps it fixed. The reporter confirms the fix, which closes the loop with the customer.',
    outcome: 'A triaged ticket, a root-cause note, a fix with a regression test, and a confirmed reply to the reporter.',
    intake: 'Bug reports from support, customers, monitoring or the team.',
    stages: [
      { key: 'triage', name: 'Triage', kind: 'team', ask: 'Read the report, find duplicates and related tickets, set a severity with reasons, and gather what is needed to reproduce it.', why: 'Severity, not who shouted loudest, should decide what gets fixed first.', crew: ['Support triage analyst', 'Ticket historian'], who: 'Support lead', words: ['support', 'triage', 'tickets', 'help'] },
      { key: 'fix', name: 'Reproduce and fix', kind: 'team', ask: 'Reproduce the bug, find the root cause, fix it with a regression test, and open a pull request.', why: 'A fix with a test for the cause stays fixed.', crew: ['Developer', 'Code reviewer'], who: 'Engineering lead', words: ['engineering', 'dev', 'bug', 'fix', 'code', 'app'] },
      { key: 'approve', name: 'Approve the fix', kind: 'people', ask: 'Check the root cause and the fix make sense and the risk is acceptable for the next release.', why: 'A named owner signs off on what changes in production.', who: 'Code owner or engineering lead' },
      { key: 'confirm', name: 'Confirm with the reporter', kind: 'team', ask: 'Once released, write to the reporter with what was wrong and that it is fixed, and close the ticket.', why: 'Telling the customer is part of the fix: it is what they see.', crew: ['Support writer'], who: 'Support lead', words: ['support', 'customer', 'success'] },
    ],
  },
  {
    id: 'customer-escalation',
    name: 'Customer escalation',
    category: 'Customers',
    summary: 'An escalated account gets the facts gathered, the problem investigated, a response decided, the customer told and a review.',
    about:
      'Escalations go wrong when people act before they know the account’s history. Gather the facts first, decide the response with the account owner, and have one voice tell the customer. A short review afterwards turns one painful account into fewer next time.',
    outcome: 'A fact pack, an investigation, a decided response, a sent message and follow-up actions.',
    intake: 'Escalations from account managers, support or executives.',
    stages: [
      { key: 'facts', name: 'Gather the facts', kind: 'team', ask: 'Pull together the account’s history: plan, usage, open and recent tickets, past escalations, notes and what was promised.', why: 'Everyone acting on the same facts prevents contradictory answers.', crew: ['Account researcher', 'Ticket historian', 'Usage analyst'], who: 'Account owner', words: ['account', 'customer', 'success', 'support', 'crm'] },
      { key: 'investigate', name: 'Investigate', kind: 'team', ask: 'Find what is actually wrong for this customer and what it would take to fix or work around it.', why: 'The response depends on the real cause, not the first explanation.', crew: ['Developer', 'Support engineer'], who: 'Engineering lead', words: ['engineering', 'support', 'dev', 'platform'] },
      { key: 'decide', name: 'Decide the response', kind: 'people', ask: 'Choose what we will do and offer: a fix, a workaround, a credit, a call. Send back if the facts are thin.', why: 'The account owner owns the relationship, so they decide what is offered.', who: 'Account owner, with the support lead' },
      { key: 'tell', name: 'Tell the customer', kind: 'team', ask: 'Draft the message to the customer in the agreed tone, with what happened, what we are doing and when.', why: 'One clear message beats several partial ones.', crew: ['Customer communications writer'], who: 'Account owner', words: ['success', 'support', 'communications', 'customer'] },
      { key: 'review', name: 'Review and prevent', kind: 'team', ask: 'Write a short review: what led here, what we changed, and what would have caught it sooner.', why: 'A review turns one bad week into fewer escalations.', crew: ['Retrospective writer'], who: 'Head of customer success', words: ['success', 'operations', 'quality'] },
    ],
  },
  {
    id: 'security-vulnerability',
    changesCode: true,
    name: 'Security vulnerability response',
    category: 'Security and operations',
    summary: 'A reported vulnerability is assessed, a plan approved, patched, verified, disclosed and reviewed.',
    about:
      'Coordinated disclosure: assess the severity and who is affected, agree a plan and a disclosure date with the security owner, patch and verify before anything is published. Keep the circle small until the fix ships.',
    outcome: 'A severity assessment, an approved plan, a verified patch, an advisory and a retrospective.',
    intake: 'Reports from researchers, scanners, customers or staff.',
    stages: [
      { key: 'assess', name: 'Assess severity', kind: 'team', ask: 'Confirm the issue, score its severity with reasons, find affected versions and customers, and propose a fix and a disclosure timeline.', why: 'Severity and blast radius set the urgency and who needs to know.', crew: ['Security analyst', 'Developer who knows the affected area'], who: 'Security lead', words: ['security', 'appsec', 'platform', 'infrastructure'] },
      { key: 'plan', name: 'Approve the plan', kind: 'people', ask: 'Approve the fix, the timeline and who is told when. Send back if the assessment is incomplete.', why: 'Disclosure and timing are a business decision with legal weight.', who: 'Security lead, with an engineering lead' },
      { key: 'patch', name: 'Patch', kind: 'team', ask: 'Fix the vulnerability with a test that proves it, as a pull request, without describing the issue in public commit messages.', why: 'The patch ships before the details do.', crew: ['Developer', 'Security reviewer'], who: 'Engineering lead', words: ['engineering', 'dev', 'platform', 'security'] },
      { key: 'verify', name: 'Verify and release', kind: 'team', ask: 'Verify the fix closes the issue and breaks nothing, and prepare the release.', why: 'An unverified patch can leave the hole open while everyone thinks it is closed.', crew: ['QA engineer', 'Release manager'], who: 'QA lead', words: ['qa', 'test', 'release'] },
      { key: 'advise', name: 'Advisory', kind: 'team', ask: 'Write the security advisory and the customer notice: what, who is affected, what to do.', why: 'Clear disclosure keeps trust.', crew: ['Technical writer', 'Security analyst'], who: 'Security lead', words: ['docs', 'communications', 'security'] },
    ],
  },
  {
    id: 'incident-postmortem',
    name: 'Incident postmortem',
    category: 'Security and operations',
    summary: 'After an incident: a timeline, the causes, the actions, a review, and the actions tracked to done.',
    about:
      'Blameless postmortems: build the timeline from logs and chat, separate the trigger from the contributing causes, and agree a few actions with owners. The review is where people agree it is right; tracking the actions is where it pays off.',
    outcome: 'A timeline, a cause analysis, reviewed actions with owners, and a published postmortem.',
    intake: 'Incidents once they are resolved.',
    stages: [
      { key: 'timeline', name: 'Build the timeline', kind: 'team', ask: 'Build the incident timeline from alerts, logs, deploys and chat: what happened, when, and who did what.', why: 'An accurate timeline stops the review arguing about facts.', crew: ['Site reliability analyst', 'Log investigator'], who: 'Incident commander', words: ['sre', 'operations', 'platform', 'infrastructure', 'devops'] },
      { key: 'causes', name: 'Causes and actions', kind: 'team', ask: 'Separate the trigger from the contributing causes and propose a short list of actions, each with a suggested owner.', why: 'Fixing only the trigger leaves the conditions for the next incident.', crew: ['Site reliability analyst', 'Developer', 'Challenger'], who: 'Engineering lead', words: ['sre', 'engineering', 'platform'] },
      { key: 'review', name: 'Review', kind: 'people', ask: 'Agree the analysis is right and the actions are the right ones, with owners. Send back what is missing.', why: 'The people closest to the system confirm it before it is published.', who: 'Engineering manager and on-call lead' },
      { key: 'publish', name: 'Publish and track', kind: 'team', ask: 'Publish the postmortem and open a ticket for each action with its owner and date.', why: 'Actions without tickets do not happen.', crew: ['Technical writer', 'Project coordinator'], who: 'Engineering manager', words: ['docs', 'operations', 'program'] },
    ],
  },
  {
    id: 'launch-readiness',
    name: 'Launch readiness',
    category: 'Go to market',
    summary: 'A release gets a launch brief, reviewed messaging, content, enablement, a go/no-go and a measured launch.',
    about:
      'Positioning before content: agree who it is for and why it matters, then write everything from that. A go/no-go just before launch checks the product, the content and the teams are ready, so the date is a decision, not an accident.',
    outcome: 'A launch brief, approved messaging, web and help content, enablement for sales and support, and launch metrics.',
    intake: 'Releases big enough to announce.',
    stages: [
      { key: 'brief', name: 'Launch brief', kind: 'team', ask: 'Write the launch brief: audience, problem, positioning, proof points, competitors’ answer, and how success is measured.', why: 'Everything later is written from one agreed position.', crew: ['Product marketer', 'Market analyst'], who: 'Product marketing lead', words: ['marketing', 'gtm', 'positioning', 'launch'] },
      { key: 'messaging', name: 'Messaging review', kind: 'people', ask: 'Approve the positioning and messaging, or send back what is off.', why: 'Product and marketing agreeing early prevents rewriting everything late.', who: 'Product marketing lead and product lead' },
      { key: 'content', name: 'Content', kind: 'team', ask: 'Write the web copy, the announcement, the help docs and the release notes from the brief.', why: 'Customers meet the launch through this content.', crew: ['Copywriter', 'Technical writer', 'SEO reviewer'], who: 'Content lead', words: ['content', 'marketing', 'docs', 'web'] },
      { key: 'enable', name: 'Enable sales and support', kind: 'team', ask: 'Write the sales talk track, objection handling and the support FAQ.', why: 'The first customer questions go to sales and support, not marketing.', crew: ['Enablement writer', 'Support writer'], who: 'Sales enablement lead', words: ['sales', 'enablement', 'support'] },
      { key: 'go', name: 'Go / no-go', kind: 'people', ask: 'Check the product, the content and the teams are ready. Go, send back what is not, or move the date.', why: 'Launch dates should be decided, not drifted into.', who: 'Launch owner, with product and engineering leads' },
      { key: 'measure', name: 'Launch and measure', kind: 'team', delayDays: 7, repeat: { everyDays: 7, times: 3 }, ask: 'After launch, report against the success measures in the brief.', why: 'Measuring against the brief shows whether the positioning worked.', crew: ['Marketing analyst'], who: 'Product marketing lead', words: ['analytics', 'marketing', 'data'] },
    ],
  },
  {
    id: 'quarterly-planning',
    name: 'Quarterly roadmap planning',
    category: 'Product',
    summary: 'Customer evidence, metrics and the market become a challenged draft roadmap, a decision and a published plan.',
    about:
      'Evidence first: gather what customers asked for, what the numbers say and what the market is doing before proposing anything. A challenger tests the draft before leadership sees it, and the published plan says what was not chosen and why.',
    outcome: 'An evidence pack, a challenged roadmap draft, an approved plan and a communication to the company.',
    intake: 'Each planning cycle, or a big change in direction.',
    stages: [
      { key: 'evidence', name: 'Gather evidence', kind: 'team', ask: 'Gather customer requests and themes, usage and revenue metrics, and competitor moves for the period.', why: 'Plans built on evidence survive the first hard question.', crew: ['Voice-of-customer analyst', 'Product analyst', 'Market analyst'], who: 'Product operations', words: ['product', 'analytics', 'customer', 'market', 'insight'] },
      { key: 'draft', name: 'Draft and challenge', kind: 'team', ask: 'Propose a ranked roadmap with the reasoning, have it challenged, and write what was left out and why.', why: 'A challenged draft is stronger than one person’s favourite list.', crew: ['Product strategist', 'Challenger', 'Roadmap writer'], who: 'Head of product', words: ['product', 'roadmap', 'strategy', 'council'] },
      { key: 'decide', name: 'Leadership decision', kind: 'people', ask: 'Approve the roadmap, or send it back with what should change.', why: 'One recorded decision makes trade-offs explicit.', who: 'Leadership team' },
      { key: 'publish', name: 'Publish and explain', kind: 'team', ask: 'Write the roadmap announcement for the company and the customer-facing version.', why: 'A plan only aligns people who have read it.', crew: ['Product writer', 'Internal communications'], who: 'Head of product', words: ['product', 'communications', 'docs'] },
    ],
  },
  {
    id: 'experiment',
    name: 'Growth experiment',
    category: 'Go to market',
    summary: 'A hypothesis becomes a designed, approved, built and measured experiment with a ship-or-kill decision.',
    about:
      'Write the hypothesis and the metric before building, size the sample so the result means something, and decide ship or kill against what you wrote down, not what you hoped.',
    outcome: 'A hypothesis, an experiment design, a build, a results analysis and a recorded decision.',
    intake: 'Growth ideas: onboarding, pricing pages, activation, retention.',
    stages: [
      { key: 'design', name: 'Hypothesis and design', kind: 'team', ask: 'Write the hypothesis, the primary metric, the guardrail metrics, the variants and the sample size needed.', why: 'Deciding the metric first prevents finding a winner after the fact.', crew: ['Growth analyst', 'Product designer'], who: 'Growth lead', words: ['growth', 'analytics', 'experiment', 'marketing', 'data'] },
      { key: 'approve', name: 'Approve the experiment', kind: 'people', ask: 'Approve running it, or send back the design.', why: 'Experiments touch real customers and revenue.', who: 'Growth lead and product manager' },
      { key: 'build', name: 'Build the variants', kind: 'team', ask: 'Build the variants behind a flag with the tracking needed.', why: 'Clean flags and tracking make the result trustworthy and the rollback easy.', crew: ['Developer', 'Analytics engineer'], who: 'Engineering lead', words: ['engineering', 'dev', 'web', 'growth'] },
      { key: 'analyze', name: 'Run and analyze', kind: 'team', delayDays: 14, ask: 'Once the sample is reached, analyze the result against the hypothesis and the guardrails.', why: 'Reading results only at the planned sample avoids false wins.', crew: ['Growth analyst', 'Challenger'], who: 'Growth lead', words: ['analytics', 'data', 'growth'] },
      { key: 'decide', name: 'Ship or kill', kind: 'people', ask: 'Decide: ship the winner, kill it, or run a follow-up.', why: 'Each experiment ends in a decision, not a dashboard.', who: 'Growth lead' },
    ],
  },
  {
    id: 'content-pipeline',
    name: 'Content pipeline',
    category: 'Go to market',
    summary: 'A content brief is drafted, checked by an expert, edited, approved and published.',
    about:
      'A brief sets the audience and the one thing the reader should take away. An expert checks the facts before an editor polishes the words, so polish is never wasted on something wrong.',
    outcome: 'A brief, an expert-checked draft, an edited piece, approval and a published, distributed post.',
    intake: 'Blog posts, guides, case studies, whitepapers.',
    stages: [
      { key: 'brief', name: 'Brief', kind: 'team', ask: 'Write the brief: audience, the takeaway, keywords, sources and outline.', why: 'A brief stops drafts wandering.', crew: ['Content strategist', 'SEO analyst'], who: 'Content lead', words: ['content', 'marketing', 'seo'] },
      { key: 'draft', name: 'Draft', kind: 'team', ask: 'Write the draft from the brief.', why: 'Drafting against an agreed outline is faster.', crew: ['Writer'], who: 'Content lead', words: ['content', 'writing', 'marketing'] },
      { key: 'expert', name: 'Expert review', kind: 'people', ask: 'Check the facts and claims. Approve, or send back what is wrong.', why: 'An expert catches what an editor can’t.', who: 'Subject-matter expert' },
      { key: 'edit', name: 'Edit and optimize', kind: 'team', ask: 'Edit for clarity and tone, and optimize the title, headings and links for search.', why: 'Editing last means polishing only what is right.', crew: ['Editor', 'SEO analyst'], who: 'Content lead', words: ['content', 'editor', 'seo', 'marketing'] },
      { key: 'approve', name: 'Approve and publish', kind: 'people', ask: 'Approve it for publishing.', why: 'Someone owns what goes out under the company’s name.', who: 'Marketing lead' },
    ],
  },
  {
    id: 'customer-onboarding',
    name: 'Customer onboarding',
    category: 'Customers',
    summary: 'A new customer gets a handoff pack, a setup plan they sign off, configuration, training and a 30-day check.',
    about:
      'Time to value is the onboarding metric. Start from what sales promised, agree a plan with the customer, and check at 30 days that they are actually using what they bought.',
    outcome: 'A handoff pack, an agreed plan, a configured account, training material and a 30-day health check.',
    intake: 'Newly signed customers.',
    stages: [
      { key: 'handoff', name: 'Handoff pack', kind: 'team', ask: 'Gather what was sold and promised, the customer’s goals, contacts and systems, from the deal notes and calls.', why: 'Onboarding goes wrong when sales promises are lost in the handoff.', crew: ['Account researcher', 'Deal-notes summarizer'], who: 'Customer success manager', words: ['success', 'sales', 'account', 'customer', 'crm'] },
      { key: 'plan', name: 'Setup plan', kind: 'team', ask: 'Draft the onboarding plan: milestones, owners on both sides and dates.', why: 'A shared plan makes both sides accountable.', crew: ['Onboarding planner'], who: 'Customer success manager', words: ['success', 'onboarding', 'implementation'] },
      { key: 'signoff', name: 'Customer sign-off', kind: 'people', ask: 'Confirm the customer agreed the plan.', why: 'Agreement up front prevents scope arguments later.', who: 'Customer success manager' },
      { key: 'configure', name: 'Configure and train', kind: 'team', ask: 'Prepare the configuration and imports, and write training material for the customer’s users.', why: 'Users who are trained adopt; users who are not, churn.', crew: ['Implementation specialist', 'Training writer'], who: 'Implementation lead', words: ['implementation', 'onboarding', 'support', 'success'] },
      { key: 'health', name: '30-day health check', kind: 'team', delayDays: 30, ask: 'At 30 days, report usage against the plan’s goals and recommend next steps.', why: 'Usage at 30 days predicts renewal.', crew: ['Usage analyst'], who: 'Customer success manager', words: ['success', 'analytics', 'customer'] },
    ],
  },
  {
    id: 'pricing-change',
    name: 'Pricing change',
    category: 'Go to market',
    summary: 'Research and modelled options lead to a leadership decision, a migration plan, enablement and monitoring.',
    about:
      'Pricing changes touch every customer, so they need evidence, modelled revenue impact, an explicit decision and a careful plan for existing customers. Monitoring afterwards checks the model against reality.',
    outcome: 'Research, modelled options, a decision, a customer migration and communication plan, enablement and a post-change report.',
    intake: 'Proposals to change prices, plans or packaging.',
    stages: [
      { key: 'research', name: 'Research', kind: 'team', ask: 'Gather competitor pricing, win/loss reasons, usage by plan and what customers say about price.', why: 'Evidence beats opinion in pricing arguments.', crew: ['Market analyst', 'Revenue analyst', 'Voice-of-customer analyst'], who: 'Pricing owner', words: ['pricing', 'revenue', 'market', 'finance', 'sales'] },
      { key: 'model', name: 'Options and model', kind: 'team', ask: 'Propose two or three options and model their revenue and churn impact, with the assumptions stated.', why: 'Comparing options shows the trade-offs.', crew: ['Revenue analyst', 'Challenger'], who: 'Finance lead', words: ['finance', 'revenue', 'pricing', 'analytics'] },
      { key: 'decide', name: 'Leadership decision', kind: 'people', ask: 'Pick an option, or send it back.', why: 'Price is a leadership call.', who: 'Leadership team' },
      { key: 'plan', name: 'Migration and comms plan', kind: 'team', ask: 'Plan how existing customers move, what they are told and when, and the exceptions policy.', why: 'Existing customers judge the change by how it is handled.', crew: ['Customer communications writer', 'Billing operations'], who: 'Customer success lead', words: ['success', 'billing', 'communications', 'customer'] },
      { key: 'enable', name: 'Enable and monitor', kind: 'team', ask: 'Write sales and support guidance, then report conversion, churn and expansion against the model after the change.', why: 'Monitoring checks the model against reality.', crew: ['Enablement writer', 'Revenue analyst'], who: 'Pricing owner', words: ['sales', 'enablement', 'analytics', 'revenue'] },
    ],
  },
];

export function libraryProcess(id: string): LibraryProcess | undefined {
  return PROCESS_LIBRARY.find((p) => p.id === id);
}

/// A team the stage could use. The stage's own subject words (`words`)
/// count double and one of them must hit; its crew's role words count once.
/// Null below a clear match, so a weak guess never fills a stage in.
export function suggestTeamFor<T extends { id: string; name: string; purpose?: string; members?: Array<{ role?: string }> }>(stage: LibraryStage, teams: readonly T[]): { team: T; score: number } | null {
  if (stage.kind !== 'team') return null;
  const subject = (stage.words ?? []).map((w) => w.toLowerCase());
  const roles = [...new Set((stage.crew ?? []).flatMap((c) => c.toLowerCase().split(/[^a-z/]+/)).filter((w) => w.length > 3 && !ROLE_NOISE.has(w)))];
  let best: { team: T; score: number } | null = null;
  for (const t of teams) {
    const hay = ` ${[t.name, t.purpose ?? '', ...(t.members ?? []).map((m) => m.role ?? '')].join(' ').toLowerCase()} `;
    const hit = (w: string) => new RegExp(`[^a-z]${w.replace(/[/]/g, '\\/')}`).test(hay);
    const subjectHits = subject.filter(hit).length;
    if (!subjectHits) continue;
    const score = subjectHits * 2 + roles.filter(hit).length;
    if (score > (best?.score ?? 0)) best = { team: t, score };
  }
  return best && best.score >= 3 ? best : null;
}

/// Words in role names that say nothing about what a team does.
const ROLE_NOISE = new Set(['writer', 'analyst', 'reviewer', 'manager', 'lead', 'specialist', 'engineer', 'builder', 'who', 'the', 'and', 'into']);

/// The library process as editable stages, with the teams it could use
/// filled in. `pickTeam` returns a team id or nothing.
export function stagesFromLibrary(p: LibraryProcess, pickTeam: (stage: LibraryStage) => string | undefined): ProcessStage[] {
  return p.stages.map((s) => {
    const teamId = s.kind === 'team' ? pickTeam(s) : undefined;
    return {
      id: s.key,
      name: s.name,
      kind: s.kind,
      ask: s.ask,
      why: s.why,
      ...(teamId ? { teamId } : {}),
      ...(s.kind === 'people' ? { approvers: [] } : {}),
      ...(s.delayDays ? { delayDays: s.delayDays } : {}),
      ...(s.repeat ? { repeat: s.repeat } : {}),
    };
  });
}
