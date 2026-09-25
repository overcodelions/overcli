// AI-assisted hiring. The user types a job description ("You're the Support
// Triage Worker: read new tickets each morning, reproduce what you can, hand
// off fix candidates…") and one drafter turn returns the WHOLE standing
// configuration for review: the persona, the cadence, the caps, the budget,
// the heartbeat model, and which flow the worker's launched items should run
// — or, when no existing flow fits, a drafted new flow via the same engine
// the flow builder uses. Nothing is saved here: the renderer shows the
// contract, the user adjusts, and only the Hire click persists anything.
//
// The hire can also be a conversation: in interview mode the drafter may ask
// a few questions first, and each turn replays the exchange so far. It is
// the same drafter and the same contract — only the front of the hire moves.

import { parseMcpToolName } from '../../shared/flows/mcpTools';
import type { Attachment, Backend } from '../../shared/types';
import type { FlowModelDefaults } from '../../shared/modelCatalog';
import type { Flow } from '../../shared/flows/schema';
import {
  HIRE_INTERVIEW_MAX_ROUNDS,
  WORKER_CONTRACT_MAX_FLOWS,
  WORKER_MAX_ITEMS_PER_SHIFT,
  describeCadence,
  hireMessageText,
  parseHireQuestions,
  parseWorkerContract,
  type HireMessage,
  type HireQuestion,
  type WorkerContractFlow,
  type WorkerContract,
} from '../../shared/flows/worker';
import {
  parsePersonalization,
  type PersonalizationQuestion,
} from '../../shared/flows/personalize';
import { tierDefault } from '../../shared/modelCatalog';
import { drafterModelHints, pickDrafterBackend } from '../../shared/flows/drafterBackend';
import { serializeFlow } from '../../shared/flows/yaml';
import { healthyBackends } from '../health';
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
  crew: string[],
  modelDefaults?: FlowModelDefaults,
  interview = false,
  /// The MCP servers this install has, by name. Undefined when unknown —
  /// then the drafter is not asked to pick, and the worker keeps the
  /// load-everything default.
  connected?: string[],
): string {
  const hints = drafterModelHints(backend, modelDefaults);
  const crewLines = crew.length > 0 ? crew.map((n) => `  - ${n}`) : ['  (nobody hired yet)'];
  const flowLines =
    flows.length > 0
      ? flows.map((f) => `  - id: "${f.id}" — ${f.name}${f.description ? `: ${f.description}` : ''}`)
      : ['  (none exist yet)'];
  return [
    'You are the hiring assistant for overcli. The user describes a standing WORKER — a named',
    'persona with a job description that plans each of its own shifts and',
    'file proposals for the user to approve. Your job is to turn the description into ONE',
    'complete worker contract.',
    '',
    'Write a short plain-language summary of your read on the job FIRST. Then, on its own,',
    'emit EXACTLY ONE block in this shape (and nothing after it):',
    '',
    '<worker>',
    '{',
    '  "name": "what you CALL this worker — a given name, one word, e.g. Nadia",',
    '  "tagline": "one line under the name — what this worker IS, e.g. \'the overcli innovator\' or \'watches CI and files the flakes\'",',
    '  "errandStarters": ["two or three one-off things the USER would plausibly ask this worker, in the user\'s own voice — e.g. \'what is stuck?\', \'recheck this morning\' — short, lowercase, no trailing period"],',
    '  "jobDescription": "the job, rewritten to be self-contained and explicit — the worker plans every shift from ONLY this text plus its own journal",',
    '  "cadence": { "kind": "daily", "time": "09:00", "days": [1, 2, 3, 4, 5] },',
    `  "maxItemsPerShift": ${Math.min(3, WORKER_MAX_ITEMS_PER_SHIFT)},`,
    '  "budgetUSDPerMonth": 10,',
    `  "heartbeatModel": "${hints.fast}",`,
    '  "wrapUp": { "flowRequest": "Only when the job wants ONE combined deliverable per shift — describe how to combine the items\' results." },',
    '  "flows": [',
    '    { "flowRequest": "Describe the flow needed for the worker\'s main work.", "when": "the kind of work that goes here" }',
    // The example has to stay valid JSON whichever field closes it.
    ...(connected
      ? ['  ],', '  "mcpServers": ["the configured servers this job uses — names from the list below"]']
      : ['  ]']),
    '}',
    '</worker>',
    '',
    'THE CREW ALREADY HIRED (the names in use — never reuse one):',
    ...crewLines,
    '',
    'EXISTING FLOWS (pick flowId from these, or omit it and write flowRequest):',
    ...flowLines,
    '',
    ...(connected
      ? [
          'MCP SERVERS THE USER HAS (from config files, plus the account connectors — named',
          '"claude.ai …" — that Claude has reported recently). A system not listed is',
          'UNCONFIRMED, not missing: a connector the user has not used from this app yet will',
          'not appear until they do:',
          ...(connected.length > 0 ? connected.map((n) => `  - ${n}`) : ['  (none configured)']),
          '',
        ]
      : []),
    "PROJECTS AND WORKSPACES (for projectPath — match by name against the job description):",
    ...(projects.length > 0
      ? projects.map(
          (p) => `  - path: "${p.path}" — ${p.name}${p.kind === 'workspace' ? ' (workspace)' : ''}`,
        )
      : ['  (none exist yet)']),
    '',
    'Rules:',
    '  - The block MUST be valid JSON (double quotes, no trailing commas, no comments).',
    '  - NAME: give the worker a name the way a person on the floor has one — a given name,',
    '    one word, the kind you would say out loud to get someone\'s attention ("Nadia",',
    '    "Theo", "Imani", "Roscoe"). NOT the job ("Test Coverage Warden"), NOT a tool or a',
    '    function ("Triage", "Sweeper", "Mender", "Forge"), NOT a product or service name,',
    '    and no surname, title, punctuation or project suffix. The tagline says what it',
    '    does; the name is only what you call it. Two reasons it has to be addressable:',
    '    the user talks TO it, and a colleague delegating work retypes the name EXACTLY —',
    '    an inexact name silently reaches nobody. So it must also be unique against the',
    '    crew above. Reach past the first names that come to mind and vary the cultural',
    '    origin across hires; do not echo the job description, the project or the tools.',
    '  - FLOWS: each entry is how one KIND of work gets done, and has exactly one of flowId',
    '    (an existing flow) or flowRequest (a new one). Prefer an existing flow when one',
    '    genuinely fits. ONE flow is the normal case. Add a second — at most',
    `    ${WORKER_CONTRACT_MAX_FLOWS} — only when the job has genuinely different kinds of work that need`,
    '    different steps or a different deliverable (drafting replies vs. a weekly digest).',
    '    Never split one kind of work into phases across flows. The first is the default:',
    '    work the planner cannot place goes there. "when" is one line saying which work',
    '    goes to that flow — the planner reads it when it routes.',
    '  - WRAP-UP: optional, and usually omitted. A shift can produce several items; include',
    '    "wrapUp" only when the job wants their results COMBINED into one deliverable (one',
    '    digest, one report, one message) rather than each delivered on its own. It is a flow',
    '    (flowId or flowRequest) that runs once after the items finish, with all their results',
    '    as input. Its flowRequest describes how to combine them and where the result goes.',
    '    Leave the key out entirely when each item stands alone. When you DO include it, the',
    '    whole contract is shaped around it:',
    '      - jobDescription says how a shift splits into items (one per trip, per ticket, per',
    '        source…) and what each item delivers — its PIECE, not the combined result.',
    '      - maxItemsPerShift is at least 2: combining one item is a wasted run.',
    '      - The route flows produce their piece and deliver NOTHING outward (no message,',
    '        post or email) — the wrap-up owns delivery, or the user gets one message per item',
    '        plus the combined one.',
    '  - flowRequest: describe ONE shift\'s work in 1–3 sentences and ask for the SHORTEST',
    '    flow that delivers it. The worker runs this flow on every item of every shift, so',
    '    each extra step is paid again on every run. Do not enumerate phases the job',
    '    description did not ask for.',
    '  - Cadence: match the job. Morning triage → daily on weekdays. Monitoring → interval',
    '    with a waking-hours window. Never more often than every 15 minutes.',
    '    Interval cadence uses everyMinutes, days, and an optional start/end window.',
    '    Only if NEITHER preset can say what the job needs — specific dates, specific months,',
    '    several minutes past the hour — use { "kind": "cron", "expr": "0 9 1,15 * *" }:',
    '    five fields, local time, no separate days list.',
    '    If the job is one the USER drives — a colleague to think with, break an epic down',
    '    with, or hand occasional one-off work to — there is no right time of day, and you',
    '    MUST use "cadence": null instead of inventing one. That worker still has a desk,',
    '    a budget and a journal; it simply never wakes on its own.',
    `  - maxItemsPerShift is a number from 1 to ${WORKER_MAX_ITEMS_PER_SHIFT}.`,
    '  - projectPath is optional and must be an exact path from the projects list when clear.',
    '  - Budget: modest by default ($5–$25/month) unless the description implies heavy work.',
    '  - Days use 0 = Sunday … 6 = Saturday.',
    '  - Tagline: at most 70 characters, no trailing period, and it must say what the worker',
    '    IS rather than repeat its name — it sits under the name on the roster.',
    ...(connected
      ? [
          '  - mcpServers: name exactly the configured servers the job uses, spelled as listed;',
          '    [] when it uses none of them. Every server listed costs time on every shift, so',
          '    leave out what the job does not touch. If the job depends on a system that is',
          '    not in the list (a mailbox, a tracker, a chat workspace), draft it anyway and',
          '    say plainly in the summary that it must be reachable — as a configured server',
          '    or an account connector — before the first shift.',
        ]
      : []),
    '  - Do not invent fields. Do not write anything after </worker>.',
    ...(interview ? interviewRules() : []),
  ].join('\n');
}

