// The "Change it" forms in Slack: a pop-up (a Slack modal) for an offer from
// `/hire` and for a team from `/team new`, filled in from the draft. Each is
// built here and read back here; slackCommands opens them and acts on the
// answers. Which message to redraw rides along in the view's metadata.

import type { HireSummary } from '../org/orgService';
import type { TeamCheckpoints } from '../../shared/flows/team';
import type { WorkerTrustLevel, WorkerVisibility } from '../../shared/flows/worker';
import type { ScheduleTrigger } from '../../shared/flows/schedule';

export const HIRE_EDIT_VIEW = 'overcli_hire_edit';
export const TEAM_EDIT_VIEW = 'overcli_team_edit';
export const WORKER_EDIT_VIEW = 'overcli_worker_edit';

/// What a submitted form names: the draft, and the message to redraw.
export interface EditMeta {
  id: string;
  channel: string;
  ts: string;
}

const VISIBILITY: Array<[WorkerVisibility, string]> = [
  ['private', 'Just me'],
  ['team', 'People in my groups'],
  ['org', 'Everyone in the org'],
];
const NONE = '__none';

const text = (t: string) => ({ type: 'plain_text', text: t.slice(0, 75), emoji: false });
const option = (label: string, value: string) => ({ text: text(label), value: value.slice(0, 150) });

function input(blockId: string, label: string, element: Record<string, unknown>, opts: { optional?: boolean; hint?: string } = {}) {
  return {
    type: 'input',
    block_id: blockId,
    label: text(label),
    element: { action_id: 'v', ...element },
    ...(opts.optional ? { optional: true } : {}),
    ...(opts.hint ? { hint: { type: 'plain_text', text: opts.hint.slice(0, 150) } } : {}),
  };
}

function select(options: Array<{ text: unknown; value: string }>, initial?: string) {
  const first = options.find((o) => o.value === initial);
  return { type: 'static_select', options: options.slice(0, 100), ...(first ? { initial_option: first } : {}) };
}

function view(callbackId: string, title: string, meta: EditMeta, blocks: unknown[]) {
  return {
    type: 'modal',
    callback_id: callbackId,
    private_metadata: JSON.stringify(meta),
    title: text(title.slice(0, 24)),
    submit: text('Save'),
    close: text('Cancel'),
    blocks,
  };
}

export function hireEditView(
  hire: HireSummary,
  meta: EditMeta,
  choices: { tools: string[]; places: Array<{ name: string; path: string }>; bosses: Array<{ id: string; name: string }> },
) {
  const c = hire.contract!;
  const tools = [...new Set([...choices.tools, ...c.connectors])];
  const boss = choices.bosses.find((b) => b.name === c.reportsTo);
  return view(HIRE_EDIT_VIEW, `Change ${c.name}`, meta, [
    input('name', 'Name', { type: 'plain_text_input', initial_value: c.name, max_length: 40 }),
    input('budget', 'Monthly budget ($)', { type: 'number_input', is_decimal_allowed: false, min_value: '1', max_value: '10000', initial_value: String(c.budgetUSDPerMonth) }),
    input('visibility', 'Who can ask it', select(VISIBILITY.map(([v, l]) => option(l, v)), c.visibility ?? 'private'), {
      hint: 'Who can ask never widens what it can reach.',
    }),
    ...(tools.length
      ? [
          input(
            'tools',
            'Tools',
            {
              type: 'multi_static_select',
              options: tools.slice(0, 100).map((t) => option(t, t)),
              ...(c.connectors.length ? { initial_options: c.connectors.filter((t) => tools.includes(t)).map((t) => option(t, t)) } : {}),
            },
            { optional: true, hint: 'A tool beyond what you may give on your own sends the hire to an approver.' },
          ),
        ]
      : []),
    ...(choices.places.length
      ? [
          input(
            'place',
            'Where it works',
            select([option('Where its job says', NONE), ...choices.places.map((p) => option(p.name, p.path))], choices.places.find((p) => p.path === c.projectPath)?.path ?? NONE),
          ),
        ]
      : []),
    ...(choices.bosses.length
      ? [input('boss', 'Reports to', select([option('Nobody: you manage it directly', NONE), ...choices.bosses.map((b) => option(b.name, b.id))], boss?.id ?? NONE))]
      : []),
  ]);
}

type Values = Record<string, Record<string, { value?: string | null; selected_option?: { value: string } | null; selected_options?: Array<{ value: string }> }>>;

