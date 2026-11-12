// Builds a fictional overgo state directory for the console screenshots:
// Acme's org.json, five workers, a month of their finished runs with what
// they cost, the questions people asked them, and one run waiting for an OK.
//
// Written through the server's own stores (the compiled dist/), so the
// files are the shape `overcli serve` reads. Nothing here starts a run: no
// worker has a schedule, and the only unfinished run waits on a person.
//
// Usage: node seed-overgo.mjs <stateDir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const [STATE] = process.argv.slice(2);
if (!STATE) throw new Error('usage: node seed-overgo.mjs <stateDir>');
const here = path.dirname(new URL(import.meta.url).pathname);
const dist = path.resolve(here, '..', '..', 'dist', 'main');
const require = createRequire(import.meta.url);

fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
const { setHost } = require(path.join(dist, 'host.js'));
const { nodeHost } = require(path.join(dist, 'hostNode.js'));
setHost(nodeHost({ dataDir: STATE }));
const { saveWorker } = require(path.join(dist, 'flows', 'workersStore.js'));
const { saveRun } = require(path.join(dist, 'flows', 'runsStore.js'));
const { saveOrchestration } = require(path.join(dist, 'flows', 'orchestrationsStore.js'));

// Repeatable: the same people asked the same things on every regeneration.
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const uid = () => crypto.randomUUID();
const now = Date.now();
const H = 3_600_000;
const D = 24 * H;

// ---- People ---------------------------------------------------------------

const people = {
  dana: { name: 'Dana Reyes', slackUserId: 'U0ACMEDR1' },
  sam: { name: 'Sam Okafor', slackUserId: 'U0ACMESO2' },
  priya: { name: 'Priya Shah', slackUserId: 'U0ACMEPS3' },
  lee: { name: 'Lee Park', slackUserId: 'U0ACMELP4' },
  mei: { name: 'Mei Kato', slackUserId: 'U0ACMEMK5' },
  jordan: { name: 'Jordan Tate', slackUserId: 'U0ACMEJT6' },
};

fs.writeFileSync(
  path.join(STATE, 'org.json'),
  JSON.stringify(
    {
      name: 'Acme',
      slackTeamId: 'T0ACME001',
      timezone: 'America/New_York',
      publicUrl: 'https://overgo.acme.internal',
      admins: [people.dana.slackUserId],
      hirers: '*',
      budgetAllowanceUSD: 200,
      orgBudgetUSD: 1500,
      alertAtPercent: 80,
      tuningWatch: false,
      teams: { platform: [people.priya.slackUserId, people.jordan.slackUserId], support: [people.dana.slackUserId, people.mei.slackUserId] },
      roles: [
        { name: 'Developer', job: 'Picks up tickets in a repo, makes the change with tests, and opens a pull request.', tools: [], budgetUSDPerMonth: 300 },
        { name: 'QA', job: 'Tests a ticket on its feature environment and reports what passed and what broke, with screenshots.', tools: [], budgetUSDPerMonth: 120 },
        { name: 'Analyst', job: 'Answers questions from the data and the docs, and says where each number came from.', tools: [], budgetUSDPerMonth: 150 },
      ],
    },
    null,
    2,
  ),
);

// ---- Workers --------------------------------------------------------------

const workersDir = path.join(STATE, 'projects', 'Workers');
const repoDir = path.join(STATE, 'repos', 'acme-api');
fs.mkdirSync(workersDir, { recursive: true });
fs.mkdirSync(repoDir, { recursive: true });

function worker(key, over) {
  const w = {
    id: uid(),
    jobDescription: '',
    projectPath: workersDir,
    cadence: null,
    trust: 'trusted',
    caps: { maxItemsPerShift: 3, runIn: 'worktree', allowExternalActions: false, tuningWatchOff: true },
    budgetUSDPerMonth: 100,
    heartbeatModel: 'claude-sonnet-5-5',
    flowIds: ['research-topic'],
    enabled: true,
    createdAt: now - 70 * D,
    visibility: 'org',
    ...over,
  };
  saveWorker(w);
  return w;
}