/// The hire as a conversation. Everything above still describes the contract;
/// this lets the drafter ask before it commits to one, so the parts a one-shot
/// guess gets wrong — where the deliverable goes, what done looks like, what
/// is off limits — come from the user instead of a default.
function interviewRules(): string[] {
  return [
    '',
    'THIS IS A CONVERSATION. The user is talking the job through with you before anything',
    'is drafted. On each turn, reply in ONE of two ways:',
    '  ASK — something that would change the contract is missing or ambiguous. Write ONE',
    '    short plain sentence of lead-in, then EXACTLY ONE block in this shape and nothing',
    '    after it (and NO <worker> block):',
    '    <questions>',
    '    { "questions": [',
    '      { "question": "Where should the drafts go?",',
    '        "options": ["Real drafts in each mailbox", "One daily digest file"] }',
    '    ] }',
    '    </questions>',
    '    At most three questions, most consequential first. Each is one short sentence — no',
    '    markdown, no numbering. Give two to four "options" when the likely answers are',
    '    few and short (the user clicks one); leave options out when the answer is open.',
    '  DRAFT — you know enough. Write the summary and the <worker> block exactly as above.',
    'Only ask about what the conversation leaves open AND what would change the contract:',
    '  - the deliverable: what it produces, who reads it, where it goes (a file, a channel, a PR)',
    '  - what "done" or "good" looks like for one piece of work',
    '  - what it must never touch or do',
    '  - which project it works in, when the list above does not settle it',
    '  - whether it wakes on its own or only when the user hands it work',
    '  - a system the job depends on that is not among the configured servers — ask whether',
    '    it is connected some other way (an account connector), or whether they want the',
    '    job without it',
    '  - whether it really has more than one kind of work, when the job hints at it',
    '  - when a shift could produce several pieces of work: one combined report per shift, or',
    '    each result delivered on its own',
    'Never ask about the name, budget, items per shift or the heartbeat model — the user sets',
    'those on the review form. Never ask what you can reasonably infer: pick a sensible',
    'default and name it in the summary instead. A job described fully in the first message',
    `gets a DRAFT on the first turn. After ${HIRE_INTERVIEW_MAX_ROUNDS} rounds of questions you will be told to draft.`,
  ];
}

