// What did the AI edit actually change? A revision hands back the WHOLE
// flow, not a patch, so without this the user sees the editor repaint and has
// to hunt for the difference — and worse, can't tell an unrequested rewrite
// from the one-line change they asked for. Diffing before/after gives the
// apply banner something concrete to say ("added step verify, changed step
// ship") and makes an over-eager model visible instead of silent.

import type { Flow, FlowStep } from '@shared/flows/schema';

/// Human-readable phrases describing how `after` differs from `before`.
/// Empty means the two are identical — the caller should say the flow came
/// back unchanged rather than claiming an edit landed.
export function summarizeFlowChanges(before: Flow, after: Flow): string[] {
  const out: string[] = [];

  if (before.name !== after.name) out.push(`renamed to "${after.name}"`);
  if ((before.description ?? '') !== (after.description ?? '')) out.push('description updated');
  if (stable(before.tags ?? []) !== stable(after.tags ?? [])) out.push('tags updated');
  if ((before.defaultPrompt ?? '') !== (after.defaultPrompt ?? '')) {
    out.push('default prompt updated');
  }

  out.push(...summarizeSteps(before.steps, after.steps));

  // Participants are largely derived from the steps' models, so an unchanged
  // cast is the common case and only worth mentioning on its own when no
  // step changed — otherwise it's noise next to "changed step plan".
  const stepsChanged = out.some((s) => s.includes('step'));
  if (!stepsChanged && stable(before.participants ?? []) !== stable(after.participants ?? [])) {
    out.push('participants updated');
  }

  return out;
}

function summarizeSteps(before: FlowStep[], after: FlowStep[]): string[] {
  const beforeById = byId(before);
  const afterById = byId(after);
  // Duplicate ids make a keyed diff meaningless (which "plan" changed?), so
  // fall back to the coarse answer rather than reporting a wrong one.
  if (!beforeById || !afterById) {
    return stable(before) === stable(after) ? [] : ['steps changed'];
  }

  const added = after.filter((s) => !beforeById.has(s.id)).map((s) => s.id);
  const removed = before.filter((s) => !afterById.has(s.id)).map((s) => s.id);
  const changed = after
    .filter((s) => beforeById.has(s.id) && stable(beforeById.get(s.id)) !== stable(s))
    .map((s) => s.id);

  const out: string[] = [];
  if (added.length > 0) out.push(`${plural(added.length, 'step')} added (${added.join(', ')})`);
  if (removed.length > 0) {
    out.push(`${plural(removed.length, 'step')} removed (${removed.join(', ')})`);
  }
  if (changed.length > 0) {
    out.push(`${plural(changed.length, 'step')} changed (${changed.join(', ')})`);
  }

  // Only call out a reorder when the surviving steps actually swapped places.
  // An insert or a delete shifts positions too, and reporting that as a
  // reorder on top of "1 step added" reads as two edits when there was one.
  const survivors = (steps: FlowStep[]) =>
    steps.filter((s) => beforeById.has(s.id) && afterById.has(s.id)).map((s) => s.id);
  if (stable(survivors(before)) !== stable(survivors(after))) out.push('steps reordered');

  return out;
}

/// id → step, or null when ids repeat.
function byId(steps: FlowStep[]): Map<string, FlowStep> | null {
  const map = new Map<string, FlowStep>();
  for (const step of steps) {
    if (map.has(step.id)) return null;
    map.set(step.id, step);
  }
  return map;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/// JSON with object keys sorted, so two structurally equal values compare
/// equal regardless of insertion order. The draft in the editor is built up
/// field by field while a revision is parsed fresh from YAML, so plain
/// JSON.stringify would report every step as changed.
function stable(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      // Treat an explicit `undefined` as absent — the editor sets keys to
      // undefined when clearing a field, the YAML parser just omits them.
      if (src[key] === undefined) continue;
      out[key] = normalize(src[key]);
    }
    return out;
  }
  return value;
}
