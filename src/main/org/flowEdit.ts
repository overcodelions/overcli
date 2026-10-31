// Changing how a worker works by saying what should change: "run the tests
// before you push", "stop for me after the plan". The model revises the
// flow (reviseFlowFromPrompt); what comes back is held to what the flow
// could already do before anyone reads it, so a sentence can't widen a
// worker: no tool its steps didn't have, the same models, every outside
// step still asking, and only an admin takes a checkpoint out. Nothing here
// saves.

import type { Flow, FlowModelRef, FlowStep } from '../../shared/flows/schema';
import { resolveStepEffect } from '../flows/stepEffect';

/// More than any flow a manager would read as a list.
export const FLOW_EDIT_MAX_STEPS = 12;

/// A step as the Job tab shows it.
export interface FlowStepView {
  id: string;
  label: string;
  tools: string[];
  /// It stops for someone before it starts.
  checkpoint: boolean;
  /// It acts outside the server, so it asks first.
  external: boolean;
  onlyIfChanged: boolean;
}

/// "run_tests" → "Run tests".
export function stepLabel(s: Pick<FlowStep, 'id'>): string {
  const t = s.id.replace(/[_-]+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : s.id;
}

export function stepsOf(flow: Pick<Flow, 'steps'>): FlowStepView[] {
  return flow.steps.map((s, i) => ({
    id: s.id,
    label: stepLabel(s),
    tools: [...(s.tools ?? [])],
    // The first step has nothing before it to stop after.
    checkpoint: i > 0 && s.pauseBefore === true,
    external: resolveStepEffect(s) === 'external',
    onlyIfChanged: s.onlyIfChanged === true,
  }));
}

type Held = { ok: true; flow: Flow } | { ok: false; error: string };

const sameModel = (a: FlowModelRef, b: FlowModelRef) => a.backend === b.backend && a.model === b.model;

/// `after` kept within what `before` allowed. Errors say what to ask for
/// instead; quiet repairs (models, permission modes, approvals) are made.
/// `servers` are the MCP servers the worker already holds: its flow may take
/// up their tools, since whoever gave it the server already said it may use
/// them. Anything else new is refused.
export function holdFlowEdit(before: Flow, after: Flow, opts: { admin: boolean; servers?: string[] }): Held {
  if (!after.steps.length) return { ok: false, error: 'It needs at least one step.' };
  if (after.steps.length > FLOW_EDIT_MAX_STEPS) return { ok: false, error: `Keep it to ${FLOW_EDIT_MAX_STEPS} steps or fewer.` };
  const was = new Map(before.steps.map((s) => [s.id, s]));
  const tools = new Set(before.steps.flatMap((s) => s.tools ?? []));
  const anyUntooled = before.steps.some((s) => !(s.tools ?? []).length);
  const modes = new Set(before.steps.flatMap((s) => (s.permissionMode ? [s.permissionMode] : [])));
  const critics: FlowModelRef[] = [
    ...before.participants.map((p) => ({ backend: p.backend, model: p.model })),
    ...before.steps.flatMap((s) => (s.rebound ? [s.rebound.critic] : [])),
  ];
  const people = new Set(before.steps.flatMap((s) => s.handsOff ?? []));
  const participants = new Set(before.participants.map((p) => p.id));
  const primary = before.participants[0]?.id;
  const servers = new Set(opts.servers ?? []);
  // An MCP tool is `mcp__<server>__<tool>`; `mcp__<server>` alone is all of them.
  const held = (t: string) => [...servers].some((n) => t === `mcp__${n}` || t.startsWith(`mcp__${n}__`));

  if (!opts.admin) {
    const stops = before.steps.filter((s, i) => i > 0 && s.pauseBefore);
    const kept = new Map(after.steps.map((s, i) => [s.id, i > 0 && s.pauseBefore === true]));
    const gone = stops.find((s) => !kept.get(s.id));
    if (gone) return { ok: false, error: `Only an admin can take out the stop before “${stepLabel(gone)}”.` };
  }

  const steps: FlowStep[] = [];
  for (const s of after.steps) {
    const old = was.get(s.id);
    // No tools listed lets a step use any. A flow that had no such step gets
    // none: an empty step is one that only writes up what came before it
    // (a report, a summary), so it reads and nothing else.
    const readOnly = !(s.tools ?? []).length && !anyUntooled;
    const list = readOnly ? ['Read'] : (s.tools ?? []);
    const extra = readOnly ? [] : [...new Set(list.filter((t) => !tools.has(t) && !held(t)))];
    const missing = [...new Set(extra.flatMap((t) => /^mcp__(.+?)(?:__|$)/.exec(t)?.slice(1, 2) ?? []))];
    if (missing.length) {
      return { ok: false, error: `That needs the ${missing.join(' and ')} tool${missing.length === 1 ? '' : 's'}. Give it ${missing.length === 1 ? 'that' : 'those'} on Setup → Tools first.` };
    }
    if (extra.length) {
      return { ok: false, error: `That needs ${extra.join(', ')}, which none of its steps can use now.` };
    }
    const { model: _model, rebound, ...rest } = s;
    const step: FlowStep = {
      ...rest,
      ...(readOnly ? { tools: list } : {}),
      ...(old?.model ? { model: old.model } : {}),
      participantId: participants.has(s.participantId) ? s.participantId : (old?.participantId ?? primary ?? s.participantId),
    };
    if (old?.rebound) step.rebound = rebound ? { ...rebound, critic: old.rebound.critic } : old.rebound;
    else if (rebound && critics.some((c) => sameModel(c, rebound.critic))) step.rebound = rebound;
    if (step.permissionMode && !modes.has(step.permissionMode)) {
      if (old?.permissionMode) step.permissionMode = old.permissionMode;
      else delete step.permissionMode;
    }
    if (step.handsOff) {
      const to = step.handsOff.filter((n) => people.has(n));
      if (to.length) step.handsOff = to;
      else delete step.handsOff;
    }
    // A step that asked before still asks, whatever its new words say.
    if (old && resolveStepEffect(old) === 'external') step.effect = 'external';
    steps.push(step);
  }
  return {
    ok: true,
    flow: {
      ...after,
      id: before.id,
      name: after.name?.trim() || before.name,
      input: before.input,
      participants: structuredClone(before.participants),
      steps,
      ...(before.tags ? { tags: [...before.tags] } : {}),
      ...(before.archived ? { archived: true } : {}),
      source: before.source,
      filePath: before.filePath,
    },
  };
}

/// What changed, in words, for the person to read before saving. Empty:
/// nothing a step does changed.
export function describeFlowEdit(before: Flow, after: Flow): string[] {
  const out: string[] = [];
  const was = new Map(before.steps.map((s, i) => [s.id, { s, i }]));
  const now = new Map(after.steps.map((s, i) => [s.id, { s, i }]));
  for (const s of before.steps) if (!now.has(s.id)) out.push(`Takes out “${stepLabel(s)}”.`);
  after.steps.forEach((s, i) => {
    const o = was.get(s.id);
    if (!o) {
      out.push(i > 0 ? `Adds “${stepLabel(s)}” after “${stepLabel(after.steps[i - 1])}”.` : `Adds “${stepLabel(s)}” first.`);
      return;
    }
    const a = o.s;
    const stopA = o.i > 0 && a.pauseBefore === true;
    const stopB = i > 0 && s.pauseBefore === true;
    if (!stopA && stopB) out.push(`Stops for someone before “${stepLabel(s)}”.`);
    if (stopA && !stopB) out.push(`No longer stops before “${stepLabel(s)}”.`);
    const gained = (s.tools ?? []).filter((t) => !(a.tools ?? []).includes(t));
    const lost = (a.tools ?? []).filter((t) => !(s.tools ?? []).includes(t));
    if (gained.length) out.push(`“${stepLabel(s)}” can also use ${gained.join(', ')}.`);
    if (lost.length) out.push(`“${stepLabel(s)}” no longer uses ${lost.join(', ')}.`);
    if ((a.systemPromptOverride ?? '') !== (s.systemPromptOverride ?? '') || a.role !== s.role || a.output !== s.output) out.push(`Changes what “${stepLabel(s)}” does.`);
    if (!a.onlyIfChanged && s.onlyIfChanged) out.push(`Skips “${stepLabel(s)}” when nothing changed.`);
    if (a.onlyIfChanged && !s.onlyIfChanged) out.push(`Always runs “${stepLabel(s)}”.`);
    if (JSON.stringify(a.inputs) !== JSON.stringify(s.inputs) || JSON.stringify(a.onFail ?? null) !== JSON.stringify(s.onFail ?? null) || JSON.stringify(a.rebound ?? null) !== JSON.stringify(s.rebound ?? null)) {
      if (!out.some((x) => x.includes(`“${stepLabel(s)}” does`))) out.push(`Changes how “${stepLabel(s)}” is checked or fed.`);
    }
  });
  const order = (f: Flow, keep: Set<string>) => f.steps.map((s) => s.id).filter((id) => keep.has(id));
  const both = new Set(before.steps.map((s) => s.id).filter((id) => now.has(id)));
  if (order(before, both).join('\n') !== order(after, both).join('\n')) out.push('Puts the steps in a new order.');
  return out;
}

/// A free id for a worker's own copy of a shared flow.
export function copyFlowId(flowId: string, workerName: string, taken: (id: string) => boolean): string {
  const who = workerName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worker';
  const base = `${flowId}-${who}`.slice(0, 60).replace(/-+$/, '');
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}