/// The user message for a hire turn. A one-message hire reads exactly as it
/// always has; a conversation is replayed in order so the drafter sees what it
/// already asked and what the user said back.
function hireUserMessage(messages: HireMessage[]): string {
  if (messages.length === 1) return `JOB DESCRIPTION:\n${messages[0].text}`;
  return [
    'THE CONVERSATION SO FAR (the first message is the job description; after that you asked',
    'and the user answered):',
    '',
    ...messages.flatMap((m) => [m.role === 'user' ? 'USER:' : 'YOU:', hireMessageText(m).trim(), '']),
  ].join('\n');
}

/// Attached files reach the CLI through its own attachment channel, which
/// for most backends means "written to disk, path inlined" — the model sees
/// them, but nothing in the prompt says they are the user's, or that they
/// are meant to be read. This names them so a drafting turn treats them as
/// source material rather than stray context.
function attachmentAwareMessage(message: string, attachments?: Attachment[]): string {
  if (!attachments || attachments.length === 0) return message;
  const names = attachments.map((a) => a.label ?? 'an attached file');
  return [
    message,
    '',
    `ATTACHED FILES (${names.length}): ${names.join(', ')}`,
    'The user attached these to this request. Read them and treat them as source material —',
    'a spec, an example of the deliverable, or data the work is about. Where they conflict',
    'with the prose above, ask yourself which is more specific and follow that.',
  ].join('\n');
}

