// "Upgrade models" for saved flows. A flow pins its models by id, and a pin
// that is still in the catalog is never moved on load — `liftMissingModel`
// only rescues ids we've dropped. So when a newer model ships (Opus 5 →
// Opus 5.5), every existing flow keeps running the old one until something
// moves it. This is that something, and it's deliberately a reviewed action
// rather than an automatic one: a pin can be on purpose, and a model swap
// changes what a flow costs and how it behaves.
//
// Pure: plans the changes and applies them to a Flow value. Saving is the
// store's job.

import { friendlyModelLabel, newestInFamily } from '../modelCatalog';
import type { Backend } from '../types';
import { flowStarKey, type Flow, type FlowModelRef } from './schema';

/// One model the upgrade would move. Grouped by id pair, not by location: a
/// flow that runs Opus 5 in three places has one decision to make, not three.
export interface FlowModelChange {
  backend: Backend;
  from: string;
  to: string;
  /// Human-readable places the model is used ("Primary", "review critic").
  where: string[];
}

export interface FlowModelUpgrade {
  flow: Flow;
  changes: FlowModelChange[];
}

function upgradeTarget(backend: Backend, model: string): string {
  if (backend === 'ollama') return model;
  return newestInFamily(backend, model);
}

/// What upgrading this flow would change. Empty when it's already current.
export function planFlowModelUpgrade(flow: Flow): FlowModelChange[] {
  const byPair = new Map<string, FlowModelChange>();
  const note = (ref: FlowModelRef, where: string) => {
    const to = upgradeTarget(ref.backend, ref.model);
    if (to === ref.model) return;
    const key = `${ref.backend}|${ref.model}`;
    const existing = byPair.get(key);
    if (existing) {
      if (!existing.where.includes(where)) existing.where.push(where);
    } else {
      byPair.set(key, { backend: ref.backend, from: ref.model, to, where: [where] });
    }
  };
  for (const p of flow.participants) note(p, p.name);
  for (const step of flow.steps) {
    // Legacy per-step model: the loader already synthesized a participant
    // for it (noted above), so only the critic is a location of its own.
    if (step.rebound) note(step.rebound.critic, `${step.id} critic`);
  }
  return [...byPair.values()];
}

/// Every flow the library would offer to upgrade, skipping the pairs the user
/// already said no to. `generated` flows are worker machinery the library
/// hides; they're left for the worker that owns them.
export function pendingModelUpgrades(flows: Flow[], skipped: string[] = []): FlowModelUpgrade[] {
  const skip = new Set(skipped);
  const out: FlowModelUpgrade[] = [];
  for (const flow of flows) {
    if (flow.source === 'generated') continue;
    const changes = planFlowModelUpgrade(flow).filter(
      (c) => !skip.has(modelUpgradeSkipKey(flow, c)),
    );
    if (changes.length > 0) out.push({ flow, changes });
  }
  return out;
}

/// Settings key recording "don't offer this upgrade for this flow again".
/// Includes the target, so a declined Opus 5 → 5.5 still gets offered when a
/// later Opus ships.
export function modelUpgradeSkipKey(
  flow: Pick<Flow, 'source' | 'id'>,
  change: Pick<FlowModelChange, 'backend' | 'from' | 'to'>,
): string {
  return `${flowStarKey(flow)}|${change.backend}:${change.from}>${change.to}`;
}

/// Whether a participant name is just a label for a model in `model`'s line,
/// as opposed to something the user wrote ("Grumpy reviewer"). Compared on
/// letters alone, so every spelling the app has ever minted matches: the
/// picker's "Claude Opus 4.8", older auto-names like "Claude opus 4 8", the
/// raw id — and a name one version behind its model ("Claude opus 4 7" on a
/// flow that `liftMissingModel` already moved to 4.8). Needs a digit, so a
/// bare "Claude Opus" someone typed on purpose isn't taken for a label.
export function isModelDerivedName(name: string, backend: Backend, model: string): boolean {
  if (!/\d/.test(name)) return false;
  const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  const wanted = letters(name);
  return wanted === letters(friendlyModelLabel(backend, model)) || wanted === letters(model);
}

/// A change as short as it can go for a one-line summary: "Opus 5 → 5.5",
/// "Gemini 3.6 Flash → 3.7 Flash". Drops the "Claude" brand, a shared
/// "(Codex)"-style suffix, and whatever words the two ends open with.
export function shortModelChangeLabel(c: Pick<FlowModelChange, 'backend' | 'from' | 'to'>): string {
  let from = friendlyModelLabel(c.backend, c.from);
  let to = friendlyModelLabel(c.backend, c.to);
  const suffix = / \([^)]*\)$/.exec(from)?.[0];
  if (suffix && to.endsWith(suffix)) {
    from = from.slice(0, -suffix.length);
    to = to.slice(0, -suffix.length);
  }
  from = from.replace(/^Claude /, '');
  to = to.replace(/^Claude /, '');
  const a = from.split(' ');
  const b = to.split(' ');
  let i = 0;
  while (i < a.length - 1 && i < b.length - 1 && a[i] === b[i]) i++;
  return `${from} → ${b.slice(i).join(' ')}`;
}

/// The flow with `changes` applied. A participant whose name is only a label
/// for its old model (see `isModelDerivedName`) is renamed to match the new
/// one; a name the user wrote themselves is left alone.
export function applyFlowModelUpgrade(flow: Flow, changes: FlowModelChange[]): Flow {
  const lookup = new Map(changes.map((c) => [`${c.backend}|${c.from}`, c.to]));
  const lift = <T extends FlowModelRef>(ref: T): T => {
    const to = lookup.get(`${ref.backend}|${ref.model}`);
    return to ? { ...ref, model: to } : ref;
  };
  return {
    ...flow,
    participants: flow.participants.map((p) => {
      const next = lift(p);
      if (next === p) return p;
      const renamed = isModelDerivedName(p.name, p.backend, p.model);
      return renamed ? { ...next, name: friendlyModelLabel(next.backend, next.model) } : next;
    }),
    steps: flow.steps.map((step) => {
      const model = step.model ? lift(step.model) : step.model;
      const critic = step.rebound ? lift(step.rebound.critic) : undefined;
      if (model === step.model && critic === step.rebound?.critic) return step;
      return {
        ...step,
        model,
        rebound: step.rebound && critic ? { ...step.rebound, critic } : step.rebound,
      };
    }),
  };
}
