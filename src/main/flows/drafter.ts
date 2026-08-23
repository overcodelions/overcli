// AI-assisted flow drafting and revision. The user types a description of
// what they want (e.g. "fix a Jira ticket then open a PR"), and we ask their
// PREFERRED CLI — with the Flow YAML schema in its system prompt — to
// generate a draft. The result lands in the editor; the user refines from
// there.
//
// `reviseFlowFromPrompt` is the same call pointed at a flow that already
// exists: the builder hands over the draft's current YAML plus an instruction
// ("add a security review before the PR step"), and the CLI returns the whole
// flow again with that one change applied. Same schema, same repairs, same
// validation — so an AI edit can't put the editor into a state a hand edit
// couldn't.
//
// Backend selection mirrors the rest of the app: the user's preferred
// backend when it's healthy, otherwise the first healthy premium backend
// (see pickDrafterBackend). Every CLI runs as a hidden one-shot through the
// RunnerManager, which already speaks all the backends — including Claude on
// its default 'cli' transport (the user's installed `claude`). Claude only
// takes the in-process @anthropic-ai/claude-agent-sdk path when the
// experimental "Use Claude Agent SDK" transport is enabled (Settings →
// Advanced). Auth uses whatever credentials that CLI relies on.

import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { claudeSdkExecutablePath } from '../claudeSdkExecutable';

import type { AppSettings, Attachment, Backend } from '../../shared/types';
import type { Flow, FlowModelRef } from '../../shared/flows/schema';
import { normalizeFlowTag } from '../../shared/flows/schema';
import {
  canonicalizePremiumModel,
  liftMissingModel,
  snapToTierDefault,
  type FlowModelDefaults,
} from '../../shared/modelCatalog';
import { parseFlowYaml } from '../../shared/flows/yaml';
import { TAG_AXES } from '../../shared/flows/tagTaxonomy';
import {
  validateFlow,
  ARTIFACT_NAME_RE,
  sanitizeArtifactName,
} from '../../shared/flows/validation';
import { FLOW_TEMPLATES } from '../../shared/flows/templates';
import {
  pickDrafterBackend,
  drafterModelFor,
  drafterModelHints,
} from '../../shared/flows/drafterBackend';
import { healthyBackends } from '../health';
import { flowHasCodeWritingStep, isGatingReviewerRole } from './runtime';
import type { OneShotResult, RunnerManager } from '../runner';

export interface DraftDeps {
  settings: AppSettings;
  runner: RunnerManager;
  /// Rendered "PROVEN FLOWS" block from `renderProvenFlowsSection`. Empty
  /// string or absent when the user has no flow with a track record yet.
  provenFlows?: string;
}

/// Which job the CLI is being asked to do. Both share the schema prompt and
/// the whole parse/repair/validate pipeline; only the framing differs.
type DraftMode = 'draft' | 'revise';

/// Human-facing CLI name for error/status copy. Kept local so the drafter
/// (main process) doesn't reach into renderer-only helpers.
function backendLabel(backend: Backend): string {
  switch (backend) {
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'copilot':
      return 'Copilot';
    case 'ollama':
      return 'Ollama';
    case 'claude':
    default:
      return 'Claude';
  }
}

