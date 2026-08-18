// Worker ↔ YAML: the shareable form of a hire.
//
// A flow is already portable — it lives on disk as YAML, so handing one to
// another team is handing them a file. A worker was not: it lives as JSON in
// `<userData>/workers/<uuid>.json`, keyed by a machine-local id and tangled up
// with the things that make it *this* install's worker (its journal, its trust
// level, the project path it watches). So "use the same worker as that team"
// meant reading their settings screen and retyping it.
//
// This module is the line between the two halves of a worker: the JOB, which
// is what people want to share, and the EMPLOYMENT, which cannot be shared
// because it is a record of what happened here. The job travels; the
// employment is created fresh on arrival.
//
// What travels:
//   name, description, job description, cadence, caps, budget, heartbeat
//   model, auto-render choice, and the flows it is allowed to launch —
//   embedded whole, not merely named, because a worker whose flows are
//   missing can propose nothing and arrives broken.
//
// What deliberately does NOT travel:
//   - id / createdAt / order / shift history / journal — bookkeeping about
//     this install's copy, meaningless in another roster.
//   - trust. An imported worker always starts on probation. Trust is earned
//     against the person who will review its work, and a file that could
//     arrive pre-trusted would be a way to hand someone a worker that
//     launches runs unattended on day one.
//   - `run_in: cwd`, which is downgraded to a worktree on import for the same
//     reason: only an autonomous worker may touch the working copy, and an
//     import is never autonomous.
//   - projectPath. It is a path on the sender's disk. The importer picks
//     their own in the hire editor, which is also the confirmation step.

import { Scalar, parse as yamlParse, stringify as yamlStringify } from 'yaml';

import { flowFromDoc, flowToDoc } from './yaml';
import type { Flow } from './schema';
import type { ScheduleTrigger } from './schedule';
import type { Backend } from '../types';
import {
  WORKER_MAX_ITEMS_PER_SHIFT,
  WORKER_MIN_JOB_DESCRIPTION,
  coerceCadence,
  type Worker,
  type WorkerCaps,
} from './worker';

/// Bumped only if an older overcli would MISREAD a newer file. Additive keys
/// don't need it — the parser ignores what it doesn't know.
export const WORKER_YAML_VERSION = 1;

/// The `kind:` discriminator, so pointing the importer at a flow YAML fails
/// with "that's a flow" instead of producing a worker with no job.
export const WORKER_YAML_KIND = 'worker';

/// A worker stripped to the part that is about the job rather than about this
/// install. This is what a share file contains and what an import produces.
export interface PortableWorker {
  name: string;
  /// A line for whoever receives it — why this worker exists. Distinct from
  /// the job description, which is the operating instructions.
  description?: string;
  jobDescription: string;
  cadence: ScheduleTrigger;
  caps: WorkerCaps;
  budgetUSDPerMonth: number;
  heartbeatModel: string;
  heartbeatBackend?: Backend;
  flowIds: string[];
  autoRender?: string;
}

/// A worker plus the flows it needs. `flows` may be empty when the sender's
/// flows were unresolvable, in which case the import reports the ids it
/// couldn't supply rather than silently hiring a worker that can do nothing.
export interface WorkerBundle {
  worker: PortableWorker;
  flows: Flow[];
}

/// What an import did to the receiving flow library, in the words the
/// importer needs before hiring: what arrived, what was already here, and
/// what is still missing and will therefore never launch. Lives here rather
/// than beside the install code in main because the renderer renders it.
export interface WorkerImportNotes {
  installedFlowIds: string[];
  reusedFlowIds: string[];
  missingFlowIds: string[];
  failedFlowIds: Array<{ id: string; error: string }>;
}

// ---- Serialize ----------------------------------------------------------

/// Times are written quoted. Our own reader doesn't care, but `9:00` is a
/// sexagesimal integer under YAML 1.1 — 540 — and this file is meant to be
/// read by other people's tooling as well as by us.
function timeScalar(time: string): Scalar {
  const s = new Scalar(time);
  s.type = Scalar.QUOTE_SINGLE;
  return s;
}