/// One hire turn: job description in, reviewed-not-saved contract out —
/// plus a drafted Flow when the contract asked for one. The contract's
/// summary prose rides along for the review screen. In interview mode the
/// turn may instead come back as the drafter's questions.
export async function draftWorkerFromPrompt(
  args: {
    jobDescription: string;
    flows: HireFlowOption[];
    projects: HireProjectOption[];
    /// The names already on the roster, so the drafter names in the same
    /// register and never collides with one — a duplicate name resolves to
    /// nobody at handoff time (see `resolveHandoffTarget`).
    crew?: string[];
    /// Files the user attached to the hire — a spec for the job, an example
    /// of the deliverable, a screenshot of the board to work from. They ride
    /// with BOTH turns: the contract turn and, when one runs, the flow draft.
    attachments?: Attachment[];
    /// The rest of a hire conversation, after the job description: the
    /// drafter's questions and the user's answers, in order.
    conversation?: HireMessage[];
    /// Let the drafter ask questions instead of drafting. Off, or once the
    /// conversation has used up its rounds, the turn always drafts.
    interview?: boolean;
    /// The user's MCP servers, by name, when known.
    mcpServers?: string[];
    /// Run a checking turn over the draft before any flow is designed.
    polish?: boolean;
  },
  deps: DraftDeps,
): Promise<
  | {
      ok: true;
      contract: WorkerContract;
      summary: string;
      flowPlan: HireFlowPlan;
      /// The wrap-up flow, when the contract asked for one — kept apart from
      /// `flowPlan` because the planner never routes to it.
      wrapUp?: HireFlowPlan[number];
      flowError?: string;
    }
  | { ok: true; question: string; questions?: HireQuestion[] }
  | { ok: false; error: string }