export function readHireEdit(values: Values): { name?: string; budgetUSDPerMonth?: number; visibility?: WorkerVisibility; mcpServers?: string[]; projectPath?: string | null; reportsTo?: string | null } {
  const v = (b: string) => values[b]?.v;
  const out: ReturnType<typeof readHireEdit> = {};
  if (v('name')?.value != null) out.name = v('name')!.value!;
  if (v('budget')?.value) out.budgetUSDPerMonth = Number(v('budget')!.value);
  const vis = v('visibility')?.selected_option?.value;
  if (vis === 'private' || vis === 'team' || vis === 'org') out.visibility = vis;
  if (values.tools) out.mcpServers = (v('tools')?.selected_options ?? []).map((o) => o.value);
  if (values.place) out.projectPath = v('place')?.selected_option?.value === NONE ? null : v('place')?.selected_option?.value ?? null;
  if (values.boss) out.reportsTo = v('boss')?.selected_option?.value === NONE ? null : v('boss')?.selected_option?.value ?? null;
  return out;
}

/// A team suggested by `/team new`, before it is made.
export interface TeamDraftForm {
  name: string;
  purpose: string;
  budgetUSDPerTask: number;
  checkpoints: TeamCheckpoints;
  hireVisibility: WorkerVisibility;
  hasHires: boolean;
}

const CHECKS: Array<[keyof TeamCheckpoints, string]> = [
  ['askFirst', 'Asks what it needs to know first'],
  ['reviewBeforeChallenge', 'You read the draft before it’s challenged'],
  ['finalReview', 'You review the result'],
  ['approveRoomWork', 'You approve follow-up work'],
];

export function teamEditView(draft: TeamDraftForm, meta: EditMeta) {
  const checks = CHECKS.map(([k, l]) => option(l, k));
  const on = checks.filter((o) => draft.checkpoints[o.value as keyof TeamCheckpoints]);
  return view(TEAM_EDIT_VIEW, `Change ${draft.name}`, meta, [
    input('name', 'Name', { type: 'plain_text_input', initial_value: draft.name, max_length: 80 }),
    input('purpose', 'What it does', { type: 'plain_text_input', initial_value: draft.purpose, multiline: true, max_length: 500 }),
    input('budget', 'Budget per task ($)', { type: 'number_input', is_decimal_allowed: false, min_value: '1', initial_value: String(draft.budgetUSDPerTask) }, {
      hint: 'When a task would go over, it stops and asks you.',
    }),
    input('checks', 'Where it checks in with you', { type: 'checkboxes', options: checks, ...(on.length ? { initial_options: on } : {}) }, {
      optional: true,
      hint: 'You always approve the plan.',
    }),
    ...(draft.hasHires ? [input('visibility', 'Who can ask its new hires', select(VISIBILITY.map(([v, l]) => option(l, v)), draft.hireVisibility))] : []),
  ]);
}

export function readTeamEdit(values: Values, current: TeamDraftForm): TeamDraftForm {
  const v = (b: string) => values[b]?.v;
  const picked = new Set((v('checks')?.selected_options ?? []).map((o) => o.value));
  const vis = v('visibility')?.selected_option?.value;
  const budget = Number(v('budget')?.value);
  return {
    name: (v('name')?.value ?? current.name).trim() || current.name,
    purpose: (v('purpose')?.value ?? current.purpose).trim(),
    budgetUSDPerTask: Number.isFinite(budget) && budget > 0 ? Math.round(budget) : current.budgetUSDPerTask,
    checkpoints: {
      askFirst: picked.has('askFirst'),
      reviewBeforeChallenge: picked.has('reviewBeforeChallenge'),
      finalReview: picked.has('finalReview'),
      approveRoomWork: picked.has('approveRoomWork'),
    },
    hireVisibility: vis === 'private' || vis === 'team' || vis === 'org' ? vis : current.hireVisibility,
    hasHires: current.hasHires,
  };
}

/// The schedules `/worker <name> edit` offers, besides keeping the one it has.
const SCHEDULES: Array<[string, string, ScheduleTrigger | null]> = [
  ['asked', 'Only when asked', null],
  ['weekdays', 'Weekdays at 9am', { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }],
  ['daily', 'Every day at 9am', { kind: 'daily', time: '09:00' }],
  ['hourly', 'Every hour, weekdays 8am–6pm', { kind: 'interval', everyMinutes: 60, days: [1, 2, 3, 4, 5], window: { start: '08:00', end: '18:00' } }],
];
const KEEP = '__keep';
/// Slack's longest text box; a longer job is changed in the console.
const JOB_MAX = 3000;

/// The trust levels, as the console's ladder names them.
const TRUST: Array<[WorkerTrustLevel, string]> = [
  ['probation', 'Asks first: proposes, you say go'],
  ['trusted', 'Trusted: starts its own work, asks before acting outside'],
  ['autonomous', 'On its own: acts outside without asking'],
];