/// System prompt fed to the drafting CLI. Carries the schema as YAML (more
/// compact than TypeScript types in tokens) plus one fully-worked example so
/// the model sees the exact shape we expect back. The CONVENTIONS section and
/// the closing note steer the generated flow's steps toward `backend` (the
/// CLI the user prefers) instead of always defaulting to Claude.
///
/// `mode` swaps only the framing: 'draft' writes a flow from a description,
/// 'revise' rewrites an existing one the user hands us. Everything between —
/// schema, roles, conventions, example — is identical, because a revision has
/// to obey exactly the same contract the original draft did.
function systemPrompt(
  backend: Backend,
  mode: DraftMode = 'draft',
  modelDefaults?: FlowModelDefaults,
  provenFlows?: string,
): string {
  const hints = drafterModelHints(backend, modelDefaults);
  const label = backendLabel(backend);
  return [
    ...(mode === 'revise'
      ? [
          'You are a flow editor for overcli. A "flow" is a sequence of LLM steps that run',
          'autonomously, each step backed by its own model + tools, with artifact handoff. The user',
          'will give you an EXISTING flow as YAML plus a change they want made to it; you respond',
          'with ONLY the complete revised YAML body conforming to the schema below — no prose, no',
          'code fences, no commentary. Start your response on the first line with `name:`.',
        ]
      : [
          'You are a flow designer for overcli. A "flow" is a sequence of LLM steps that run autonomously,',
          'each step backed by its own model + tools, with artifact handoff. The user will describe what',
          'they want; you respond with ONLY a YAML body that conforms to the schema below — no prose, no',
          'code fences, no commentary. Start your response on the first line with `name:`.',
        ]),
    '',
    'SCHEMA',
    '======',
    'Top-level keys:',
    '  name        — required, short human title',
    '  description — optional, 1–3 line summary',
    '  input       — always the literal string `user_prompt`',
    '  tags        — optional list of 2–4 lowercase labels, used to group and filter the',
    '                library. Pick ONLY from the vocabulary below, and only ones that',
    '                genuinely apply — omit the key entirely rather than reaching. Drawing',
    '                from a fixed list is what lets a hand-drafted flow sit alongside a',
    '                published one under the same filter.',
    ...TAG_AXES.map((axis) => `                ${axis.axis}: ${axis.tags.join(', ')}`),
    '  steps       — list of step objects',
    '',
    'Each step has:',
    '  id            — kebab-case identifier referenced by other steps',
    '  model         — { backend: claude|codex|gemini|copilot|ollama, model: "<id>" }',
    '  role          — one of the presets listed under ROLES below, or `custom` when no',
    '                  preset fits (see ROLE FIT CHECK). `custom` REQUIRES system_prompt.',
    '  system_prompt — required when role is `custom`, omit otherwise. The full system',
    '                  prompt for the step, written by you.',
    '  inputs        — list of refs. May include "user_prompt" and outputs of EARLIER steps',
    '  tools         — list of tool ids. For claude/codex/gemini/copilot: Read, Write, Edit, Grep,',
    '                  Glob, Bash, WebFetch, Task. For ollama: read_file, list_dir, grep.',
    '  output        — artifact name this step produces. A SINGLE token of letters, digits, dot,',
    '                  dash, or underscore only — NO spaces or slashes. Use snake_case or a file',
    '                  extension (e.g. plan.md, diff, review.md, pr_url, audit_report).',
    '  permission_mode — optional. acceptEdits | bypassPermissions | default | plan | auto',
    '  effect        — REQUIRED. local for reads, local code/file edits, tests, builds, and',
    '                  shell commands confined to the run cwd; external for pushes, PRs,',
    '                  deploys, publishing, messages, email, tickets, calendars, or any',
    '                  write to a service or destination outside the run cwd.',
    '  verdict_gate  — optional bool. Set true only when this step itself returns the',
    '                  APPROVED/rejected verdict that gates later steps. Never infer this',
    '                  merely because an action prompt refers to an earlier approval.',
    '                  Set it FALSE to switch OFF the automatic gate a reviewer role',
    '                  carries — see ASSESSOR vs GATE below.',
    '  pause_before  — optional bool. When true, the run pauses BEFORE this step so the user can',
    '                  review prior artifacts. NEVER set on the first step.',
    '  turbo         — optional bool. Runs this step at low reasoning effort with no MCP',
    '                  servers. Faster and cheaper, but genuinely shallower thinking.',
    '  rebound       — optional. { critic: {backend, model}, mode: review|collab, max_iters: N }',
    '  on_fail       — optional. { action: pause|goto|abort, target?: <stepId>, max_retries?: N }',
    '',
    'ROLES',
    '=====',
    'Each role is a preset with a fixed job. Pick by what the step ACTUALLY does.',
    'The single most important distinction is READ-ONLY vs WRITES-CODE — get it',
    'wrong and the flow either mangles the repo or refuses to approve.',
    '',
    'READ-ONLY roles (never edit files — safe for investigate / analyze / plan flows):',
    '  - researcher        — gathers and reports FACTS about the request/codebase.',
    '                        Makes no decisions, proposes no solution.',
    '  - code-reader       — surveys how existing code works today. No decisions, no changes.',
    '  - planner           — turns research into a concrete step-by-step plan. Writes the',
    '                        PLAN, not code.',
    '  - plan-reviewer     — judges whether a PLAN is sound BEFORE any code exists. Use this',
    '                        to validate a plan. Gates the flow (must emit "APPROVED").',
    '  - reviewer          — reviews the CODE DIFF an implementer produced against the plan.',
    '                        Requires a prior code-writing step. Gates.',
    '  - code-reviewer     — reviews an existing code change/PR for correctness. Requires',
    '                        prior code changes. Gates.',
    '  - security-reviewer — reviews an existing diff for security issues. Requires prior',
    '                        code changes. Gates.',
    '  - adversarial-reviewer — tries to BREAK an existing diff. Requires prior code changes. Gates.',
    '  - debugger          — traces a symptom to its ROOT CAUSE and recommends a fix. Does',
    '                        not edit code.',
    '  - technical-writer  — turns inputs (briefs, plans, findings) into clear prose/docs for',
    '                        humans. Use this to PRESENT or deliver a written result.',
    '  - editor            — polishes an existing draft for clarity and accuracy.',
    '',
    'WRITES-CODE / SHIPS roles (only use when the user wants code changed or shipped):',
    '  - implementer       — executes a plan by making the actual file edits.',
    '  - test-writer       — adds tests covering already-implemented changes.',
    '  - shipper           — stages, commits, pushes the branch, and opens a PR via `gh`.',
    '',
    'ROLE-SELECTION RULES (follow these — name-matching a role is the #1 mistake):',
    '  - If the user wants to INVESTIGATE / ANALYZE / RESEARCH / PROPOSE a plan and does',
    '    NOT ask for code to be written, use ONLY read-only roles. NEVER include',
    '    implementer, test-writer, or shipper in such a flow.',
    '  - To VALIDATE A PLAN (no code written yet), use `plan-reviewer`, NOT `reviewer`.',
    '    `reviewer`/`code-reviewer`/`security-reviewer`/`adversarial-reviewer` all require a',
    '    real code diff to look at and will fail to approve when there is none.',
    '  - To PRESENT / DELIVER a written result (a plan, report, or findings) use',
    '    `technical-writer`, NOT `shipper`. `shipper` commits and pushes code — only use it',
    '    when the flow is meant to land and ship changes.',
    '  - Only reach for `reviewer`/`code-reviewer`/etc. AFTER an `implementer` step in the',
    '    same flow has produced a diff.',
    '  - ONE DELIVERABLE = ONE WRITING STEP. When the flow produces more than one document,',
    '    and especially when they are for DIFFERENT audiences, give each its own writing step',
    '    with its own brief, and state in each brief what the OTHER document owns so the two',
    '    cannot converge. Do NOT write one step that produces all the content and a second',
    '    that splits or formats it into several documents — that yields the same document',
    '    twice with different headings, which is the exact thing a user asking for two',
    '    audiences is trying to avoid.',
    '',
    'ASSESSOR vs GATE (a reviewer role blocks the flow unless you say otherwise)',
    '=========================================================================',
    'The five reviewer roles above GATE: when the step does not clearly approve, the',
    'runtime treats it as FAILED and applies `on_fail` (pause by default) instead of',
    'running the rest of the flow. That is right when a later step would otherwise act',
    'on disapproved work — ship it, merge it, deploy it.',
    '',
    'It is WRONG when the review IS the deliverable. In an audit, assessment, or',
    'readiness flow, a lens that finds problems is doing its job, and its findings are',
    'the raw material for the report. Gating there means the flow deadlocks precisely',
    'on the shifts that had something to say, and the report — the entire point of the',
    'run — never gets written.',
    '',
    'So, for every reviewer-role step, ask: does anything downstream ACT on this',
    'verdict, or does something downstream merely READ these findings?',
    '  - ACTS on it (implementer fixes it / shipper ships it / a later step depends on',
    '    the work being sound) → leave it gating.',
    '  - READS it (a synthesis, refutation, scoring, or report step consumes the',
    '    artifact) → set `verdict_gate: false`. The findings then flow downstream and',
    '    the report gets written whatever the verdict says.',
    '',
    'Rule of thumb: a flow with NO implementer / test-writer / shipper step has nothing',
    'to gate — nothing in it can act on the verdict. Every reviewer role in such a flow',
    'is an assessor and MUST set `verdict_gate: false`. (`plan-reviewer` is the one',
    'exception: validating a plan before work begins is a real gate even with no code.)',
    '',
    'Keep sibling lenses consistent. If a flow reviews one change through several',
    'parallel lenses that all feed one report, they either all gate or none do —',
    'usually none. A single lens left gating while its siblings do not is a flow that',
    'halts at that one lens for no reason the user can see.',
    '',
    'ROLE FIT CHECK (do this for EVERY step before you emit it)',
    '==========================================================',
    'The presets cover the common software-engineering jobs, but they are not exhaustive.',
    'Do not force a step into the nearest-sounding preset — a preset carries a full system',
    'prompt written for ITS job, and a mismatched one will steer the step wrong in ways the',
    'role name does not reveal.',
    '',
    'For each step, ask: "does a preset describe what this step ACTUALLY does — its real job,',
    'not just a similar-sounding one?"',
    '  - YES  → use that preset. Do NOT set system_prompt. This is the common case; prefer a',
    '           preset whenever one genuinely fits, since preset prompts are battle-tested.',
    '  - NO   → use `role: custom` and write a `system_prompt` yourself.',
    '',
    'Reach for `custom` when the step\'s job is real but outside the preset set, e.g.:',
    '  - a domain task the presets never model (triage tickets, summarize logs, draft a',
    '    changelog from commits, extract structured data, translate, classify)',
    '  - a specific analysis the user described that no preset performs',
    '  - a step whose job is close to a preset but whose CONSTRAINTS materially differ',
    '    (e.g. "review, but ONLY for accessibility" — `reviewer` reviews everything)',
    'Do NOT reach for `custom` merely to reword a preset, to be thorough, or because you are',
    'unsure. An ill-fitting preset is a bug; an unnecessary custom prompt is a regression.',
    '',
    'A custom system_prompt MUST be self-contained — it is the step\'s ENTIRE instruction set,',
    'and it inherits nothing from any preset. Write it as a complete prompt that states:',
    '  - who the step is and that it is one step of an automated multi-step flow',
    '  - its exact job, and what it must NOT do',
    '  - whether it may edit files (say so explicitly — read-only steps must be told to use',
    '    read-only tools and not edit code; this must agree with the `tools` you grant)',
    '  - the shape of the deliverable it must produce',
    'Do NOT mention the <output> wrapper or artifact names — that contract is appended',
    'automatically. Use YAML block scalars (`system_prompt: |`) for multi-line prompts.',
    'Every step ends by emitting its deliverable, including read-only ones. Write the',
    '"must NOT do" constraints so they restrict what the step CHANGES or DECIDES — never',
    'phrase them as "produce nothing", "output nothing", "do not write anything" or',
    '"just investigate", which read as permission to end the turn with no deliverable and',
    'strand the flow.',
    '',
    'EXAMPLE — a step no preset covers:',
    '  - id: triage',
    '    model: { backend: claude, model: claude-sonnet-5 }',
    '    role: custom',
    '    system_prompt: |',
    '      You are the TRIAGE step of a multi-stage automated flow.',
    '',
    '      Your job: read the incoming bug reports and group them by root-cause area,',
    '      then rank each group by user impact. Judge severity from evidence in the',
    '      reports themselves — do not speculate about causes you cannot support.',
    '',
    '      You are READ-ONLY. Use read-only tools to check the repo. Never edit code,',
    '      and do not propose fixes — a later step owns that.',
    '',
    '      Produce markdown: one section per group, ordered most-impactful first, each',
    '      with a one-line cause, the reports it covers, and a severity rating.',
    '    inputs: [user_prompt]',
    '    tools: [Read, Grep]',
    '    output: triage.md',
    '',
    'CONVENTIONS',
    '===========',
    `This user prefers the "${backend}" backend (${label}). Use it for EVERY step unless the user`,
    'explicitly asks for a different one. Pick the model per step by role:',
    `  - planning + review: { backend: ${backend}, model: ${hints.thinking} }`,
    `  - rebound critic / cheaper steps: { backend: ${backend}, model: ${hints.standard} }`,
    `  - implementers + test-writers: { backend: ${backend}, model: ${hints.fast} }`,
    `Do NOT put every step on ${hints.thinking}. It is the most expensive model available and`,
    'the user pays per step. Reserve it for steps that genuinely need deep reasoning — the',
    'plan, and the review that judges the plan. Extraction, summarising, formatting, drafting',
    `from an existing artifact, and mechanical checks all belong on ${hints.fast}. A flow whose`,
    'every step is the top model is a bug, not a thorough flow.',
    'Set turbo: true on steps whose work is mechanical rather than judgemental — reformatting,',
    'extracting fields from an artifact an earlier step already produced, renaming, applying a',
    'diff that was already reviewed, or generating boilerplate from a settled spec. NEVER set it',
    'on a step that plans, reviews, gates a verdict, debugs, or decides anything: turbo lowers',
    'reasoning depth, so using it there buys speed by degrading the exact thing the step exists',
    'to do. When in doubt leave it off — a slow correct step beats a fast wrong one.',
    'Always include at least one step that consumes "user_prompt".',
    'Default to permission_mode: bypassPermissions on local write steps so they can edit code and',
    'run tests unattended. Mark every push, PR, deploy, message, ticket/service update, or other',
    'outside-world mutation as effect: external. Worker runs automatically stop for approval at',
    'that boundary; pause_before remains available for additional human review checkpoints.',
    '',
    'DEPTH BUDGET (a deep flow is a slow flow, not a thorough one)',
    '=============================================================',
    'Every step is a COLD model turn: it re-reads its inputs from scratch and knows',
    'nothing of the reasoning that produced them. An extra step therefore costs a full',
    'turn of latency and money and LOSES context — it does not add rigour.',
    'Target 3–5 steps. Do not exceed 7 unless the user themselves enumerated more',
    'phases than that. A 9-step flow for a request the user described in one sentence',
    'is a bug.',
    'Before you emit, delete any step where you cannot name what the FINAL deliverable',
    'would lose without it. In particular:',
    '  - Merge research into the step that uses it. A separate researcher step earns its',
    '    place only when the facts span systems one step cannot reach in one turn.',
    '  - ONE review step, not a panel. Add sibling review lenses only when the user asked',
    '    for that specific kind of scrutiny (e.g. "security review too").',
    '  - No formatting, polishing, or summarising step after a writing step — fold the',
    '    format requirements into the writing step\'s own brief.',
    '  - No step whose only job is to hand an artifact to the next step.',
    'This budget never overrides ONE DELIVERABLE = ONE WRITING STEP above: two documents',
    'for two audiences are two steps, and that is the shape, not padding.',
    '',
    'SPEED',
    '=====',
    `Put a step on ${hints.thinking} only if it plans or judges. Everything else — drafting`,
    `from an artifact, extracting, summarising, formatting, mechanical checks — goes on`,
    `${hints.fast}, with turbo: true when the work is mechanical rather than judgemental.`,
    'The user is waiting on this flow every time it runs; the fastest flow that still',
    'delivers the whole deliverable is the correct flow.',
    '',
    'DELIVERABLE STEPS',
    '=================',
    'A step whose output a HUMAN reads is judged on how it reads, not only on whether it ran.',
    'When the user describes a report, brief, digest, deck, or any rendered artifact:',
    '  - Name the AUDIENCE in the step prompt, and what they will DO with the document.',
    '    "For the delivery team, to see what they shipped and whether they are speeding up"',
    '    steers a step; "write a status report" does not.',
    '  - Carry the user\'s own words about tone, emphasis, and what the document must show',
    '    into the step prompt. Those are requirements, not flavour — drop them and the step',
    '    reverts to a neutral recap.',
    '  - When the artifact is RENDERED (HTML, a document, slides), the step prompt must carry',
    '    a concrete design spec: the section order, what leads and what trails, the components',
    '    (cards, stat tiles, status badges), a type scale, and a small named palette. "Make it',
    '    look good" produces default-stylesheet tables. When two steps render sibling',
    '    documents, give them the SAME spec so the pair reads as one system.',
    '  - When the user asks for TRENDS, CHARTS, or anything visual over time, an EARLIER step',
    '    must gather the numbers and emit them in a machine-readable block (e.g. a fenced json',
    '    series). That block belongs INSIDE that step\'s deliverable as its final section —',
    '    never after it — or the step emits no artifact at all. Say in the rendering step',
    '    that it draws ONLY from that block, and that a',
    '    missing value stays missing — rendered as "no data", never smoothed, interpolated, or',
    '    turned into a zero.',
    '  - SAY WHERE THE FILE GOES. A step that writes a file writes it to its working root,',
    '    which for a workspace run is a synthetic directory of symlinks that is DELETED with',
    '    the run — not the place a human browses. Tell the step to write there first (that is',
    '    what gets collected), and then to COPY the file to the destination the run names,',
    '    never to guess a path outside it. "Write the report" without a destination produces a',
    '    deliverable nobody can find.',
    '  - Restate the artifact\'s hard constraints in the step that writes it: self-contained or',
    '    not, which assets are forbidden and which are permitted (inline SVG usually is), print',
    '    and email safety, accessibility. The step cannot infer any of this.',
    '  - A verification step over a rendered deliverable checks FACTS. Tell it explicitly not',
    '    to flag tone or word choice, or it will sand a deliberately vivid document back to',
    '    neutral prose and undo the brief.',
    '  - Tell every gathering step to ALWAYS emit its deliverable, even when the run\'s prompt',
    '    turns out not to match its job — stating inside the artifact what it could and could',
    '    not gather, and why. A step that narrates a mismatch instead of emitting anything',
    '    produces no artifact, which fails the step and stalls the run. A short honest',
    '    artifact is always the better outcome.',
    '',
    'EXAMPLE',
    '=======',
    FLOW_TEMPLATES[0].yaml,
    '',
    `NOTE: the example above happens to use claude + ollama, but THIS user prefers ${label} —`,
    `use ${backend} models (as listed under CONVENTIONS) for the steps you generate, not claude.`,
    '',
    ...(mode !== 'revise' && provenFlows ? [provenFlows, ''] : []),
    ...(mode === 'revise'
      ? [
          'REVISION RULES',
          '==============',
          'You are editing a flow that already exists and that the user is happy with apart from the',
          'change they asked for. Treat the current YAML as the source of truth:',
          '  - Make the requested change and NOTHING else. Preserve every step id, model, role,',
          '    system_prompt, tool list, artifact name, and option the change does not touch —',
          '    byte-for-byte where you can.',
          '  - Do NOT re-tag, re-title, re-word descriptions, re-order steps, or "improve" prompts',
          '    that the user did not ask you to touch. An unrequested edit is a bug, not a bonus.',
          '  - Keep artifact wiring intact. If you rename a step\'s `output`, or add/remove/reorder',
          '    steps, fix every `inputs` ref so each step still consumes an artifact an EARLIER step',
          '    produces.',
          '  - If the request is ambiguous, choose the smallest edit that satisfies it.',
          '  - EXCEPTION — STRUCTURAL REQUESTS. When the change is about the SHAPE of what the',
          '    flow produces — a deliverable that should be split in two, a document written for',
          '    the wrong audience, an output that needs data no current step gathers — and the',
          '    existing steps cannot express it, then RESTRUCTURE: split a step, add one, or',
          '    re-wire the artifacts. Rewording a prompt inside a structure that cannot produce',
          '    the requested result is not the smallest edit, it is a no-op the user will have to',
          '    report again. Make the structural change and keep everything it does not touch',
          '    byte-for-byte.',
          '  - If the request cannot be expressed in the schema, return the flow UNCHANGED rather',
          '    than inventing keys.',
          '  - Keep the existing backend/model choices unless the user asked to change them, even if',
          '    they differ from the CONVENTIONS above. Apply CONVENTIONS only to steps you ADD.',
          '',
          'Now apply the requested change and reply with the complete revised YAML only.',
        ]
      : ['Now produce a YAML for the user\'s described flow. Reply with YAML only.']),
  ].join('\n');
}