function serializeCadence(c: ScheduleTrigger): Record<string, unknown> {
  if (c.kind === 'interval') {
    const out: Record<string, unknown> = { kind: 'interval', every_minutes: c.everyMinutes };
    if (c.days && c.days.length > 0) out.days = c.days;
    if (c.window) {
      out.window = { start: timeScalar(c.window.start), end: timeScalar(c.window.end) };
    }
    return out;
  }
  const out: Record<string, unknown> = { kind: 'daily', time: timeScalar(c.time) };
  if (c.days && c.days.length > 0) out.days = c.days;
  return out;
}

/// The share file for a worker. `flows` are the resolved library flows behind
/// `worker.flowIds`; ids with no flow are still listed under `flows:` so the
/// receiving side can say which ones went missing rather than pretending the
/// worker never referenced them.
export function serializeWorker(args: {
  worker: Pick<
    Worker,
    | 'name'
    | 'jobDescription'
    | 'cadence'
    | 'caps'
    | 'budgetUSDPerMonth'
    | 'heartbeatModel'
    | 'heartbeatBackend'
    | 'flowIds'
  > & { autoRender?: string };
  flows: Flow[];
  description?: string;
}): string {
  const { worker } = args;
  const doc: Record<string, unknown> = {
    kind: WORKER_YAML_KIND,
    version: WORKER_YAML_VERSION,
    name: worker.name,
  };
  if (args.description?.trim()) doc.description = args.description.trim();
  doc.job_description = worker.jobDescription;
  doc.cadence = serializeCadence(worker.cadence);
  doc.caps = {
    max_items_per_shift: worker.caps.maxItemsPerShift,
    // Always written as `worktree`: `cwd` is a permission this install granted
    // an autonomous worker, not a property of the job. Writing it out would
    // only be a request the importer's own rules refuse anyway.
    run_in: 'worktree',
  };
  doc.budget_usd_per_month = worker.budgetUSDPerMonth;
  doc.heartbeat_model = worker.heartbeatModel;
  // Only written when known. An export without it stays importable by an
  // older build, and the importer falls back to the same tier translation a
  // pre-field worker gets.
  if (worker.heartbeatBackend) doc.heartbeat_backend = worker.heartbeatBackend;
  if (worker.autoRender) doc.auto_render = worker.autoRender;
  doc.flows = [...worker.flowIds];

  const byId = new Map(args.flows.map((f) => [f.id, f]));
  const embedded = worker.flowIds
    .map((id) => byId.get(id))
    .filter((f): f is Flow => Boolean(f))
    .map((f) => ({ id: f.id, ...flowToDoc(f) }));
  if (embedded.length > 0) doc.flow_definitions = embedded;

  return yamlStringify(doc, { lineWidth: 0, indent: 2 });
}

/// A filename that reads as the worker in a folder of them, and survives being
/// mailed around: lowercase, no spaces, no path separators.
export function workerShareFilename(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'worker';
  return `${slug}.worker.yaml`;
}

// ---- Parse --------------------------------------------------------------

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/// Accept only a real backend name from an imported file. Anything else is
/// dropped rather than guessed at — a bogus backend would pin the worker to a
/// CLI that doesn't exist, where the tier-translation fallback is the safer
/// outcome.
const BACKEND_NAMES: Backend[] = ['claude', 'codex', 'gemini', 'ollama', 'copilot'];
function coerceBackend(raw: unknown): Backend | undefined {
  const name = asString(raw).trim().toLowerCase();
  return BACKEND_NAMES.find((b) => b === name);
}

function coerceCaps(raw: unknown): WorkerCaps {
  const c = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const items = Number(c.max_items_per_shift ?? c.maxItemsPerShift);
  return {
    maxItemsPerShift: Number.isFinite(items)
      ? Math.max(1, Math.min(WORKER_MAX_ITEMS_PER_SHIFT, Math.floor(items)))
      : 3,
    // Never honoured from a file — see the header. An import lands on
    // probation, and probation may not run in the working copy.
    runIn: 'worktree',
  };
}

/// The cadence keys are snake_case on disk and camelCase in memory; hand the
/// translated object to the same coercion the hire drafter's output goes
/// through, so a hand-written cadence can't be stricter or looser than one the
/// model produced.
function coerceSharedCadence(raw: unknown): ScheduleTrigger {
  if (!raw || typeof raw !== 'object') return coerceCadence(undefined);
  const c = raw as Record<string, unknown>;
  return coerceCadence({
    ...c,
    everyMinutes: c.every_minutes ?? c.everyMinutes,
  });
}

