// AI-assisted hiring. The user types a job description ("You're the Support
// Triage Worker: read new tickets each morning, reproduce what you can, hand
// off fix candidates…") and one drafter turn returns the WHOLE standing
// configuration for review: the persona, the cadence, the caps, the budget,
// the heartbeat model, and which flow the worker's launched items should run
// — or, when no existing flow fits, a drafted new flow via the same engine
// the flow builder uses. Nothing is saved here: the renderer shows the
// contract, the user adjusts, and only the Hire click persists anything.

import type { Backend } from '../../shared/types';
import type { FlowModelDefaults } from '../../shared/modelCatalog';
import type { Flow } from '../../shared/flows/schema';
import { drafterModelHints } from '../../shared/flows/drafterBackend';
import { describeTrigger } from '../../shared/flows/schedule';
import {
  WORKER_MAX_ITEMS_PER_SHIFT,
  parseWorkerContract,
  type WorkerContract,
} from '../../shared/flows/worker';
import { serializeFlow } from '../../shared/flows/yaml';
import {
  draftFlowFromPrompt,
  oneShotDraftText,
  reviseFlowFromPrompt,
  type DraftDeps,
} from './drafter';
import { log } from '../diagnostics';

export interface HireFlowOption {
  id: string;
  name: string;
  description?: string;
}

export interface HireProjectOption {
  name: string;
  path: string;
  kind: 'project' | 'workspace';
}

function hireSystemPrompt(
  backend: Backend,
  flows: HireFlowOption[],
  projects: HireProjectOption[],
  modelDefaults?: FlowModelDefaults,
): string {
  const hints = drafterModelHints(backend, modelDefaults);
  const flowLines =
    flows.length > 0
      ? flows.map((f) => `  - id: "${f.id}" — ${f.name}${f.description ? `: ${f.description}` : ''}`)
      : ['  (none exist yet)'];
  return [
    'You are the hiring assistant for overcli. The user describes a standing WORKER — a named',
    'persona with a job description that will run on a cadence, plan each of its own shifts, and',
    'file proposals for the user to approve. Your job is to turn the description into ONE',
    'complete worker contract.',
    '',
    'Write a short plain-language summary of your read on the job FIRST. Then, on its own,',
    'emit EXACTLY ONE block in this shape (and nothing after it):',
    '',
    '<worker>',
    '{',
    '  "name": "short persona name, e.g. Scout",',
    '  "jobDescription": "the job, rewritten to be self-contained and explicit — the worker plans every shift from ONLY this text plus its own journal",',
    '  "cadence": { "kind": "daily", "time": "09:00", "days": [1, 2, 3, 4, 5] },',
    `  "maxItemsPerShift": ${Math.min(3, WORKER_MAX_ITEMS_PER_SHIFT)},`,
    '  "budgetUSDPerMonth": 10,',
    `  "heartbeatModel": "${hints.fast}",`,
    '  "flowRequest": "Describe the flow needed for the worker\'s daily work."',
    '}',
    '</worker>',
    '',
    'EXISTING FLOWS (pick flowId from these, or omit it and write flowRequest):',
    ...flowLines,
    '',
    "PROJECTS AND WORKSPACES (for projectPath — match by name against the job description):",
    ...(projects.length > 0
      ? projects.map(
          (p) => `  - path: "${p.path}" — ${p.name}${p.kind === 'workspace' ? ' (workspace)' : ''}`,
        )
      : ['  (none exist yet)']),
    '',
    'Rules:',
    '  - The block MUST be valid JSON (double quotes, no trailing commas, no comments).',
    '  - Exactly one of flowId / flowRequest. Prefer an existing flow when one genuinely fits.',
    '  - Cadence: match the job. Morning triage → daily on weekdays. Monitoring → interval',
    '    with a waking-hours window. Never more often than every 15 minutes.',
    '    Interval cadence uses everyMinutes, days, and an optional start/end window.',
    `  - maxItemsPerShift is a number from 1 to ${WORKER_MAX_ITEMS_PER_SHIFT}.`,
    '  - projectPath is optional and must be an exact path from the projects list when clear.',
    '  - Budget: modest by default ($5–$25/month) unless the description implies heavy work.',
    '  - Days use 0 = Sunday … 6 = Saturday.',
    '  - Do not invent fields. Do not write anything after </worker>.',
  ].join('\n');
}

/// One hire turn: job description in, reviewed-not-saved contract out —
/// plus a drafted Flow when the contract asked for one. The contract's
/// summary prose rides along for the review screen.
export async function draftWorkerFromPrompt(
  args: { jobDescription: string; flows: HireFlowOption[]; projects: HireProjectOption[] },
  deps: DraftDeps,
): Promise<
  | { ok: true; contract: WorkerContract; summary: string; draftedFlow?: Flow }
  | { ok: false; error: string }
