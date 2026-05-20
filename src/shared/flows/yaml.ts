// Flow ↔ YAML round-trip. The builder edits a typed Flow object, but the
// canonical on-disk format is YAML so power users can hand-edit and so
// flows are diff-friendly in git. The right-pane preview in the editor
// renders the result of serializeFlow() so users see the YAML their edits
// produced.
//
// We do NOT try to preserve comments or stylistic quirks on round-trip in
// v1 — the editor warns when the source has comments before overwriting.
// If we need comment preservation later, switch to the yaml package's
// Document AST API.

import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

import type { Backend } from '../types';
import {
  DEFAULT_PARTICIPANT_ID,
  type Flow,
  type FlowFailureAction,
  type FlowParticipant,
  type FlowReboundConfig,
  type FlowStep,
} from './schema';

/// Shape we accept on disk. Everything is optional + permissive so a
/// hand-edited YAML with typos still gets parsed; validation comes after.
/// We intentionally use snake_case keys in YAML (idiomatic) and camelCase
/// in the in-memory type — this layer is where the translation happens.
interface YamlFlow {
  name?: unknown;
  description?: unknown;
  input?: unknown;
  participants?: unknown;
  steps?: unknown;
}

interface YamlStep {
  id?: unknown;
  participant?: unknown;
  model?: unknown;
  role?: unknown;
  system_prompt?: unknown;
  inputs?: unknown;
  tools?: unknown;
  permission_mode?: unknown;
  rebound?: unknown;
  on_fail?: unknown;
  pause_before?: unknown;
  output?: unknown;
}

interface YamlParticipant {
  id?: unknown;
  name?: unknown;
  backend?: unknown;
  model?: unknown;
  kind?: unknown;
}

interface YamlModel {
  backend?: unknown;
  model?: unknown;
}

interface YamlRebound {
  critic?: unknown;
  mode?: unknown;
  max_iters?: unknown;
  persona?: unknown;
}

interface YamlOnFail {
  action?: unknown;
  target?: unknown;
  max_retries?: unknown;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asBoolean(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function parseModel(raw: unknown): { backend: Backend; model: string } {
  if (raw && typeof raw === 'object') {
    const m = raw as YamlModel;
    return {
      backend: (asString(m.backend, 'claude') as Backend),
      model: asString(m.model),
    };
  }
  // Compact form: `model: "claude:claude-opus-4-7"` → split on first colon.
  if (typeof raw === 'string') {
    const idx = raw.indexOf(':');
    if (idx > 0) {
      return {
        backend: raw.slice(0, idx) as Backend,
        model: raw.slice(idx + 1),
      };
    }
  }
  return { backend: 'claude', model: '' };
}

function parseRebound(raw: unknown): FlowReboundConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as YamlRebound;
  const critic = parseModel(r.critic);
  if (!critic.model) return undefined;
  return {
    critic,
    mode: r.mode === 'collab' ? 'collab' : 'review',
    maxIters: asNumber(r.max_iters, 1),
    persona: typeof r.persona === 'string' ? (r.persona as FlowReboundConfig['persona']) : undefined,
  };
}

function parseOnFail(raw: unknown): FlowFailureAction | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as YamlOnFail;
  const action = asString(r.action);
  if (action === 'goto') {
    return {
      action: 'goto',
      target: asString(r.target),
      maxRetries: asNumber(r.max_retries, 1),
    };
  }
  if (action === 'abort') return { action: 'abort' };
  if (action === 'pause') return { action: 'pause' };
  return undefined;
}

function parseParticipant(raw: unknown, idx: number): FlowParticipant {
  const r = (raw && typeof raw === 'object' ? raw : {}) as YamlParticipant;
  const id = asString(r.id) || `participant_${idx + 1}`;
  return {
    id,
    name: asString(r.name) || id,
    backend: (asString(r.backend, 'claude') as Backend),
    model: asString(r.model),
    kind:
      r.kind === 'primary' || r.kind === 'worker' || r.kind === 'reviewer' || r.kind === 'custom'
        ? (r.kind as FlowParticipant['kind'])
        : undefined,
  };
}