/// Draft a flow from the user's description using their preferred CLI.
/// Returns the parsed Flow (validated) or a surfaced error the renderer can
/// show. Times out at 120s.
export async function draftFlowFromPrompt(
  args: { description: string; attachments?: Attachment[] },
  deps: DraftDeps,
): Promise<{ ok: true; flow: Flow } | { ok: false; error: string }> {
  const desc = args.description.trim();
  if (!desc) return { ok: false, error: 'Description is empty.' };

  const out = await runDrafter(deps, 'draft', `USER REQUEST:\n${desc}`, args.attachments);
  if (!out.ok) return out;
  return finalizeDraft(out.text, out.label, {
    snapModels: deps.settings.flowModelDefaults ?? {},
  });
}

/// Revise a flow the user already has open in the builder. Same CLI, same
/// schema prompt, same repair-and-validate pipeline as drafting — the only
/// difference is that the current YAML goes in alongside the instruction and
/// the model is told to change one thing and leave the rest alone.
///
/// `id` is the draft's existing id, carried through because the YAML body
/// doesn't hold it (the id is the filename on disk). Without it a revision
/// that touches `name` would re-slugify into a new id and the next save would
/// fork a second file instead of updating the flow the user is editing.
export async function reviseFlowFromPrompt(
  args: { yaml: string; instruction: string; id?: string; attachments?: Attachment[] },
  deps: DraftDeps,
): Promise<{ ok: true; flow: Flow } | { ok: false; error: string }> {
  const instruction = args.instruction.trim();
  const current = args.yaml.trim();
  if (!instruction) return { ok: false, error: 'Describe the change you want first.' };
  if (!current) return { ok: false, error: 'There is no flow to edit.' };

  const message = [
    'CURRENT FLOW (YAML)',
    '===================',
    current,
    '',
    'REQUESTED CHANGE',
    '================',
    instruction,
  ].join('\n');

  const out = await runDrafter(deps, 'revise', message, args.attachments);
  if (!out.ok) return out;
  return finalizeDraft(out.text, out.label, { id: args.id });
}