export type WorkerYamlResult =
  | { ok: true; bundle: WorkerBundle; missingFlowIds: string[] }
  | { ok: false; error: string };

/// Read a share file. Tolerant in the same spirit as `parseFlowYaml` — an
/// unknown key is ignored rather than fatal — but strict about the two things
/// that decide whether the result is usable at all: it must say it is a
/// worker, and it must carry a job description long enough for a worker to
/// plan a shift from.
export function parseWorkerYaml(yaml: string): WorkerYamlResult {
  let doc: unknown;
  try {
    doc = yamlParse(yaml);
  } catch (err) {
    return { ok: false, error: `That file isn't valid YAML: ${String(err)}` };
  }
  if (!doc || typeof doc !== 'object') {
    return { ok: false, error: 'That file is empty, or is not a YAML document.' };
  }
  const y = doc as Record<string, unknown>;
  if (asString(y.kind) !== WORKER_YAML_KIND) {
    // The likeliest wrong file is a flow, and saying so is more use than
    // "missing kind: worker".
    const looksLikeFlow = Array.isArray(y.steps);
    return {
      ok: false,
      error: looksLikeFlow
        ? "That's a flow, not a worker. Install it from the flow library instead."
        : 'That file does not declare `kind: worker`.',
    };
  }

  // A file from a future format could mean something different by the keys
  // this parser recognizes, and silently hiring a misread worker is worse
  // than refusing one. Unversioned files are fine — v1 predates the field
  // being worth writing.
  const version = Number(y.version ?? WORKER_YAML_VERSION);
  if (Number.isFinite(version) && version > WORKER_YAML_VERSION) {
    return {
      ok: false,
      error: `That file is in worker format v${version}; this version of overcli reads v${WORKER_YAML_VERSION}. Update overcli to import it.`,
    };
  }

  const name = asString(y.name).trim();
  const jobDescription = asString(y.job_description ?? y.jobDescription).trim();
  if (!name) return { ok: false, error: 'The worker in that file has no name.' };
  if (jobDescription.length < WORKER_MIN_JOB_DESCRIPTION) {
    return {
      ok: false,
      error: `The worker in that file has no usable job description (needs at least ${WORKER_MIN_JOB_DESCRIPTION} characters).`,
    };
  }

  const flowIds = Array.isArray(y.flows)
    ? y.flows.filter((f): f is string => typeof f === 'string' && f.trim() !== '')
    : [];

  const defs = Array.isArray(y.flow_definitions) ? y.flow_definitions : [];
  const flows: Flow[] = [];
  for (const def of defs) {
    if (!def || typeof def !== 'object') continue;
    const id = asString((def as Record<string, unknown>).id).trim();
    if (!id) continue;
    // `source: 'user'` and an empty path: where it actually lands is the
    // importer's decision, made when it is written to disk.
    const flow = flowFromDoc(def, { id, source: 'user', filePath: '' });
    if (flow) flows.push(flow);
  }

  const budget = Number(y.budget_usd_per_month ?? y.budgetUSDPerMonth);
  const worker: PortableWorker = {
    name,
    description: asString(y.description).trim() || undefined,
    jobDescription,
    cadence: coerceSharedCadence(y.cadence),
    caps: coerceCaps(y.caps),
    budgetUSDPerMonth: Number.isFinite(budget) && budget > 0 ? budget : 10,
    heartbeatModel: asString(y.heartbeat_model ?? y.heartbeatModel).trim(),
    // Only accept a real backend name. A file that omits it (or carries junk)
    // leaves the worker on the pre-field path: the importer's default backend
    // with the model translated to its matching tier.
    heartbeatBackend: coerceBackend(y.heartbeat_backend ?? y.heartbeatBackend),
    // A flow with no id in `flows:` still counts as one this worker carries —
    // an author who embedded a definition and forgot the list meant to ship it.
    flowIds: flowIds.length > 0 ? flowIds : flows.map((f) => f.id),
    autoRender: asString(y.auto_render ?? y.autoRender).trim() || undefined,
  };

  const supplied = new Set(flows.map((f) => f.id));
  return {
    ok: true,
    bundle: { worker, flows },
    missingFlowIds: worker.flowIds.filter((id) => !supplied.has(id)),
  };
}