const W = {
  iris: worker('iris', {
    name: 'Iris',
    tagline: 'Answers support questions about orders and accounts',
    jobDescription: 'Sits in #support-help and answers questions about orders, refunds and accounts from the order system and the help center, citing where each answer came from. Hands anything it can’t answer to the on-call lead.',
    role: 'Analyst',
    manager: people.dana,
    budgetUSDPerMonth: 150,
    slackHomeChannels: ['C0ACMESUP'],
  }),
  atlas: worker('atlas', {
    name: 'Atlas',
    tagline: 'Fixes acme-api tickets and opens the pull request',
    jobDescription: 'Picks up tickets labelled good-for-atlas in the ACME project, makes the change in acme-api with tests, and opens a pull request for the platform team to review.',
    role: 'Developer',
    manager: people.priya,
    projectPath: repoDir,
    budgetUSDPerMonth: 300,
    writesCode: true,
    flowIds: ['solve-ticket'],
    caps: { maxItemsPerShift: 3, runIn: 'worktree', allowExternalActions: true, tuningWatchOff: true },
  }),
  vera: worker('vera', {
    name: 'Vera',
    tagline: 'Tests each storefront ticket on its feature environment',
    jobDescription: 'When a storefront ticket moves to In QA, opens its feature environment, walks the acceptance criteria, and reports what passed and what broke, with screenshots.',
    role: 'QA',
    manager: people.priya,
    budgetUSDPerMonth: 120,
  }),
  quill: worker('quill', {
    name: 'Quill',
    tagline: 'Writes the weekly changelog from merged pull requests',
    jobDescription: 'Every Friday, reads the pull requests merged across Acme’s repos that week and writes the customer-facing changelog in the house style, flagging anything that needs a docs update.',
    manager: people.sam,
    budgetUSDPerMonth: 60,
    flowIds: ['content-review'],
  }),
  scout: worker('scout', {
    name: 'Scout',
    tagline: 'Tracks competitors’ pricing and launches',
    jobDescription: 'Watches the public pricing pages, changelogs and announcements of five named competitors and reports what changed each week, with links.',
    manager: people.lee,
    budgetUSDPerMonth: 80,
    visibility: 'team',
  }),
};

// ---- Runs -----------------------------------------------------------------

const flowFor = (w) => ({
  id: w.flowIds[0],
  name: { 'research-topic': 'Research a topic', 'solve-ticket': 'Solve a ticket end-to-end', 'content-review': 'Draft and review' }[w.flowIds[0]],
  input: 'user_prompt',
  participants: [
    { id: 'primary', name: 'Claude Sonnet 5.5', backend: 'claude', model: 'claude-sonnet-5-5', kind: 'primary' },
    { id: 'reviewer', name: 'Claude Opus 5.5', backend: 'claude', model: 'claude-opus-5-5', kind: 'reviewer' },
  ],
  steps: [
    { id: 'work', participantId: 'primary', role: 'implementer', inputs: ['user_prompt'], tools: [], output: 'answer.md' },
    { id: 'review', participantId: 'reviewer', role: 'reviewer', inputs: ['answer.md'], tools: [], output: 'review.md' },
    ...(w.writesCode
      ? [{ id: 'open-pr', participantId: 'primary', role: 'shipper', inputs: ['answer.md', 'review.md'], tools: ['Bash'], effect: 'external', output: 'pull-requests.md' }]
      : []),
  ],
  source: 'generated',
  filePath: '',
});

const numbers = new Map();
const asks = [];