/// Resolve the drafting CLI, run it, and hand back its raw text plus the
/// label to name it by in errors. Shared by drafting and revising so the two
/// can never drift on backend selection or transport.
async function runDrafter(
  deps: DraftDeps,
  mode: DraftMode,
  userMessage: string,
  attachments?: Attachment[],
): Promise<{ ok: true; text: string; label: string } | { ok: false; error: string }> {
  return oneShotDraftText(deps, {
    buildSystemPrompt: (backend) =>
      systemPrompt(backend, mode, deps.settings.flowModelDefaults, deps.provenFlows),
    userMessage,
    attachments,
    verb: mode === 'revise' ? 'edit' : 'draft',
  });
}

/// The transport half of drafting, exported for other NL→structured-config
/// drafters (the worker hire drafter): pick the user's healthy preferred CLI,
/// run one hidden text-only turn with the caller's system prompt, return raw
/// text. Same backend selection and transports as flow drafting, so a second
/// drafter can never drift from the first.
export async function oneShotDraftText(
  deps: DraftDeps,
  args: {
    buildSystemPrompt: (backend: Backend) => string;
    userMessage: string;
    /// Files the user attached to the request — a spec, a screenshot of the
    /// thing they want built, an export to work from. Handed to the CLI the
    /// same way a chat turn's attachments are.
    attachments?: Attachment[];
    /// Verb for the no-CLI error: "No CLI is signed in to <verb> with."
    verb: string;
    /// Override the model. `drafterModelFor` returns the backend's STRONGEST
    /// model, which is right for "design a flow from one sentence" and wrong
    /// for a small, mechanical rewrite — those want the fast tier and the
    /// latency that comes with it.
    model?: string;
    /// Fires with the running assistant text as the turn streams, so a
    /// caller can show the work instead of a spinner.
    onProgress?: (text: string) => void;
    /// Handle for `RunnerManager.cancelOneShot`, so a caller can stop the turn.
    cancelKey?: string;
  },
): Promise<
  { ok: true; text: string; label: string; backend: Backend } | { ok: false; error: string }
