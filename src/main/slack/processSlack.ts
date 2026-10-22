// Processes in Slack: a decision DM with Approve / Send back / Stop, the
// form that asks what to change when sending back, the form a stage that
// asks for something is filled in with, and `/idea`.

import type { ProcessStage } from '../../shared/org/process';
import { escapeMrkdwn } from './slackApi';

export const PROC_APPROVE_ACTION = 'overcli_proc_approve';
export const PROC_SENDBACK_ACTION = 'overcli_proc_sendback';
export const PROC_STOP_ACTION = 'overcli_proc_stop';
export const PROC_SENDBACK_VIEW = 'overcli_proc_sendback_view';
export const PROC_FILL_ACTION = 'overcli_proc_fill';
export const PROC_FILL_VIEW = 'overcli_proc_fill_view';

export const PROC_ACTIONS = new Set([PROC_APPROVE_ACTION, PROC_SENDBACK_ACTION, PROC_STOP_ACTION, PROC_FILL_ACTION]);

/// What the send-back form carries back: the item, the stage it was asked
/// at, and the DM to settle.
export interface SendBackMeta {
  itemId: string;
  stageId?: string;
  channel: string;
  ts: string;
}

/// A decision button's value: the item and the stage it was asked at, so a
/// button left over from a stage the item has since left decides nothing.
/// Item ids never hold a colon; stage ids may.
export function decisionValue(itemId: string, stageId: string): string {
  return `${itemId}:${stageId}`;
}

/// The item and stage a button names. A button from before stages were
/// named has none, and is refused as out of date.
export function readDecisionValue(value: string): { itemId: string; stageId?: string } {
  const at = value.indexOf(':');
  return at < 0 ? { itemId: value } : { itemId: value.slice(0, at), stageId: value.slice(at + 1) };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/// The DM's buttons. A stage that asks for something opens its form in place
/// of Approve; an input stage has no decision to make, so says "Fill it in".
export function decisionBlocks(text: string, itemId: string, stageId: string, stage?: Pick<ProcessStage, 'mode' | 'fields'>): unknown[] {
  const button = (label: string, actionId: string, style?: 'primary' | 'danger') => ({
    type: 'button',
    text: { type: 'plain_text', text: label },
    action_id: actionId,
    value: decisionValue(itemId, stageId),
    ...(style ? { style } : {}),
  });
  return [
    { type: 'section', text: { type: 'mrkdwn', text: clip(text, 2900) } },
    {
      type: 'actions',
      elements: [
        stage?.fields?.length ? button(stage.mode === 'input' ? 'Fill it in…' : 'Approve…', PROC_FILL_ACTION, 'primary') : button('Approve', PROC_APPROVE_ACTION, 'primary'),
        button('Send back…', PROC_SENDBACK_ACTION),
        button('Stop it', PROC_STOP_ACTION, 'danger'),
      ],
    },
  ];
}

/// The form for a stage that asks for something: one input per field, and
/// a note. Submitting it is the approve.
export function fillView(title: string, stage: Pick<ProcessStage, 'name' | 'ask' | 'mode' | 'fields'>, meta: SendBackMeta): unknown {
  const input = stage.mode === 'input';
  const plain = (text: string) => ({ type: 'plain_text', text: clip(text, 150) });
  return {
    type: 'modal',
    callback_id: PROC_FILL_VIEW,
    private_metadata: JSON.stringify(meta),
    title: plain(clip(stage.name, 24)),
    submit: plain(input ? 'Submit' : 'Approve'),
    close: plain('Cancel'),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `_${escapeMrkdwn(clip(title, 200))}_${stage.ask ? `\n> ${escapeMrkdwn(clip(stage.ask, 600))}` : ''}\nWhat you put here is handed on to the stages after.` } },
      ...(stage.fields ?? []).map((f) => ({
        type: 'input',
        block_id: `f_${f.id}`,
        optional: !f.required,
        label: plain(f.label),
        element:
          f.kind === 'choice'
            ? { type: 'static_select', action_id: 'v', options: (f.options ?? []).slice(0, 100).map((o) => ({ text: plain(o), value: o.slice(0, 150) })) }
            : { type: 'plain_text_input', action_id: 'v', multiline: f.kind === 'longText', max_length: f.kind === 'longText' ? 3000 : 400 },
      })),
      {
        type: 'input',
        block_id: 'note',
        optional: true,
        label: plain('Anything else'),
        element: { type: 'plain_text_input', action_id: 'v', multiline: true, max_length: 2000 },
      },
    ],
  };
}

/// The form's answers by field id, and its note.
export function readFill(values: Record<string, Record<string, { value?: string | null; selected_option?: { value?: string } | null }>>): { answers: Record<string, string>; note: string } {
  const answers: Record<string, string> = {};
  for (const [block, v] of Object.entries(values)) {
    if (!block.startsWith('f_')) continue;
    const got = v.v?.selected_option?.value ?? v.v?.value ?? '';
    if (got.trim()) answers[block.slice(2)] = got.trim();
  }
  return { answers, note: values.note?.v?.value?.trim() ?? '' };
}

export function sendBackView(title: string, meta: SendBackMeta): unknown {
  return {
    type: 'modal',
    callback_id: PROC_SENDBACK_VIEW,
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: 'Send it back' },
    submit: { type: 'plain_text', text: 'Send back' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `_${escapeMrkdwn(clip(title, 200))}_ goes back to the stage before. Say what needs to change: they're briefed with it.` } },
      {
        type: 'input',
        block_id: 'note',
        label: { type: 'plain_text', text: 'What needs to change' },
        element: { type: 'plain_text_input', action_id: 'v', multiline: true, min_length: 3, max_length: 2000 },
      },
    ],
  };
}

export function readSendBack(values: Record<string, Record<string, { value?: string }>>): string {
  return values.note?.v?.value?.trim() ?? '';
}

/// `/idea [process name:] what it is`. With one process the name can go.
export function parseIdea(text: string, processes: Array<{ id: string; name: string }>): { processId: string; brief: string } | { error: string } | null {
  const t = text.trim();
  if (!t) return null;
  const named = /^([^:]{1,80}):\s*([\s\S]+)$/.exec(t);
  if (named) {
    const key = named[1].trim().toLowerCase();
    const p = processes.find((x) => x.name.toLowerCase() === key);
    if (p) return { processId: p.id, brief: named[2].trim() };
  }
  if (processes.length === 1) return { processId: processes[0].id, brief: t };
  if (!processes.length) return { error: 'There are no processes to put ideas into yet. Someone can make one on the console’s Processes page.' };
  return { error: `Which process? Start with its name: ${processes.map((p) => `\`/idea ${p.name}: …\``).join(', ')}` };
}