function parseStep(raw: unknown, idx: number): FlowStep {
  const r = (raw && typeof raw === 'object' ? raw : {}) as YamlStep;
  const role = asString(r.role, 'custom') as FlowStep['role'];
  // Old format: per-step `model: { backend, model }`. New format: per-step
  // `participant: <id>`. Keep both around at parse time; the migration
  // pass below stitches the legacy `model` into a synthesized participant
  // and writes `participantId` so downstream code can ignore the difference.
  const legacyModel = r.model !== undefined ? parseModel(r.model) : undefined;
  const participantId = asString(r.participant);
  return {
    id: asString(r.id) || `step_${idx + 1}`,
    participantId, // may be empty here; finalized by migrateFlowParticipants
    model: legacyModel,
    role,
    systemPromptOverride:
      typeof r.system_prompt === 'string' && r.system_prompt.trim()
        ? r.system_prompt
        : undefined,
    inputs: asStringArray(r.inputs),
    tools: asStringArray(r.tools),
    permissionMode:
      typeof r.permission_mode === 'string'
        ? (r.permission_mode as FlowStep['permissionMode'])
        : undefined,
    rebound: parseRebound(r.rebound),
    onFail: parseOnFail(r.on_fail),
    pauseBefore: asBoolean(r.pause_before),
    output: asString(r.output),
  };
}

/// Back-compat migration. If the YAML had no `participants:` block, walk
/// the steps' legacy `model` fields and synthesize one participant per
/// unique backend+model. Each step's `participantId` is then pointed at
/// the synthesized participant. New-format flows (with explicit
/// participants) just pass through; missing/typo participantIds get
/// resolved against the participants list.
export function migrateFlowParticipants(
  participants: FlowParticipant[],
  steps: FlowStep[],
): { participants: FlowParticipant[]; steps: FlowStep[] } {
  const out = participants.slice();
  // Cheap dedup key for matching legacy `step.model` to an existing
  // participant.
  const keyOf = (p: { backend: string; model: string }) => `${p.backend}:${p.model}`;
  const byKey = new Map(out.map((p) => [keyOf(p), p]));
  const byId = new Map(out.map((p) => [p.id, p]));

  const migrated = steps.map((step) => {
    // Prefer explicit participantId when it resolves.
    if (step.participantId && byId.has(step.participantId)) return step;

    // Else, fall back to step.model (legacy format). Synthesize the
    // participant if we haven't seen this backend+model before.
    if (step.model && step.model.model) {
      const k = keyOf(step.model);
      let p = byKey.get(k);
      if (!p) {
        // First synthesized participant gets the canonical `primary` id
        // so old flow YAMLs round-trip to a recognizable shape.
        const id = out.length === 0 ? DEFAULT_PARTICIPANT_ID : `model_${out.length + 1}`;
        p = {
          id,
          name: friendlyModelLabel(step.model.backend, step.model.model),
          backend: step.model.backend,
          model: step.model.model,
          kind: out.length === 0 ? 'primary' : step.model.backend === 'ollama' ? 'worker' : undefined,
        };
        out.push(p);
        byKey.set(k, p);
        byId.set(p.id, p);
      }
      return { ...step, participantId: p.id };
    }

    // No model and no participant — degenerate; point at the first
    // participant (if any) so the flow stays loadable. Validation surfaces
    // the real problem.
    return { ...step, participantId: step.participantId || out[0]?.id || '' };
  });

  return { participants: out, steps: migrated };
}

function friendlyModelLabel(backend: string, model: string): string {
  // Mirror the WelcomePane / picker labels.
  if (backend === 'claude') {
    return model.startsWith('claude-') ? `Claude ${model.replace('claude-', '').replace(/-/g, ' ')}` : model;
  }
  if (backend === 'ollama') return `${model} (local)`;
  return `${backend}:${model}`;
}