> {
  // Health is resolved up front rather than probed inside the predicate:
  // probing executes a CLI, so it's async now (it used to block the main
  // thread) and `pickDrafterBackend` can't await mid-predicate.
  const healthy = await healthyBackends(deps.settings.backendPaths);
  const backend = pickDrafterBackend({
    preferred: deps.settings.preferredBackend,
    isHealthy: (b) => healthy.has(b),
    isEnabled: (b) => deps.settings.disabledBackends[b] !== true,
  });
  if (!backend) {
    return {
      ok: false,
      error:
        `No CLI is signed in to ${args.verb} with. ` +
        'Set up Claude, Codex, Gemini, or Copilot in Settings first.',
    };
  }
  const model = args.model?.trim() || drafterModelFor(backend);
  const label = backendLabel(backend);
  const sys = args.buildSystemPrompt(backend);

  // Only reach for the in-process Agent SDK when the user has opted into the
  // experimental SDK transport. By default Claude drafts through the runner
  // one-shot like every other CLI — spawning the user's installed `claude`,
  // exactly as a normal chat does. (The hidden one-shot uses the 'cli'
  // transport since `oneShot` never sets claudeTransport.)
  //
  // Attachments force the runner path regardless: the SDK call below sends a
  // plain string prompt with no attachment channel, so taking it would drop
  // the user's files silently. The runner already knows how to encode them
  // per backend.
  const useClaudeSdk =
    backend === 'claude' &&
    deps.settings.claudeTransport === 'sdk' &&
    !(args.attachments && args.attachments.length > 0);
  const text = useClaudeSdk
    ? await draftViaClaudeSdk(args.userMessage, model, sys, deps.settings.backendPaths.claude)
    : await draftViaRunner(deps.runner, backend, model, sys, args.userMessage, args.attachments, args.onProgress, args.cancelKey);
  if (!text.ok) return text;
  return { ok: true, text: text.text, label, backend };
}