/// One finished (or waiting) run, the batch it ran in, and the ask behind it.
function run(w, { at, title, prompt, answer, cost, minutes, by, via, failed, waiting }) {
  const runId = uid();
  const batchId = uid();
  const n = (numbers.get(w.id) ?? 0) + 1;
  numbers.set(w.id, n);
  const flow = flowFor(w);
  const end = at + minutes * 60_000;
  const conv = uid();
  const attempts = waiting
    ? [{ stepId: 'work', startedAt: at, endedAt: at + minutes * 0.6 * 60_000, conversationId: conv, outcome: 'success', costUSD: cost * 0.7, usage: { inputTokens: 40_000, outputTokens: 3_000 } }]
    : [
        { stepId: 'work', startedAt: at, endedAt: at + minutes * 0.7 * 60_000, conversationId: conv, outcome: failed ? 'error' : 'success', costUSD: cost * 0.7, usage: { inputTokens: 60_000, outputTokens: 4_000 }, ...(failed ? { errorMessage: failed } : {}) },
        ...(failed ? [] : [{ stepId: 'review', startedAt: at + minutes * 0.7 * 60_000, endedAt: end, conversationId: uid(), outcome: 'success', costUSD: cost, usage: { inputTokens: 20_000, outputTokens: 1_500 } }]),
      ];
  const r = {
    id: runId,
    flowId: flow.id,
    flowSnapshot: flow,
    projectPath: w.projectPath,
    userPrompt: prompt,
    conversationIds: { primary: conv },
    artifacts: failed
      ? {}
      : { 'answer.md': { name: 'answer.md', kind: 'markdown', body: answer, producedByStepId: 'work', producedAt: end } },
    digest: { headline: title },
    state: waiting ? { kind: 'paused', nextStepId: 'open-pr', reason: 'externalAction' } : failed ? { kind: 'done', success: false } : { kind: 'done', success: true },
    createdAt: at,
    costUSD: cost,
    attempts,
    workerId: w.id,
    workerName: w.name,
    number: n,
    title,
    parentOrchestrationId: batchId,
    unattended: true,
  };
  saveRun(r);
  saveOrchestration({
    id: batchId,
    title,
    projectPath: w.projectPath,
    maxConcurrent: 1,
    items: [{ candidate: { id: uid(), title, prompt }, flowId: flow.id, status: waiting ? 'running' : failed ? 'failed' : 'done', runId, startedAt: at, ...(waiting ? {} : { finishedAt: end }) }],
    origin: { kind: 'worker', workerId: w.id, workerName: w.name, task: 'errand', errand: prompt },
    createdAt: at,
    ...(waiting ? {} : { completedAt: end }),
  });
  // An unfinished ask would be asked again when the server starts, so the
  // waiting run has none: it was started from the console's Run now.
  if (by && !waiting) {
    asks.push({
      id: uid(),
      workerId: w.id,
      workerName: w.name,
      by: by.name,
      slackUserId: by.slackUserId,
      text: prompt,
      at,
      status: failed ? 'failed' : 'answered',
      via,
      launched: 1,
      orchestrationId: batchId,
      ...(failed ? {} : { reply: answer, doneAt: end }),
      ...(failed ? { error: failed, doneAt: end } : {}),
    });
  }
  return r;
}

const work = {
  iris: [
    ['Refund for order 48213 went to the old card', 'Order 48213 was refunded to the card on file at purchase, ending 4417; the customer replaced it on Oct 30. Refunds always go back to the original card, so the bank will forward it. Source: order system, refund R-9912.'],
    ['Why customers in Ontario see tax twice', 'Ontario orders show HST on the item line and again in the summary because the storefront’s summary adds tax-inclusive prices. One charge is taken; the display is wrong. Ticket ACME-1182 tracks the fix.'],
    ['How many orders shipped late last week', '214 of 3,980 orders (5.4%) shipped after their promised date last week, 160 of them from the Reno warehouse on Tuesday’s carrier delay. Source: acme-warehouse, shipments table.'],
    ['Can a gift card be split across two orders', 'Yes. A gift card balance carries over, so a $100 card used on a $60 order leaves $40 for the next. Help center: “Using gift cards”.'],
    ['Accounts locked after the password reset email', 'The 37 locked accounts all used the reset link more than an hour after it was sent, when it had expired. Unlocking them is safe; a clearer expiry message is in ACME-1190.'],
    ['Which plan includes priority support', 'Priority support is in Business and Enterprise. Team plans can add it for $40 a month. Source: pricing page and the plans table.'],
  ],
  atlas: [
    ['Rate limits on /v2/orders, pull request opened', 'Added a per-key token bucket to /v2/orders (60 requests a minute, bursts of 20) with a 429 and Retry-After. Tests cover the limit and the reset.\n\nhttps://bitbucket.org/acme/acme-api/pull-requests/412'],
    ['Promo validation endpoint, pull request opened', 'POST /v2/promos/validate checks a code, its dates and its usage limit, and returns the discount. Unknown codes are a 404.\n\nhttps://bitbucket.org/acme/acme-api/pull-requests/418'],
    ['Fixed the invoice retry job running twice', 'The retry job is now claimed with a row lock, so two workers can no longer pick up the same invoice. A test runs two at once.\n\nhttps://bitbucket.org/acme/acme-api/pull-requests/421'],
    ['Pagination on /v2/customers, pull request opened', 'Cursor pagination on /v2/customers with a limit of 100, and a next link in the response.\n\nhttps://bitbucket.org/acme/acme-api/pull-requests/425'],
  ],
  vera: [
    ['ACME-1174 passed QA on its feature environment', 'All 6 acceptance criteria pass on acme-1174.preview.acme.dev. Checked promo codes at checkout on desktop and mobile; an expired code shows the right message.'],
    ['ACME-1180 failed QA: discount line missing on mobile', '5 of 6 criteria pass. On a 390px screen the discount line in the order summary is cut off. Screenshot attached; moved back to In Progress.'],
    ['ACME-1185 passed QA', 'The address form keeps what was typed after a failed card. Checked with three test cards and both shipping options.'],
  ],
  quill: [
    ['Changelog for the week of Oct 27', '**New:** promo codes at checkout. **Better:** order history loads twice as fast. **Fixed:** refunds now show on the receipt. Two items need a docs update: promo codes and the new rate limits.'],
    ['Changelog for the week of Nov 3', '**New:** cursor pagination on the customers API. **Fixed:** invoice retries could run twice. One docs update: pagination.'],
  ],
  scout: [
    ['Competitor pricing: two plans went up this week', 'Northwind raised its Team plan from $12 to $15 a seat; Contoso added a $9 starter plan with a 3-seat cap. Links to both pages and last week’s copies.'],
    ['Competitor launches, week of Nov 3', 'Fabrikam launched a public API with OAuth; Northwind announced EU hosting for Q1. Neither changes pricing yet.'],
  ],
};