/// Parse the on-disk YAML body. Returns a Flow with `source` + `filePath`
/// + `id` filled in by the caller (these come from the load context, not
/// the YAML body). Returns `null` if the YAML itself is unparseable; the
/// caller surfaces this as a load error.
export function parseFlowYaml(args: {
  yaml: string;
  id: string;
  source: 'user' | 'project';
  filePath: string;
}): Flow | null {
  let doc: unknown;
  try {
    doc = yamlParse(args.yaml);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const y = doc as YamlFlow;
  const stepsRaw = Array.isArray(y.steps) ? y.steps : [];
  const participantsRaw = Array.isArray(y.participants) ? y.participants : [];
  const parsedSteps = stepsRaw.map((s, i) => parseStep(s, i));
  const parsedParticipants = participantsRaw.map((p, i) => parseParticipant(p, i));
  const { participants, steps } = migrateFlowParticipants(parsedParticipants, parsedSteps);
  return {
    id: args.id,
    name: asString(y.name) || args.id,
    description: typeof y.description === 'string' ? y.description : undefined,
    input: 'user_prompt',
    participants,
    steps,
    source: args.source,
    filePath: args.filePath,
  };
}

function serializeModel(m: { backend: Backend; model: string }) {
  return { backend: m.backend, model: m.model };
}

function serializeRebound(r: FlowReboundConfig) {
  const out: Record<string, unknown> = {
    critic: serializeModel(r.critic),
    mode: r.mode,
    max_iters: r.maxIters,
  };
  if (r.persona) out.persona = r.persona;
  return out;
}

function serializeOnFail(f: FlowFailureAction) {
  if (f.action === 'goto') {
    return { action: 'goto', target: f.target, max_retries: f.maxRetries };
  }
  return { action: f.action };
}

function serializeStep(s: FlowStep): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: s.id,
    participant: s.participantId,
    role: s.role,
  };
  if (s.systemPromptOverride) out.system_prompt = s.systemPromptOverride;
  out.inputs = s.inputs;
  out.tools = s.tools;
  if (s.permissionMode) out.permission_mode = s.permissionMode;
  if (s.rebound) out.rebound = serializeRebound(s.rebound);
  if (s.onFail) out.on_fail = serializeOnFail(s.onFail);
  if (s.pauseBefore) out.pause_before = true;
  out.output = s.output;
  return out;
}

function serializeParticipant(p: FlowParticipant): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: p.id,
    name: p.name,
    backend: p.backend,
    model: p.model,
  };
  if (p.kind) out.kind = p.kind;
  return out;
}

/// Serialize a Flow back to YAML. The result is the canonical on-disk form
/// used by `storage.ts` writes and by the builder's preview pane.
export function serializeFlow(flow: Flow): string {
  const doc: Record<string, unknown> = {
    name: flow.name,
  };
  if (flow.description) doc.description = flow.description;
  doc.input = flow.input;
  // Guard against legacy in-memory Flow objects (or persisted snapshots)
  // that pre-date the participants field — emit nothing rather than crash.
  if (flow.participants && flow.participants.length > 0) {
    doc.participants = flow.participants.map(serializeParticipant);
  }
  doc.steps = flow.steps.map(serializeStep);
  return yamlStringify(doc, { lineWidth: 0, indent: 2 });
}

/// Detect whether the source YAML has comments — used by the editor to warn
/// the user that GUI edits will drop them on next save.
export function yamlHasComments(yaml: string): boolean {
  // Cheap heuristic: any `#` outside of strings. Misses some edge cases
  // (e.g. `#` inside a double-quoted string), but a false positive just
  // means we warn slightly too often, which is harmless.
  return /^\s*#/m.test(yaml) || /[^"'\\]#/m.test(yaml);
}