/// Direct SDK path for Claude: a pure-text generation with the claude_code
/// preset bypassed and tools fully disabled.
async function draftViaClaudeSdk(
  userMessage: string,
  model: string,
  systemPromptText: string,
  claudeBinOverride?: string,
): Promise<OneShotResult> {
  const executable = claudeSdkExecutablePath(claudeBinOverride);
  let collected = '';
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), 10 * 60_000);
  try {
    const stream = query({
      prompt: userMessage,
      options: {
        // Pure custom system prompt — we don't want the claude_code preset
        // injecting its project-context bits into a pure text-generation
        // task. The schema + example carries everything the model needs.
        systemPrompt: systemPromptText,
        model,
        cwd: os.homedir(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // No tools — this is text generation only. We explicitly forbid
        // them rather than relying on the model not to ask.
        allowedTools: [],
        abortController: controller,
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      },
    });
    for await (const event of stream) {
      if (event.type === 'assistant') {
        for (const block of event.message.content) {
          if (block.type === 'text') collected += block.text;
        }
      }
      if (event.type === 'result') break;
    }
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, error: 'Claude SDK draft timed out after 10 minutes.' };
    }
    return {
      ok: false,
      error: `Claude SDK call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(budget);
  }
  return { ok: true, text: collected };
}

/// Generic path for every non-Claude CLI: a hidden one-shot through the
/// RunnerManager. The system prompt is folded into the user prompt since
/// `oneShot` has no separate system-prompt channel (same approach the flow
/// runtime uses for step prompts).
async function draftViaRunner(
  runner: RunnerManager,
  backend: Backend,
  model: string,
  systemPromptText: string,
  userMessage: string,
  attachments?: Attachment[],
  onProgress?: (text: string) => void,
  cancelKey?: string,
): Promise<OneShotResult> {
  const prompt = `${systemPromptText}\n\n---\n\n${userMessage}`;
  return runner.oneShot({
    backend,
    model,
    prompt,
    attachments,
    // Drafting is pure text generation — the SDK sibling of this function
    // disables tools outright. Booting the user's MCP servers first buys
    // nothing and costs the whole cold start before the first token.
    //
    // `skipGlobalMcp`, not `turbo`: turbo would also pin effort to 'low',
    // and this path runs the backend's strongest model against a large
    // schema prompt precisely because the reasoning matters.
    skipGlobalMcp: true,
    cancelKey,
    ...(onProgress ? { onProgress: (snap: { text: string }) => onProgress(snap.text) } : {}),
    cwd: os.homedir(),
    // `oneShot`'s flat 120s default was killing healthy drafts. Drafting runs
    // the backend's STRONGEST model against a large schema prompt and asks it
    // to emit a whole flow in one turn — a minute of reasoning before the
    // first token, then sixty-plus lines of YAML, is normal, and two minutes
    // of wall clock is not a lot of room. The hire drafter felt it worst:
    // its second turn is a full flow draft, so a hire that "worked" landed on
    // the review screen with an empty flow picker.
    //
    // Budget on SILENCE instead, the same shape the orchestrator producer and
    // the worker planner use. A turn still streaming tokens keeps going; only
    // one that has genuinely gone quiet is cut, with a generous ceiling
    // behind it as the runaway backstop.
    timeoutMs: 10 * 60_000,
    idleTimeoutMs: 90_000,
  });
}

/// Parse + validate the raw CLI output into a Flow. Shared by every
/// backend path. `label` names the CLI in any error message. `opts.id` pins
/// the resulting flow's id (revisions of an existing flow keep theirs);
/// without it the id is derived from the generated name.
///
/// `opts.snapModels` turns on tier snapping (see `repairModelIds`). It is set
/// on the draft path and deliberately NOT on the revise path: "put the
/// planner on Opus 4.8" is a legitimate instruction, and revise is already
/// told to preserve existing model choices, so snapping there would overrule
/// the user with their own setting.
function finalizeDraft(
  raw: string,
  label: string,
  opts: { id?: string; snapModels?: FlowModelDefaults } = {},
): { ok: true; flow: Flow } | { ok: false; error: string } {
  const yaml = stripCodeFences(raw.trim());
  if (!yaml) return { ok: false, error: `${label} returned no content.` };

  const keepId = opts.id?.trim();
  const parsed = parseFlowYaml({
    yaml,
    id: keepId || 'drafted-flow',
    source: 'user',
    filePath: '',
  });
  if (!parsed) return { ok: false, error: `${label} returned unparseable YAML.` };

  // Give it a unique id derived from the name so saving it later doesn't
  // collide with another flow named "drafted-flow".
  parsed.id = keepId || slugify(parsed.name) || 'drafted-flow';

  // Salvage near-miss artifact names before validating. The model sometimes
  // emits an `output` with spaces or slashes ("audit report", "zendesk
  // metrics") — valid YAML the validator rejects. Coerce them to the allowed
  // charset and rewire any input refs so handoff stays intact.
  repairArtifactNames(parsed);

  // Salvage near-miss model ids the same way. The model occasionally emits
  // a model with the wrong version separator for the backend — most often
  // `claude-haiku-4.5` (dotted) on the `claude` backend, whose catalog id is
  // `claude-haiku-4-5` (dashed). The exact-match validator would reject these
  // as "not supported"; snap each premium ref to its canonical spelling first.
  repairModelIds(parsed, opts.snapModels);

  // Reconcile role against the system prompt the model did (or didn't) write,
  // so a near-miss on the custom-prompt path doesn't ship a broken step.
  repairRoleFit(parsed);

  // Un-gate reviewer lenses in a flow that has nothing to gate.
  repairAssessorGates(parsed);

  // Drop invented tags. The vocabulary is the whole point — a drafted flow
  // tagged "jira-triage" doesn't sit under the `triage` filter next to the
  // published ones, so a free-form tag is worse than no tag.
  repairTags(parsed);

  const v = validateFlow(parsed);
  if (!v.ok) {
    return {
      ok: false,
      error:
        `${label}'s ${keepId ? 'revision' : 'draft'} failed validation: ` +
        v.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
    };
  }
  return { ok: true, flow: parsed };
}

