// The "Change it" forms in Slack: a pop-up (a Slack modal) for an offer from
// `/hire` and for a team from `/team new`, filled in from the draft. Each is
// built here and read back here; slackCommands opens them and acts on the
// answers. Which message to redraw rides along in the view's metadata.

import type { HireSummary } from '../org/orgService';
import type { TeamCheckpoints } from '../../shared/flows/team';
import type { WorkerVisibility } from '../../shared/flows/worker';

export const HIRE_EDIT_VIEW = 'overcli_hire_edit';
export const TEAM_EDIT_VIEW = 'overcli_team_edit';

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