> {
  const jobDescription = args.jobDescription.trim();
  if (!jobDescription) return { ok: false, error: 'Describe the job first.' };

  const out = await oneShotDraftText(deps, {
    buildSystemPrompt: (backend) =>
      hireSystemPrompt(backend, args.flows, args.projects, deps.settings.flowModelDefaults),
    userMessage: `JOB DESCRIPTION:\n${jobDescription}`,
    verb: 'hire',
  });
  if (!out.ok) return out;

  const signedOutPatterns: Partial<Record<Backend, string[]>> = {
    claude: ['not logged in', 'please run /login', 'claude auth login'],
    copilot: ['not logged in', 'copilot login', 'authentication required'],
    gemini: ['not logged in', '/auth', 'select an auth method'],
    codex: ['not logged in', 'codex login', 'authentication required'],
  };
  const reply = out.text.toLowerCase();
  const patterns = signedOutPatterns[out.backend] ?? [];
  const hasWorkerBlock = /<worker>[\s\S]*<\/worker>/i.test(out.text);
  if (!hasWorkerBlock && patterns.some((pattern) => reply.includes(pattern))) {
    return { ok: false, error: `${out.label} is not signed in. Run the backend login command and try again.` };
  }

  const contract = parseWorkerContract(out.text, {
    knownFlowIds: args.flows.map((f) => f.id),
    defaultHeartbeatModel: drafterModelHints(out.backend, deps.settings.flowModelDefaults).fast,
    // Stamp the backend the hire actually ran on, so the model it just chose
    // stays paired with the CLI it belongs to.
    defaultHeartbeatBackend: out.backend,
    knownProjectPaths: args.projects.map((p) => p.path),
  });
  if (!contract) {
    const excerpt = out.text.replace(/\s+/g, ' ').trim().slice(0, 500);
    log('warn', 'workers.hire', `Worker contract parse failed. Reply: ${excerpt}`);
    return { ok: false, error: `${out.label} returned no parseable worker contract. Reply: ${excerpt}` };
  }
  // Keep the human half of the reply for the review screen; drop the block.
  const summary = out.text.replace(/<worker>[\s\S]*$/i, '').trim();

  // No flow picked and none requested: fall back to asking for one drafted
  // from the job description itself, so a first-run user with zero flows
  // still gets a complete, hireable contract.
  const flowRequest =
    contract.flowId ? undefined : contract.flowRequest ?? flowRequestFromJob(contract);

  if (!flowRequest) return { ok: true, contract, summary };

  const drafted = await draftFlowFromPrompt(
    { description: flowDraftDescription(flowRequest, contract.jobDescription) },
    deps,
  );
  if (!drafted.ok) {
    // The contract is still reviewable — the user can pick a flow by hand.
    return { ok: true, contract, summary };
  }
  return { ok: true, contract, summary, draftedFlow: drafted.flow };
}

/// What the flow designer is actually handed. `flowRequest` is the hire
/// drafter's PARAPHRASE of the job, and the designer never meets the user —
/// so the job description rides along verbatim and outranks it. Requirements
/// about the deliverable (its audience, its tone, what it must show) are
/// exactly the kind of detail a paraphrase drops, and dropping them here is
/// unrecoverable: the flow gets designed without them.
function flowDraftDescription(flowRequest: string, jobDescription: string): string {
  const original = jobDescription.trim();
  // flowRequestFromJob already embeds the whole job description — don't
  // repeat it back at the designer twice.
  if (!original || flowRequest.includes(original)) return flowRequest;
  return [
    flowRequest,
    '',
    "THE USER'S OWN DESCRIPTION OF THE JOB (authoritative — the text above is a paraphrase of",
    'it). Where the two disagree, or where this names something the paraphrase left out — an',
    'audience, a tone, a format, something a deliverable must show — follow THIS:',
    original,
  ].join('\n');
}

function flowRequestFromJob(contract: WorkerContract): string {
  return [
    `A flow for items produced by a standing worker named "${contract.name}"`,
    `(cadence: ${describeTrigger(contract.cadence)}). The worker's job: ${contract.jobDescription}`,
    'Each run receives ONE self-contained candidate prompt from that job. Investigate, do the',
    'work the candidate asks for, and include a review step before anything ships.',
  ].join(' ');
}

// ---- Revision -----------------------------------------------------------

