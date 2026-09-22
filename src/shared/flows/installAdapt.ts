// Adapt a registry flow to the machine it is being installed on.
//
// Registry YAML names the author's models: every flow in the public registry
// uses Claude somewhere, and most use nothing else. Written verbatim, a flow
// installed on a Codex-only machine fails preflight on its first step with
// `Backend "claude" is not ready`, and the only way forward is hand-editing
// every participant — which is exactly the problem `templateResolver` already
// solves for the built-in templates. Registry installs never went through it.
//
// Two differences from how the picker uses the resolver, both deliberate:
//
//   - Only what cannot run here is touched. The picker rebinds every
//     participant to the user's tier defaults, which is right for a template
//     that exists to be customised. A registry flow's model picks are the
//     author's, and one that already runs on this machine keeps them.
//   - Names stay. The resolver renames a participant to its model's label;
//     registry flows name participants by role ("Scout", "Lead"), and those
//     names mean something in the run view.
//
// The edit is a splice into the original text, not a re-serialisation. The
// parser only locates each value; the new model is written over exactly those
// bytes. Every other byte of the file is untouched by construction — which
// matters, because re-serialising cannot round-trip the registry: its files
// write lists unpadded (`[Read, Grep]`) and maps padded (`{ name: … }`), and
// the serialiser has one switch for both. Comments survive the same way; they
// are often the only record of why a step is wired as it is.

import { isMap, isScalar, isSeq, parseDocument, type Scalar, type YAMLMap } from 'yaml';

import type { Backend } from '../types';
import { pickForParticipant, type TemplateResolveContext } from './templateResolver';

export interface InstallAdaptation {
  /// Where in the flow, for the install result: "participant Scout",
  /// "step build critic".
  where: string;
  from: string;
  to: string;
}

export interface AdaptResult {
  /// Byte-identical to the input when nothing needed changing — no
  /// re-serialisation, so no formatting churn in a flow that was fine.
  yaml: string;
  changes: InstallAdaptation[];
}

type Ref = { backend: Backend; model: string };

/// Can this machine run the model as written?
export function canRun(ref: Ref, ctx: TemplateResolveContext): boolean {
  if (!ctx.healthyBackends.includes(ref.backend)) return false;
  if (ref.backend !== 'ollama') return true;
  // Ollama names carry a tag ("qwen2.5-coder:7b"); an untagged reference
  // means ":latest" to ollama, so accept any installed tag of that name.
  return ctx.ollamaModels.some((m) => m === ref.model || m.startsWith(`${ref.model}:`));
}

/// The replacement for one reference, or undefined when it can run as written
/// (or when nothing on this machine can run it either, in which case leaving
/// it alone lets preflight say so in the author's own terms).
function replacementFor(ref: Ref, ctx: TemplateResolveContext): Ref | undefined {
  if (canRun(ref, ctx)) return undefined;
  const pick = pickForParticipant({ id: '', name: '', backend: ref.backend, model: ref.model }, ctx);
  if (!pick) return undefined;
  if (pick.backend === ref.backend && pick.model === ref.model) return undefined;
  return pick;
}

const show = (r: Ref) => `${r.backend}:${r.model}`;

/// One replacement over a span of the original text.
type Splice = { start: number; end: number; text: string };

/// Render a value in the same quoting style as the scalar it replaces, so a
/// quoted model stays quoted and a plain one stays plain.
function render(value: string, like: Scalar): string {
  if (like.type === 'QUOTE_DOUBLE') return JSON.stringify(value);
  if (like.type === 'QUOTE_SINGLE') return `'${value.replace(/'/g, "''")}'`;
  return value;
}

/// Overwrite one scalar's value in place.
function spliceScalar(node: unknown, value: string, out: Splice[]): boolean {
  if (!isScalar(node) || !node.range) return false;
  out.push({ start: node.range[0], end: node.range[1], text: render(value, node) });
  return true;
}

