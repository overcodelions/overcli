// AI-assisted flow drafting. The user types a description of what they
// want (e.g. "fix a Jira ticket then open a PR"), and we ask their
// PREFERRED CLI — with the Flow YAML schema in its system prompt — to
// generate a draft. The result lands in the editor; the user refines from
// there.
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

import type { AppSettings, Backend } from '../../shared/types';
import type { Flow, FlowModelRef } from '../../shared/flows/schema';
import { canonicalizePremiumModel } from '../../shared/modelCatalog';
import { parseFlowYaml } from '../../shared/flows/yaml';
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
import { probeBackendHealth } from '../health';
import type { OneShotResult, RunnerManager } from '../runner';

export interface DraftDeps {
  settings: AppSettings;
  runner: RunnerManager;
}

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
function systemPrompt(backend: Backend): string {
  const hints = drafterModelHints(backend);
  const label = backendLabel(backend);
  return [
    'You are a flow designer for overcli. A "flow" is a sequence of LLM steps that run autonomously,',
    'each step backed by its own model + tools, with artifact handoff. The user will describe what',
    'they want; you respond with ONLY a YAML body that conforms to the schema below — no prose, no',
    'code fences, no commentary. Start your response on the first line with `name:`.',
    '',
    'SCHEMA',
    '======',
    'Top-level keys:',
    '  name        — required, short human title',
    '  description — optional, 1–3 line summary',
    '  input       — always the literal string `user_prompt`',
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
    '  pause_before  — optional bool. When true, the run pauses BEFORE this step so the user can',
    '                  review prior artifacts. NEVER set on the first step.',
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
    '',
    'EXAMPLE — a step no preset covers:',
    '  - id: triage',
    '    model: { backend: claude, model: claude-sonnet-4-6 }',
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
    'Always include at least one step that consumes "user_prompt".',
    'Default to permission_mode: bypassPermissions on any step that writes (so the flow can run',
    'unattended). pause_before: true is the right knob for human checkpoints — set it on shipper',
    'steps that push code, open PRs, or send messages.',
    '',
    'EXAMPLE',
    '=======',
    FLOW_TEMPLATES[0].yaml,
    '',
    `NOTE: the example above happens to use claude + ollama, but THIS user prefers ${label} —`,
    `use ${backend} models (as listed under CONVENTIONS) for the steps you generate, not claude.`,
    '',
    'Now produce a YAML for the user\'s described flow. Reply with YAML only.',
  ].join('\n');
}

/// Draft a flow from the user's description using their preferred CLI.
/// Returns the parsed Flow (validated) or a surfaced error the renderer can
/// show. Times out at 120s.
export async function draftFlowFromPrompt(
  args: { description: string },
  deps: DraftDeps,
): Promise<{ ok: true; flow: Flow } | { ok: false; error: string }> {
  const desc = args.description.trim();
  if (!desc) return { ok: false, error: 'Description is empty.' };

  const backend = pickDrafterBackend({
    preferred: deps.settings.preferredBackend,
    isHealthy: (b) =>
      probeBackendHealth(b, deps.settings.backendPaths[b]).kind === 'ready',
    isEnabled: (b) => deps.settings.disabledBackends[b] !== true,
  });
  if (!backend) {
    return {
      ok: false,
      error:
        'No CLI is signed in to draft with. Set up Claude, Codex, Gemini, or Copilot in Settings first.',
    };
  }
  const model = drafterModelFor(backend);
  const label = backendLabel(backend);

  // Only reach for the in-process Agent SDK when the user has opted into the
  // experimental SDK transport. By default Claude drafts through the runner
  // one-shot like every other CLI — spawning the user's installed `claude`,
  // exactly as a normal chat does. (The hidden one-shot uses the 'cli'
  // transport since `oneShot` never sets claudeTransport.)
  const useClaudeSdk =
    backend === 'claude' && deps.settings.claudeTransport === 'sdk';
  const text = useClaudeSdk
    ? await draftViaClaudeSdk(desc, model, deps.settings.backendPaths.claude)
    : await draftViaRunner(deps.runner, backend, model, desc);
  if (!text.ok) return text;

  return finalizeDraft(text.text, label);
}

/// Direct SDK path for Claude: a pure-text generation with the claude_code
/// preset bypassed and tools fully disabled.
async function draftViaClaudeSdk(
  desc: string,
  model: string,
  claudeBinOverride?: string,
): Promise<OneShotResult> {
  const executable = claudeSdkExecutablePath(claudeBinOverride);
  let collected = '';
  try {
    const stream = query({
      prompt: desc,
      options: {
        // Pure custom system prompt — we don't want the claude_code preset
        // injecting its project-context bits into a pure text-generation
        // task. The schema + example carries everything the model needs.
        systemPrompt: systemPrompt('claude'),
        model,
        cwd: os.homedir(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // No tools — this is text generation only. We explicitly forbid
        // them rather than relying on the model not to ask.
        allowedTools: [],
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
    return {
      ok: false,
      error: `Claude SDK call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
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
  desc: string,
): Promise<OneShotResult> {
  const prompt = `${systemPrompt(backend)}\n\n---\n\nUSER REQUEST:\n${desc}\n\nReply with YAML only.`;
  return runner.oneShot({ backend, model, prompt, cwd: os.homedir() });
}

/// Parse + validate the raw CLI output into a Flow. Shared by every
/// backend path. `label` names the CLI in any error message.
function finalizeDraft(
  raw: string,
  label: string,
): { ok: true; flow: Flow } | { ok: false; error: string } {
  const yaml = stripCodeFences(raw.trim());
  if (!yaml) return { ok: false, error: `${label} returned no content.` };

  const parsed = parseFlowYaml({
    yaml,
    id: 'drafted-flow',
    source: 'user',
    filePath: '',
  });
  if (!parsed) return { ok: false, error: `${label} returned unparseable YAML.` };

  // Give it a unique id derived from the name so saving it later doesn't
  // collide with another flow named "drafted-flow".
  parsed.id = slugify(parsed.name) || 'drafted-flow';

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
  repairModelIds(parsed);

  // Reconcile role against the system prompt the model did (or didn't) write,
  // so a near-miss on the custom-prompt path doesn't ship a broken step.
  repairRoleFit(parsed);

  const v = validateFlow(parsed);
  if (!v.ok) {
    return {
      ok: false,
      error:
        `${label}'s draft failed validation: ` +
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

/// Snap every premium model ref in the flow to its canonical catalog
/// spelling, fixing dot-vs-dash version mismatches (e.g. drafted
/// `claude-haiku-4.5` → `claude-haiku-4-5` on the claude backend). Walks
/// participants, legacy step-level models, and rebound critics. Ollama and
/// already-canonical refs pass through untouched. Mutates `flow` in place.
function repairModelIds(flow: Flow): void {
  const fix = (ref: FlowModelRef | undefined) => {
    if (!ref || ref.backend === 'ollama') return;
    ref.model = canonicalizePremiumModel(ref.backend, ref.model);
  };
  for (const p of flow.participants ?? []) {
    if (p.backend !== 'ollama') {
      p.model = canonicalizePremiumModel(p.backend, p.model);
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