/// A worker is two halves: the JOB DESCRIPTION (the planning half — what it
/// scans each shift, what a good proposal looks like) and its FLOW (the
/// execution half — how each approved item is carried out). A change like
/// "file a WOW ticket for every test you fix" needs BOTH: the flow gains a
/// ticket-filing step, and the job description must tell the planner to put
/// the ticket-worthy details in each candidate. This turn routes one
/// instruction to the right half or halves.
function reviseSystemPrompt(): string {
  return [
    'You are the contract reviser for an overcli Worker — a standing persona that plans a batch',
    'of small work items each shift (driven by its JOB DESCRIPTION), and executes each approved',
    'item through a multi-step FLOW.',
    '',
    'The user asks for one change. Decide which half must change:',
    '  - Planning changes (what to scan, what to prioritize, what a proposal must contain)',
    '    → rewrite the job description.',
    '  - Execution changes (extra steps like filing tickets or posting messages, different',
    '    reviews, different deliverables) → write an instruction for the flow editor.',
    '  - Many changes need both. Example: "file a tracker ticket for each fix" means the flow',
    '    gains a ticket-filing step AND the job description tells the planner each candidate',
    '    must carry the details that step will need (the test name, the failure, the evidence).',
    '',
    'Write one short plain-language paragraph FIRST saying what you changed and where. Then, on',
    'its own, emit EXACTLY ONE block in this shape (and nothing after it):',
    '',
    '<revision>',
    '{',
    '  "jobDescription": "the COMPLETE updated job description, or null if unchanged",',
    '  "flowInstruction": "a self-contained instruction for the flow editor describing exactly',
    '                      what to change in the flow, or null if the flow is unchanged"',
    '}',
    '</revision>',
    '',
    'Rules:',
    '  - Valid JSON. jobDescription is the WHOLE text, not a diff — preserve everything the',
    '    change does not touch.',
    '  - The smallest edit that satisfies the request. Never rewrite for style.',
    '  - flowInstruction is consumed by a separate flow editor that sees only the YAML and that',
    '    instruction — make it stand alone (name the step to add/change, its job, its tools).',
  ].join('\n');
}

/// Route one instruction across a worker's job description and its flow.
/// Nothing is saved: the caller shows both proposed halves for review.
export async function reviseWorkerFromPrompt(
  args: {
    jobDescription: string;
    instruction: string;
    /// The worker's primary flow, when it has one — full Flow so the reviser
    /// can hand its YAML to the flow editor.
    flow?: Flow;
  },
  deps: DraftDeps,
): Promise<
  | { ok: true; jobDescription?: string; flow?: Flow; note: string }
  | { ok: false; error: string }
> {
  const instruction = args.instruction.trim();
  if (!instruction) return { ok: false, error: 'Describe the change first.' };

  const userMessage = [
    'CURRENT JOB DESCRIPTION',
    '=======================',
    args.jobDescription,
    '',
    ...(args.flow
      ? ['CURRENT FLOW (YAML)', '===================', serializeFlow(args.flow), '']
      : ['(This worker has no flow yet.)', '']),
    'REQUESTED CHANGE',
    '================',
    instruction,
  ].join('\n');

  const out = await oneShotDraftText(deps, {
    buildSystemPrompt: () => reviseSystemPrompt(),
    userMessage,
    verb: 'revise',
  });
  if (!out.ok) return out;

  const block =
    out.text.match(/<revision>([\s\S]*?)<\/revision>/i)?.[1] ?? out.text.match(/\{[\s\S]*\}/)?.[0];
  if (!block) return { ok: false, error: `${out.label} returned no parseable revision.` };
  let parsed: { jobDescription?: unknown; flowInstruction?: unknown };
  try {
    parsed = JSON.parse(block.trim());
  } catch {
    return { ok: false, error: `${out.label} returned malformed revision JSON.` };
  }
  const note = out.text.replace(/<revision>[\s\S]*$/i, '').trim() || 'Revised.';
  const jobDescription =
    typeof parsed.jobDescription === 'string' && parsed.jobDescription.trim()
      ? parsed.jobDescription.trim()
      : undefined;
  const flowInstruction =
    typeof parsed.flowInstruction === 'string' && parsed.flowInstruction.trim()
      ? parsed.flowInstruction.trim()
      : undefined;

  if (!flowInstruction || !args.flow) {
    if (!jobDescription && !flowInstruction) {
      return { ok: false, error: 'The reviser found nothing to change for that instruction.' };
    }
    return { ok: true, jobDescription, note };
  }

  // The flow half goes through the SAME editor the Flows tab uses — full
  // schema prompt, repairs, validation — so an AI worker revision can't
  // produce a flow state a hand edit couldn't.
  const revised = await reviseFlowFromPrompt(
    { yaml: serializeFlow(args.flow), instruction: flowInstruction, id: args.flow.id },
    deps,
  );
  if (!revised.ok) {
    // Deliver the half that worked rather than failing the whole revision;
    // the note carries what still needs doing by hand.
    return {
      ok: true,
      jobDescription,
      note: `${note}\n\nThe flow change could not be applied automatically (${revised.error}). Flow instruction that was attempted: ${flowInstruction}`,
    };
  }
  // Keep identity: the revision updates the flow in place on save.
  revised.flow.source = args.flow.source;
  revised.flow.filePath = args.flow.filePath;
  return { ok: true, jobDescription, flow: revised.flow, note };
}