const askers = {
  iris: [[people.mei, 'slack'], [people.jordan, 'slack'], [people.dana, 'console'], [people.sam, 'slack']],
  atlas: [[people.priya, 'console'], [people.jordan, 'mcp'], [people.priya, 'slack']],
  vera: [[people.priya, 'slack'], [people.jordan, 'console']],
  quill: [[people.sam, 'console']],
  scout: [[people.lee, 'mcp'], [people.lee, 'console']],
};
const costs = { iris: [0.12, 0.6], atlas: [1.8, 6.5], vera: [0.6, 2.2], quill: [0.8, 1.6], scout: [0.5, 1.4] };
const lengths = { iris: [1, 4], atlas: [18, 55], vera: [8, 25], quill: [6, 14], scout: [5, 12] };
const perDay = { iris: 2.4, atlas: 0.7, vera: 0.6, quill: 0.15, scout: 0.25 };

// Two months back to an hour ago: more on weekdays, during working hours.
for (let day = 63; day >= 0; day--) {
  const base = new Date(now - day * D);
  base.setHours(0, 0, 0, 0);
  const weekend = base.getDay() === 0 || base.getDay() === 6;
  for (const key of Object.keys(W)) {
    let count = perDay[key] * (weekend ? 0.2 : 1) * (0.6 + rand() * 0.9) * (1 + (63 - day) / 250);
    while (count > 0) {
      if (count < 1 && rand() > count) break;
      count -= 1;
      const at = base.getTime() + (9 + rand() * 8) * H;
      if (at > now - H) continue;
      const [title, answer] = pick(work[key]);
      const [lo, hi] = costs[key];
      const [mlo, mhi] = lengths[key];
      const [by, via] = pick(askers[key]);
      const failed = rand() < 0.06 ? pick(['The ticket’s feature environment never came up.', 'The order system timed out three times.']) : undefined;
      run(W[key], { at, title, prompt: title, answer, cost: Math.round((lo + rand() * (hi - lo)) * 100) / 100, minutes: mlo + rand() * (mhi - mlo), by, via, failed });
    }
  }
}

// Today: a few fresh answers for the Inbox, and one pull request waiting for an OK.
run(W.iris, { at: now - 50 * 60_000, title: 'Why customers in Ontario see tax twice', prompt: 'Why are customers in Ontario seeing tax twice on the order summary?', answer: work.iris[1][1], cost: 0.31, minutes: 2, by: people.mei, via: 'slack' });
run(W.vera, { at: now - 3 * H, title: 'ACME-1185 passed QA', prompt: 'QA ACME-1185', answer: work.vera[2][1], cost: 1.42, minutes: 14, by: people.priya, via: 'slack' });
run(W.atlas, { at: now - 2 * H, title: 'Pagination on /v2/customers', prompt: 'ACME-1192: add cursor pagination to /v2/customers', answer: 'Cursor pagination on /v2/customers with a limit of 100 and a next link. 14 tests pass. Ready to push fix/acme-1192 and open the pull request.', cost: 3.9, minutes: 40, waiting: true });

fs.mkdirSync(path.join(STATE, 'org'), { recursive: true });
fs.writeFileSync(path.join(STATE, 'org', 'asks.json'), JSON.stringify(asks.sort((a, b) => a.at - b.at)));

fs.writeFileSync(path.join(STATE, 'seed-overgo.json'), JSON.stringify({ workers: Object.fromEntries(Object.entries(W).map(([k, w]) => [k, w.id])) }, null, 2));
console.log(`seeded ${Object.keys(W).length} workers, ${asks.length} asks in ${STATE}`);