/// Strip ```yaml … ``` fences if Claude wraps despite our instruction. We
/// also accept a plain ``` fence.
function stripCodeFences(text: string): string {
  const fenced = text.match(/^```(?:yaml|yml)?\n([\s\S]*?)\n```\s*$/);
  if (fenced) return fenced[1].trim();
  return text;
}

/// Keep only tags from the shared taxonomy, capped at 4. Anything the model
/// invented is dropped rather than corrected — there's no reliable mapping
/// from "code-review" to `review`, and a wrong tag files the flow under a
/// filter its user will never think to open. Clears the key entirely when
/// nothing survives, so the saved YAML stays byte-identical to an untagged
/// flow's.
function repairTags(flow: Flow): void {
  if (!flow.tags) return;
  const allowed = new Set(TAG_AXES.flatMap((a) => a.tags));
  const kept: string[] = [];
  for (const raw of flow.tags) {
    const tag = normalizeFlowTag(raw);
    if (tag && allowed.has(tag) && !kept.includes(tag)) kept.push(tag);
    if (kept.length === 4) break;
  }
  flow.tags = kept.length > 0 ? kept : undefined;
}

/// Snap every premium model ref in the flow to its canonical catalog
/// spelling, fixing dot-vs-dash version mismatches (e.g. drafted
/// `claude-haiku-4.5` → `claude-haiku-4-5` on the claude backend) and
/// lifting any reference to a retired model (e.g. `claude-opus-4-7`) up to
/// the next-highest in-family version we still ship. Walks participants,
/// legacy step-level models, and rebound critics. Ollama and
/// already-canonical refs pass through untouched. Mutates `flow` in place.
///
/// When `snap` is passed, each ref is then rewritten to whatever its own
/// speed tier currently resolves to. Canonicalize + lift only rescue ids we
/// no longer ship; a drafting CLI's more common failure is naming a model
/// that IS still in the catalog but a generation behind what the user has
/// — `gpt-5.4-mini` for a fast step, `claude-opus-4-8` for a thinking one.
/// Those pass every other check, so tier snapping is the only thing that
/// catches them. The drafter still owns the tier decision; snapping only
/// fixes which model that tier names.
function repairModelIds(flow: Flow, snap?: FlowModelDefaults): void {
  // Canonicalize first (snaps a dotted alias onto its catalog spelling),
  // then lift (rewrites a still-unsupported id to a newer in-family one),
  // then — if enabled — snap the survivor onto its tier's current default.
  const repair = (backend: FlowModelRef['backend'], model: string) => {
    const premium = backend as Exclude<typeof backend, 'ollama'>;
    const lifted = liftMissingModel(premium, canonicalizePremiumModel(premium, model));
    return snap ? snapToTierDefault(premium, lifted, snap) : lifted;
  };
  const fix = (ref: FlowModelRef | undefined) => {
    if (!ref || ref.backend === 'ollama') return;
    ref.model = repair(ref.backend, ref.model);
  };
  for (const p of flow.participants ?? []) {
    if (p.backend !== 'ollama') {
      p.model = repair(p.backend, p.model);
    }
  }
  for (const step of flow.steps) {
    fix(step.model);
    fix(step.rebound?.critic);
  }
}