/// Read a `{ backend, model }` map or the compact `"backend:model"` string —
/// the two shapes `parseFlowYaml` accepts for participants, step models and
/// critics. A map with no `backend` means Claude, as it does to the parser.
function readRef(node: unknown): Ref | undefined {
  if (isMap(node)) {
    const model = node.get('model');
    if (typeof model !== 'string' || !model) return undefined;
    const backend = node.get('backend');
    return { backend: (typeof backend === 'string' ? backend : 'claude') as Backend, model };
  }
  if (isScalar(node) && typeof node.value === 'string') {
    const i = node.value.indexOf(':');
    if (i > 0) return { backend: node.value.slice(0, i) as Backend, model: node.value.slice(i + 1) };
  }
  return undefined;
}

/// Queue the splices that rewrite one reference in the shape it was read in.
/// False when the source has a shape this cannot edit precisely, so the
/// caller can give up on the whole file rather than half-adapt it.
function spliceRef(node: unknown, next: Ref, source: string, out: Splice[]): boolean {
  if (isScalar(node)) return spliceScalar(node, show(next), out);
  if (!isMap(node)) return false;
  const modelPair = node.items.find((it) => isScalar(it.key) && it.key.value === 'model');
  if (!modelPair || !spliceScalar(modelPair.value, next.model, out)) return false;
  const backendPair = node.items.find((it) => isScalar(it.key) && it.key.value === 'backend');
  if (backendPair) return spliceScalar(backendPair.value, next.backend, out);
  // No `backend:` line — the parser read it as Claude. Insert one just ahead
  // of `model:`, laid out the way that map already is.
  const key = modelPair.key as Scalar;
  if (!key.range) return false;
  const at = key.range[0];
  if (node.flow) {
    out.push({ start: at, end: at, text: `backend: ${next.backend}, ` });
  } else {
    const lineStart = source.lastIndexOf('\n', at - 1) + 1;
    const indent = source.slice(lineStart, at);
    if (!/^[ -]*$/.test(indent)) return false;
    // A key that opens a sequence item ("- model: x") indents its siblings
    // past the dash, not to it.
    out.push({ start: at, end: at, text: `backend: ${next.backend}\n${indent.replace(/-/g, ' ')}` });
  }
  return true;
}

export function adaptFlowYamlToMachine(yaml: string, ctx: TemplateResolveContext): AdaptResult {
  const doc = parseDocument(yaml);
  const unchanged: AdaptResult = { yaml, changes: [] };
  if (doc.errors.length > 0) return unchanged;
  const changes: InstallAdaptation[] = [];
  const splices: Splice[] = [];

  /// Rebind one reference if it has to be. False aborts the whole adaptation.
  const visit = (node: unknown, where: string): boolean => {
    const ref = readRef(node);
    if (!ref) return true;
    const next = replacementFor(ref, ctx);
    if (!next) return true;
    if (!spliceRef(node, next, yaml, splices)) return false;
    changes.push({ where, from: show(ref), to: show(next) });
    return true;
  };

  const participants = doc.get('participants', true);
  if (isSeq(participants)) {
    for (const item of participants.items) {
      if (!isMap(item)) continue;
      const name = item.get('name') ?? item.get('id') ?? 'participant';
      if (!visit(item, `participant ${String(name)}`)) return unchanged;
    }
  }

  const steps = doc.get('steps', true);
  if (isSeq(steps)) {
    for (const step of steps.items) {
      if (!isMap(step)) continue;
      const id = String(step.get('id') ?? 'step');
      // Legacy per-step model, from before participants existed.
      if (!visit(step.get('model', true), `step ${id}`)) return unchanged;
      // The rebound critic is a model reference of its own, checked by
      // preflight like any participant, and the resolver never looked at it.
      const rebound = step.get('rebound', true);
      if (isMap(rebound) && !visit(rebound.get('critic', true), `step ${id} critic`)) {
        return unchanged;
      }
    }
  }

  if (splices.length === 0) return unchanged;
  // Back to front, so each splice's offsets still point at original text.
  let out = yaml;
  for (const sp of [...splices].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, sp.start) + sp.text + out.slice(sp.end);
  }
  return { yaml: out, changes };
}