/// `/worker <name> edit`: what its manager changes most, in Slack. Tools
/// and repos change what it may reach, so they stay in the console. Its job
/// can be rewritten by hand, or by saying what should change: that comes
/// back as a DM to read and accept, never saved unseen.
export function workerEditView(
  w: { name: string; jobDescription: string; budgetUSDPerMonth: number; visibility: WorkerVisibility; schedule: string; answersAtOnce: number; trust: WorkerTrustLevel; skipCheckpoints?: boolean },
  meta: EditMeta,
  opts: { admin: boolean } = { admin: false },
) {
  const jobFits = w.jobDescription.length <= JOB_MAX;
  // Only an admin makes a worker autonomous; one already there keeps its
  // option so the form shows where it stands.
  const trust = TRUST.filter(([v]) => v !== 'autonomous' || opts.admin || w.trust === 'autonomous');
  return view(WORKER_EDIT_VIEW, `Change ${w.name}`, meta, [
    ...(jobFits
      ? [input('job', 'Its job', { type: 'plain_text_input', multiline: true, max_length: JOB_MAX, initial_value: w.jobDescription }, { hint: 'What it reads before every run.' })]
      : [{ type: 'context', elements: [{ type: 'mrkdwn', text: 'Its job is too long to change by hand here: say what should change below, or change it on its Job tab in the console.' }] }]),
    input('ask', 'Or say what should change', { type: 'plain_text_input', multiline: true, max_length: 1000, placeholder: text('e.g. also check the Ops board on Fridays') }, {
      optional: true,
      hint: 'I rewrite its job with this and DM you the new version to accept.',
    }),
    input('trust', 'How much it does alone', select(trust.map(([v, l]) => option(l, v)), w.trust), {
      hint: opts.admin ? 'Asking first is safest for a new worker.' : 'Only an admin can let it act on its own.',
    }),
    ...(opts.admin
      ? [input('checkpoints', 'Its flows’ checkpoints', { type: 'checkboxes', options: [option('Run straight through them', 'skip')], ...(w.skipCheckpoints ? { initial_options: [option('Run straight through them', 'skip')] } : {}) }, {
          optional: true,
          hint: 'Where a flow stops so someone looks before a step. Acting outside still asks unless its trust says otherwise.',
        })]
      : []),
    input('schedule', 'When it runs', select([option(`Keep: ${w.schedule}`, KEEP), ...SCHEDULES.map(([v, l]) => option(l, v))], KEEP)),
    input('budget', 'Monthly budget ($)', { type: 'number_input', is_decimal_allowed: false, min_value: '1', max_value: '10000', initial_value: String(w.budgetUSDPerMonth) }),
    input('visibility', 'Who can ask it', select(VISIBILITY.map(([v, l]) => option(l, v)), w.visibility), { hint: 'Who can ask never widens what it can reach.' }),
    input('atonce', 'Slack conversations at once', select([1, 2, 3, 4, 5, 6].map((n) => option(n === 1 ? 'One at a time' : `${n} at once`, String(n))), String(w.answersAtOnce)), {
      hint: 'Each in its own thread. Each answer counts against its budget.',
    }),
  ]);
}

export interface WorkerEditAnswers {
  patch: { jobDescription?: string; cadence?: ScheduleTrigger | null; budgetUSDPerMonth?: number; visibility?: WorkerVisibility; answersAtOnce?: number; skipCheckpoints?: boolean };
  /// A change to its job, said in words, to rewrite it with.
  ask?: string;
  trust?: WorkerTrustLevel;
}

export function readWorkerEdit(values: Values): WorkerEditAnswers {
  const v = (b: string) => values[b]?.v;
  const patch: WorkerEditAnswers['patch'] = {};
  const job = v('job')?.value;
  if (typeof job === 'string' && job.trim()) patch.jobDescription = job.trim();
  const sched = v('schedule')?.selected_option?.value;
  const picked = SCHEDULES.find(([k]) => k === sched);
  if (picked) patch.cadence = picked[2];
  if (v('budget')?.value) patch.budgetUSDPerMonth = Number(v('budget')!.value);
  const vis = v('visibility')?.selected_option?.value;
  if (vis === 'private' || vis === 'team' || vis === 'org') patch.visibility = vis;
  const n = Number(v('atonce')?.selected_option?.value);
  if (Number.isInteger(n) && n >= 1) patch.answersAtOnce = n;
  // Only an admin's form has the box; read it only when it was there.
  if (values.checkpoints) patch.skipCheckpoints = (v('checkpoints')?.selected_options ?? []).some((o) => o.value === 'skip');
  const ask = v('ask')?.value?.trim();
  const trust = v('trust')?.selected_option?.value;
  return {
    patch,
    ...(ask ? { ask } : {}),
    ...(trust === 'probation' || trust === 'trusted' || trust === 'autonomous' ? { trust } : {}),
  };
}