/// Reconcile each step's `role` with its `system_prompt`. The drafting model
/// is asked to judge preset fit and fall back to `custom` + `system_prompt`
/// when nothing fits; it lands near-miss combinations two ways, both of which
/// resolveSystemPrompt would otherwise handle silently and wrongly:
///
///   - a written prompt left under a preset role — the override is dropped and
///     the preset's body runs instead, quietly discarding the model's judgement
///     that the preset did NOT fit. The prompt is the more specific signal, so
///     honour it: flip the role to `custom` (the same invariant the builder
///     enforces when a user edits the prompt textarea).
///   - a role that isn't a preset at all (a typo, or an invented name like
///     `summarizer`) carrying a prompt — same fix, and it rescues the step from
///     a `ROLE_PROMPTS[role]` miss that resolves to the string "undefined".
///
/// An unknown role with NO prompt is left alone for validateFlow to reject —
/// there's nothing here to recover it from. Mutates `flow` in place.
function repairRoleFit(flow: Flow): void {
  for (const step of flow.steps) {
    if (!step.systemPromptOverride?.trim()) continue;
    if (step.role === 'custom') continue;
    step.role = 'custom';
  }
}

/// A reviewer role GATES: fail to approve and the runtime treats the step as
/// failed and pauses the run. That is only meaningful when something later can
/// act on the verdict. The drafter is told (ROLES) that
/// `reviewer`/`code-reviewer`/`security-reviewer`/`adversarial-reviewer`
/// require a prior code-writing step — a flow with no implementer, test-writer
/// or shipper has none, so nothing in it can act on a verdict and every such
/// review is really an ASSESSOR feeding a report.
///
/// Left gating, those flows deadlock on exactly the runs worth reading: an
/// audit whose security lens finds two real issues stops at the lens, and the
/// report that was the whole point of the run never gets written. So when the
/// model emits that shape anyway, take it at its word about the flow's purpose
/// and drop the gate rather than shipping a run that halts on success.
///
/// `plan-reviewer` is deliberately exempt — judging a plan before any code
/// exists is a real gate, and its whole job is to run in a flow with no
/// code-writing step. An explicit `verdict_gate` always wins.
function repairAssessorGates(flow: Flow): void {
  if (flowHasCodeWritingStep(flow.steps)) return;
  for (const step of flow.steps) {
    if (step.verdictGate !== undefined) continue;
    if (step.role === 'plan-reviewer') continue;
    if (!isGatingReviewerRole(step.role)) continue;
    step.verdictGate = false;
  }
}

/// Rewrite any step `output` that violates ARTIFACT_NAME_RE into a valid
/// name, then remap every input ref that pointed at the old name so the
/// produced→consumed wiring survives the rename. Mutates `flow` in place.
/// already-valid names and `user_prompt` pass through untouched.
function repairArtifactNames(flow: Flow): void {
  const rename = new Map<string, string>();
  for (const step of flow.steps) {
    const original = step.output;
    if (typeof original !== 'string' || ARTIFACT_NAME_RE.test(original)) continue;
    const fixed = sanitizeArtifactName(original);
    if (!fixed || fixed === original) continue;
    step.output = fixed;
    rename.set(original, fixed);
  }
  if (rename.size === 0) return;
  for (const step of flow.steps) {
    if (!Array.isArray(step.inputs)) continue;
    step.inputs = step.inputs.map((ref) => rename.get(ref) ?? ref);
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