> {
  const jobDescription = args.jobDescription.trim();
  if (!jobDescription) return { ok: false, error: 'Describe the job first.' };

  const messages: HireMessage[] = [
    { role: 'user', text: jobDescription },
    ...(args.conversation ?? []).filter((m) => m.text.trim()),
  ];
  const rounds = messages.filter((m) => m.role === 'assistant').length;
  const interview = args.interview === true && rounds < HIRE_INTERVIEW_MAX_ROUNDS;

  const out = await oneShotDraftText(deps, {
    buildSystemPrompt: (backend) =>
      hireSystemPrompt(
        backend,
        args.flows,
        args.projects,
        args.crew ?? [],
        deps.settings.flowModelDefaults,
        interview,
        args.mcpServers,
      ),
    userMessage: attachmentAwareMessage(
      interview || rounds === 0
        ? hireUserMessage(messages)
        : `${hireUserMessage(messages)}\nYou have asked enough. DRAFT now: fill any gap with a sensible default and name it in the summary.`,
      args.attachments,
    ),
    attachments: args.attachments,
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

  // An interview turn with no block is the drafter asking. Anything that
  // does carry a block goes through the contract path below, parse errors
  // and all — a malformed draft must not masquerade as a question.
  if (interview && !hasWorkerBlock) {
    const asked = parseHireQuestions(out.text);
    if (asked) return { ok: true, question: asked.intro, questions: asked.questions };
    // No usable block: the questions are in the prose. Still a question.
    const question = out.text.replace(/<\/?questions>/gi, '').trim();
    if (!question) return { ok: false, error: `${out.label} returned an empty reply.` };
    return { ok: true, question };
  }

  const parseOpts = {
    knownFlowIds: args.flows.map((f) => f.id),
    defaultHeartbeatModel: drafterModelHints(out.backend, deps.settings.flowModelDefaults).fast,
    // Stamp the backend the hire actually ran on, so the model it just chose
    // stays paired with the CLI it belongs to.
    defaultHeartbeatBackend: out.backend,
    knownProjectPaths: args.projects.map((p) => p.path),
    knownMcpServers: args.mcpServers,
  };
  const drafted0 = parseWorkerContract(out.text, parseOpts);
  if (!drafted0) {
    const excerpt = out.text.replace(/\s+/g, ' ').trim().slice(0, 500);
    log('warn', 'workers.hire', `Worker contract parse failed. Reply: ${excerpt}`);
    return { ok: false, error: `${out.label} returned no parseable worker contract. Reply: ${excerpt}` };
  }
  // Keep the human half of the reply for the review screen; drop the block.
  const draftSummary = out.text.replace(/<worker>[\s\S]*$/i, '').trim();

  // Check the draft against what the user actually said before any flow is
  // designed from it — a fix to a flow request is free now and a whole
  // redraft later. Best-effort: a check that fails leaves the draft as is.
  const checked = args.polish
    ? await polishContract(
        {
          contract: drafted0,
          conversation: hireUserMessage(messages),
          systemPrompt: (backend) =>
            hireSystemPrompt(
              backend,
              args.flows,
              args.projects,
              args.crew ?? [],
              deps.settings.flowModelDefaults,
              false,
              args.mcpServers,
            ),
          parse: (text) => parseWorkerContract(text, parseOpts),
          attachments: args.attachments,
        },
        deps,
      )
    : null;
  const contract = checked?.contract ?? drafted0;
  const summary = checked?.note
    ? `${draftSummary}\n\n**Checked against your answers:** ${checked.note}`.trim()
    : draftSummary;

  // No flow named at all: fall back to one drafted from the job description
  // itself, so a first-run user with zero flows still gets a complete,
  // hireable contract.
  const routes = contract.flows.length > 0 ? contract.flows : [{ flowRequest: flowRequestFromJob(contract) }];
  // The wrap-up drafts alongside the routes (it is one more designer turn),
  // but it is not a route: it is split back out below.
  const entries: WorkerContractFlow[] = contract.wrapUp ? [...routes, contract.wrapUp] : routes;
  const wrapUpIndex = contract.wrapUp ? entries.length - 1 : -1;
  // After a conversation the designer gets the whole exchange, not just the
  // opening: an answer like "post it to #releases" is exactly the deliverable
  // detail the contract's paraphrase can drop, and it only makes sense next
  // to the question it answers.
  const authoritative = rounds > 0 ? hireUserMessage(messages) : contract.jobDescription;
  const several = routes.length > 1;

  // The new flows draft side by side: each is a full designer turn, and a
  // worker with a triage flow and a digest flow should not take twice as long
  // to review as one with a single flow.
  const drafted = await Promise.all(
    entries.map((entry) =>
      entry.flowRequest
        ? draftFlowFromPrompt(
            {
              description: flowDraftDescription(
                entry === contract.wrapUp
                  ? `${entry.flowRequest}\n\nThis is the worker's WRAP-UP flow. It runs once after a shift's work items finish; its user_prompt carries every item's title, how it ended (finished, failed, not run) and the text of what it delivered. Design it to COMBINE those results into the one deliverable described — do not redo the items' work.`
                  : [
                      entry.flowRequest,
                      ...(several && entry.when
                        ? [`This is one of ${routes.length} flows this worker routes to. It handles: ${entry.when}. Design it for that work only.`]
                        : []),
                      // Without this, each item's flow delivers on its own and
                      // the wrap-up delivers again: one message per item, plus one.
                      ...(contract.wrapUp
                        ? ["A WRAP-UP flow runs after the shift's items and combines their results — it does the delivering. Design this flow to produce this item's piece as a clean artifact, and do NOT send, post, email or publish it."]
                        : []),
                    ].join('\n\n'),
                authoritative,
              ),
              attachments: args.attachments,
            },
            deps,
          )
        : null,
    ),
  );

  const flowPlan: HireFlowPlan = [];
  let wrapUp: HireFlowPlan[number] | undefined;
  const failures: string[] = [];
  const taken = new Set(args.flows.map((f) => f.id));
  entries.forEach((entry, i) => {
    const place = (p: HireFlowPlan[number]) => {
      if (i === wrapUpIndex) wrapUp = p;
      else flowPlan.push(p);
    };
    if (entry.flowId) {
      place({ flowId: entry.flowId });
      taken.add(entry.flowId);
      return;
    }
    const result = drafted[i];
    if (!result) return;
    if (!result.ok) {
      failures.push(result.error);
      return;
    }
    const flow = result.flow;
    // Ids are slugs of the name, so two drafts — or a draft and a flow already
    // in the library — can land on the same one, and saving would overwrite.
    flow.id = uniqueFlowId(flow.id, taken);
    taken.add(flow.id);
    // The planner routes by description; the contract's "when" is written for
    // exactly that, where the designer's is written for a library card.
    if (several && entry.when && i !== wrapUpIndex) flow.description = entry.when;
    place({ flowId: flow.id, flow });
  });

  const ungranted = ungrantedServers(contract, wrapUp ? [...flowPlan, wrapUp] : flowPlan);
  const reviewSummary = ungranted.length
    ? `${summary}\n\n**Heads up:** no step in this worker's new flows is allowed to use ${ungranted.join(', ')}. It runs unattended, so those calls would be refused. Ask the AI box to grant the step that needs it (e.g. "let the first step search Gmail").`
    : summary;

  if (failures.length > 0) {
    // The contract is still reviewable — the user can pick a flow by hand.
    // Say so out loud: a silent miss here reads as "the hire worked" while
    // the review screen quietly sits on an empty flow picker.
    log('warn', 'workers.hire', `Flow draft for worker "${contract.name}" failed: ${failures.join(' | ')}`);
    return {
      ok: true,
      contract,
      summary: reviewSummary,
      flowPlan,
      ...(wrapUp ? { wrapUp } : {}),
      flowError: failures.join(' '),
    };
  }
  return { ok: true, contract, summary: reviewSummary, flowPlan, ...(wrapUp ? { wrapUp } : {}) };
}

/// Servers the worker is scoped to that none of its NEW flows lets a step
/// call. An unattended run refuses any tool its step does not list, so a
/// mailbox worker whose flow forgot to grant the mailbox fails its first
/// shift. Existing flows are not checked — they are not ours to judge, and
/// the draft does not have their steps.
function ungrantedServers(contract: WorkerContract, plan: HireFlowPlan): string[] {
  const drafted = plan.flatMap((p) => (p.flow ? [p.flow] : []));
  if (drafted.length === 0 || !contract.mcpServers?.length) return [];
  const granted = new Set(
    drafted.flatMap((f) => f.steps.flatMap((st) => st.tools.map((t) => parseMcpToolName(t)?.server ?? ''))),
  );
  // Claude names a server's tools after the server with anything outside
  // [A-Za-z0-9_-] turned into an underscore: "claude.ai Gmail" → claude_ai_Gmail.
  return contract.mcpServers.filter((name) => !granted.has(name.replace(/[^A-Za-z0-9_-]/g, '_')));
}

/// Wire form of a contract, for handing a draft back to the model. The same
/// fields the drafter emits, so the checker edits what it would have written.
function contractJson(c: WorkerContract): string {
  return JSON.stringify(
    {
      name: c.name,
      tagline: c.tagline,
      errandStarters: c.errandStarters,
      jobDescription: c.jobDescription,
      cadence: c.cadence,
      maxItemsPerShift: c.maxItemsPerShift,
      budgetUSDPerMonth: c.budgetUSDPerMonth,
      heartbeatModel: c.heartbeatModel,
      flows: c.flows,
      ...(c.wrapUp ? { wrapUp: c.wrapUp } : {}),
      ...(c.mcpServers ? { mcpServers: c.mcpServers } : {}),
      ...(c.projectPath ? { projectPath: c.projectPath } : {}),
    },
    null,
    2,
  );
}

/// One checking turn: the draft and the conversation in, a corrected draft
/// out. This is where a hire gets polished — the drafting turn is busy
/// inventing a worker, and what it drops is exactly what the user took the
/// trouble to say. Null when the check failed or found nothing to change.
async function polishContract(
  args: {
    contract: WorkerContract;
    conversation: string;
    systemPrompt: (backend: Backend) => string;
    parse: (text: string) => WorkerContract | null;
    attachments?: Attachment[];
  },
  deps: DraftDeps,
): Promise<{ contract: WorkerContract; note: string } | null> {
  const out = await oneShotDraftText(deps, {
    buildSystemPrompt: (backend) =>
      [
        args.systemPrompt(backend),
        '',
        'THIS TURN IS A REVIEW. A draft contract already exists (below). Check it against',
        'what the user said and return the corrected contract in the same <worker> shape:',
        '  - Every answer and requirement the user gave lands somewhere concrete — the job',
        '    description, a flow request, a flow\'s "when", the cadence or mcpServers. Nothing',
        '    they said is dropped, softened or contradicted.',
        '  - The job description stands alone: the worker never sees this conversation. It',
        '    says what to look at, what a good proposal contains, where output goes, and what',
        '    is off limits.',
        '  - Each flow request describes the steps and deliverable for ITS kind of work, and',
        '    the flows do not overlap.',
        '  - A wrap-up fits the job: present only if the user wants one combined result per',
        '    shift. When present, the job description says how a shift splits into items,',
        '    maxItemsPerShift is at least 2, and no route flow delivers outward — the wrap-up does.',
        '  - No invented requirements. Keep the name, budget and model unless they contradict',
        '    the user. The smallest set of edits — do not rewrite for style.',
        'Write ONE short sentence first: what you fixed, or "Nothing to fix." Then the block.',
      ].join('\n'),
    userMessage: attachmentAwareMessage(
      [args.conversation, '', 'THE DRAFT CONTRACT', '<worker>', contractJson(args.contract), '</worker>'].join('\n'),
      args.attachments,
    ),
    attachments: args.attachments,
    verb: 'check the hire',
  });
  if (!out.ok) {
    log('warn', 'workers.hire', `Contract check failed: ${out.error}`);
    return null;
  }
  const contract = args.parse(out.text);
  if (!contract) {
    log('warn', 'workers.hire', 'Contract check returned no parseable contract; keeping the draft.');
    return null;
  }
  const note = out.text.replace(/<worker>[\s\S]*$/i, '').trim();
  if (/^nothing to fix\.?$/i.test(note)) return null;
  // The check is not allowed to lose what the draft had settled: a flow list
  // or server list it forgot to repeat keeps the draft's.
  return {
    contract: {
      ...contract,
      flows: contract.flows.length > 0 ? contract.flows : args.contract.flows,
      wrapUp: contract.wrapUp ?? args.contract.wrapUp,
      mcpServers: contract.mcpServers ?? args.contract.mcpServers,
      projectPath: contract.projectPath ?? args.contract.projectPath,
      heartbeatBackend: args.contract.heartbeatBackend,
    },
    note,
  };
}

/// The flows a hire lands with, primary first: an existing flow by id, or a
/// freshly drafted one that saves together with the worker.
export type HireFlowPlan = Array<{ flowId: string; flow?: Flow }>;

function uniqueFlowId(id: string, taken: Set<string>): string {
  if (!taken.has(id)) return id;
  let n = 2;
  while (taken.has(`${id}-${n}`)) n += 1;
  return `${id}-${n}`;
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
    `(cadence: ${describeCadence(contract.cadence)}). The worker's job: ${contract.jobDescription}`,
    'Each run receives ONE self-contained candidate prompt from that job. Investigate, do the',
    'work the candidate asks for, and include a review step before anything ships. If the',
    'job ships nothing — if its deliverable IS a report, audit, or assessment — then the',
    'review findings are the raw material for that report, not a gate on it.',
  ].join(' ');
}

// ---- Revision -----------------------------------------------------------

/// A worker is two halves: the JOB DESCRIPTION (the planning half — what it
/// scans each shift, what a good proposal looks like) and its FLOW (the
/// execution half — how each approved item is carried out). A change like
/// "file an ABC ticket for every test you fix" needs BOTH: the flow gains a
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
    /// Files attached to the instruction. They ride with the routing turn AND
    /// with the flow edit it delegates to: "make the report look like this
    /// example" is unanswerable by the flow editor without the example.
    attachments?: Attachment[];
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
      : [
          '(This worker has NO FLOW yet. A flowInstruction will be handed to the flow DESIGNER,',
          'not an editor — so describe the whole flow the job needs, not a delta to an existing',
          'one.)',
          '',
        ]),
    'REQUESTED CHANGE',
    '================',
    instruction,
  ].join('\n');

  const out = await oneShotDraftText(deps, {
    buildSystemPrompt: () => reviseSystemPrompt(),
    userMessage: attachmentAwareMessage(userMessage, args.attachments),
    attachments: args.attachments,
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

  if (!flowInstruction) {
    if (!jobDescription) {
      return { ok: false, error: 'The reviser found nothing to change for that instruction.' };
    }
    return { ok: true, jobDescription, note };
  }

  // A worker with no flow yet — a hire whose flow draft failed, or one the
  // user is building by hand. "Add a step that…" has nothing to edit, so the
  // execution half gets DRAFTED rather than revised. Without this the flow
  // instruction was silently dropped and the AI box could never fill an empty
  // flow picker.
  if (!args.flow) {
    const drafted = await draftFlowFromPrompt(
      {
        description: flowDraftDescription(flowInstruction, jobDescription ?? args.jobDescription),
        attachments: args.attachments,
      },
      deps,
    );
    if (!drafted.ok) {
      log('warn', 'workers.revise', `New flow draft failed: ${drafted.error}`);
      return {
        ok: true,
        jobDescription,
        note: `${note}\n\nThis worker has no flow yet and one could not be drafted automatically (${drafted.error}). Flow instruction that was attempted: ${flowInstruction}`,
      };
    }
    return { ok: true, jobDescription, flow: drafted.flow, note };
  }

  // The flow half goes through the SAME editor the Flows tab uses — full
  // schema prompt, repairs, validation — so an AI worker revision can't
  // produce a flow state a hand edit couldn't.
  const revised = await reviseFlowFromPrompt(
    {
      yaml: serializeFlow(args.flow),
      instruction: flowInstruction,
      id: args.flow.id,
      attachments: args.attachments,
    },
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

// ---- Personalization ----------------------------------------------------

/// Read an ARRIVING worker for the parts that are about whoever sent it.
///
/// This runs on import, between the file landing and the hire click, where the
/// worker is still a draft nobody has employed. It changes nothing: it returns
/// questions, the user answers the ones they care about, and the answers go
/// back through `reviseWorkerFromPrompt` as one instruction (see
/// `personalizationInstruction`). Skipping it hires the worker exactly as sent.
///
/// The flow rides along because a borrowed worker hides its owner in BOTH
/// halves. "Post the digest to #eng-leads" is as likely to be a step's prompt
/// as a line of the job description, and a pass that only reads the prose
/// produces a worker that talks about the right channel and posts to the
/// wrong one.
function personalizeSystemPrompt(): string {
  return [
    'A user has just imported a standing WORKER that somebody else built and shared with them.',
    'A worker is a job description (what it plans each shift) plus a FLOW (how each approved',
    'item is carried out). Both were written by and for the PREVIOUS OWNER.',
    '',
    'Your only job is to find the details that are about that previous owner rather than about',
    'the work, and ask the new owner for their version of each one. Examples of what counts:',
    '  - people: who they report to, who reviews their work, who to notify, names in examples',
    '  - places: Slack channels, email addresses, repositories, projects, boards, folders',
    '  - time: working hours, timezone, when the standup is, when the week resets',
    '  - identity: their team, their company, their role, how they sign off',
    '',
    'Do NOT ask about:',
    '  - anything the new owner already controls in the app — cadence, budget, model, trust,',
    '    which project the worker watches. Those are fields on the hire form, not text.',
    '  - the method. How the worker researches, what it checks, what a good proposal contains',
    '    is the VALUE of the shared worker. It is not personal and must not be surveyed.',
    '  - details you cannot point at. Every question must quote something that literally',
    '    appears in the text you were given.',
    '',
    'Write one short plain-language sentence FIRST saying what you found (or that the worker',
    'looks generic). Then, on its own, emit EXACTLY ONE block in this shape and nothing after it:',
    '',
    '<personalize>',
    '{',
    '  "details": [',
    '    {',
    '      "key": "reports_to",',
    '      "label": "Reports to",',
    '      "found": "Dave Kim",',
    '      "question": "Who should this worker treat as the person it reports to?"',
    '    }',
    '  ]',
    '}',
    '</personalize>',
    '',
    'Rules:',
    '  - Valid JSON. An empty "details" array is a correct and useful answer for a worker that',
    '    is genuinely generic — do not invent questions to fill it.',
    '  - At most 6 details, most consequential first. This is a form somebody fills in before',
    '    they have used the worker once; a long one gets skipped entirely.',
    '  - "found" is the previous owner\'s value, quoted from the text VERBATIM.',
    '  - "label" is a short noun phrase (under 30 characters), not a sentence.',
    '  - "key" is snake_case and describes the ROLE the value plays, not the value. Reuse the',
    '    obvious names — reports_to, digest_channel, work_email, timezone, main_repo, team_name',
    '    — so the same question asked by two different workers is recognized as the same one.',
  ].join('\n');
}

/// One personalization scan. Nothing is saved and nothing is changed — see
/// `personalizeSystemPrompt`.
export async function personalizeImportedWorker(
  args: {
    name: string;
    jobDescription: string;
    /// The worker's primary flow, when the library could supply it.
    flow?: Flow;
  },
  deps: DraftDeps,
): Promise<
  { ok: true; questions: PersonalizationQuestion[]; note: string } | { ok: false; error: string }
> {
  const jobDescription = args.jobDescription.trim();
  if (!jobDescription) return { ok: false, error: 'The imported worker has no job description.' };

  // A scan, not a design: this reads two documents and quotes back what it
  // finds, which the standard tier does as well as the flagship and several
  // seconds sooner — and it runs in front of somebody who has just clicked
  // Import and is waiting to look at the form.
  const healthy = await healthyBackends(deps.settings.backendPaths);
  const backend = pickDrafterBackend({
    preferred: deps.settings.preferredBackend,
    isHealthy: (b) => healthy.has(b),
    isEnabled: (b) => deps.settings.disabledBackends[b] !== true,
  });
  const model =
    backend && backend !== 'ollama'
      ? tierDefault(backend, 'standard', deps.settings.flowModelDefaults)
      : undefined;

  const userMessage = [
    `WORKER NAME: ${args.name || '(unnamed)'}`,
    '',
    'JOB DESCRIPTION',
    '===============',
    jobDescription,
    '',
    ...(args.flow
      ? ['FLOW (YAML)', '===========', serializeFlow(args.flow), '']
      : ['(This worker arrived without a flow this library can supply — read the prose only.)', '']),
  ].join('\n');

  const out = await oneShotDraftText(deps, {
    model,
    buildSystemPrompt: () => personalizeSystemPrompt(),
    userMessage,
    verb: 'personalize',
  });
  if (!out.ok) return out;

  const questions = parsePersonalization(out.text);
  if (!questions) {
    const excerpt = out.text.replace(/\s+/g, ' ').trim().slice(0, 300);
    log('warn', 'workers.personalize', `Personalization parse failed. Reply: ${excerpt}`);
    return { ok: false, error: `${out.label} returned no parseable personalization.` };
  }
  const note = out.text.replace(/<personalize>[\s\S]*$/i, '').trim();
  return { ok: true, questions, note };
}
