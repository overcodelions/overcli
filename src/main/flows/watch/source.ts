// WatchSource — the one abstraction that makes the "stewardship tail"
// pluggable. A watch tick is a turn on the watcher participant's existing
// conversation: the model uses its OWN tools (MCP / CLI) to read the source
// and (when needed) post a reply, then emits a structured <watch_report>
// block the runtime parses.
//
// Ticks run in TWO tiers (see runtime.ts):
//   - DETECT (every tick, cheap/fast model): poll the source, diff against
//     the cursor, decide whether anything genuinely needs a reply. Posts
//     nothing. Most ticks end here ("nothing new").
//   - ANSWER (rare, participant's full model): only when detect found a real
//     question — compose and post a grounded reply.
//
// A WatchSource owns how to PHRASE each tier for its system; the shared
// safety contract + report format live here, identical across sources.

/// Inputs the runtime hands a source when building a tick prompt.
export interface WatchTickContext {
  /// What's being watched, in the source's addressing scheme. Jira key,
  /// PR URL, Zendesk id, or free text for the AI-defined source.
  binding: string;
  /// Comment ids already replied to — the dedup set. The detect pass answers
  /// any genuinely-unanswered question whose id isn't in here.
  answeredIds?: string[];
  /// A short grounding summary of the work the flow completed, so the
  /// watcher answers questions about it accurately instead of guessing.
  workSummary: string;
  /// User-written (optionally AI-drafted) natural-language description of
  /// what to watch and how to respond. The AI-defined source relies on this
  /// entirely; named presets fold it in as extra guidance.
  instructions?: string;
}

/// Context for the ANSWER pass — adds what the detect pass found, so the
/// premium model knows what it's replying to.
export interface WatchAnswerContext extends WatchTickContext {
  /// The detect pass's note describing the new item(s) that need a reply.
  detected: string;
}

/// The structured result the runtime extracts from a tick's reply. Shared
/// across sources and both tiers (fields not relevant to a tier are absent).
export interface WatchTickReport {
  /// How many comments the watcher answered this tick (ANSWER pass only).
  answered: number;
  /// Comment ids the watcher actually replied to this tick (ANSWER pass) —
  /// appended to the run's dedup set so they're never re-answered.
  answeredIds?: string[];
  /// DETECT pass: a new item needs a careful, grounded reply → escalate to
  /// the answer tier. Absent/false on the answer pass.
  answerNeeded?: boolean;
  /// DETECT pass: the watcher has NO working tool to reach the target (e.g.
  /// the source's MCP server isn't available to this model). The runtime
  /// self-heals by bumping the watch to the participant's full model.
  toolsUnavailable?: boolean;
  /// True when a comment requested real WORK (a change, a re-run, …). The
  /// watcher must NOT do it — this is the escalation-to-human signal.
  needsWork: boolean;
  /// One-line human summary of what happened this tick.
  note: string;
}

/// Shared safety preamble — the answer-only guardrail + cursor discipline +
/// the user's instructions + work grounding. Both tiers prepend this.
function safetyPreamble(ctx: WatchTickContext): string {
  const instructionLines = ctx.instructions?.trim()
    ? ['', "User's watch instructions (authoritative — follow these):", ctx.instructions.trim()]
    : [];
  const answered = ctx.answeredIds?.length ? ctx.answeredIds.join(', ') : '(none yet)';
  return [
    ...instructionLines,
    '',
    'GUARDRAIL — you are TENDING already-completed work, not doing new work:',
    '- You MUST NOT edit code, run builds/tests, move tickets, or change the',
    '  repository or the work product in any way. Do not use Write, Edit, or',
    "  mutating Bash. If you're unsure whether something counts as work, treat",
    '  it as work and flag it instead of acting.',
    '',
    'WHAT COUNTS AS NEEDING A REPLY — dedup by id, not by recency:',
    '- Scan the recent comment thread on the target.',
    `- ALREADY ANSWERED (comment ids you have already replied to): ${answered}`,
    '- A comment needs a reply if it is a genuinely-unanswered question about the',
    '  completed work AND its id is NOT in the already-answered list above.',
    '  A not-yet-answered question still counts even when newer comments exist —',
    "  don't skip it just because it isn't the latest. Skip anything already",
    '  resolved in the thread, anything in that list, and your own comments.',
    '',
    'Context on the work this watch is tending:',
    ctx.workSummary || '(no summary available)',
  ].join('\n');
}

/// The DETECT-tier contract: look only, post nothing, classify, report.
export function detectContract(ctx: WatchTickContext): string {
  return [
    safetyPreamble(ctx),
    '',
    'THIS IS A DETECT TICK — look only, do NOT reply or post anything.',
    'Your only job is to decide whether anything newer than the cursor needs a',
    'reply, then report. Be quick. When unsure whether a new item is a real',
    'question worth a careful answer, set "answer_needed": true (it is cheaper',
    'to escalate than to miss something).',
    '',
    'Emit EXACTLY ONE block, nothing after it:',
    '<watch_report>',
    '{',
    '  "answer_needed": <true if there is a genuinely-unanswered question whose',
    '                    id is NOT in the already-answered list, else false>,',
    '  "needs_work": <true if a comment requests actual work, else false>,',
    '  "tools_unavailable": <true if you have NO working tool to actually reach',
    '                        the target (the needed MCP server / integration is',
    '                        not available to you), else false>,',
    '  "note": "<one short sentence: what you saw>"',
    '}',
    '</watch_report>',
  ].join('\n');
}

/// The ANSWER-tier contract: post the grounded reply, report what you did.
export function answerContract(ctx: WatchAnswerContext): string {
  return [
    safetyPreamble(ctx),
    '',
    'THIS IS AN ANSWER TICK. A cheaper detect pass already flagged that there',
    'is a new comment worth a careful reply. What it found:',
    ctx.detected || '(see the source for the newest unanswered comment)',
    '',
    'Read the relevant new comment(s) yourself to confirm, then post a concise,',
    'professional reply ANSWERING the question — grounded in the work summary',
    'above. Reply in the same place the comment was raised. Do not do any work;',
    'if the comment actually asks for a change, do NOT make it — set needs_work.',
    '',
    'Emit EXACTLY ONE block, nothing after it:',
    '<watch_report>',
    '{',
    '  "answered": <number of comments you replied to this tick>,',
    '  "answered_ids": [<the comment id of EACH comment you replied to — these',
    '                    are recorded so they are never answered again>],',
    '  "needs_work": <true if a comment requested work you (correctly) did not',
    '                 do, else false>,',
    '  "note": "<one short sentence: what you answered>"',
    '}',
    '</watch_report>',
  ].join('\n');
}

export interface WatchSource {
  /// Stable id persisted on the run's WatchState and used to resolve the
  /// source back from the registry.
  id: string;
  /// Friendly label for the watch-entry picker.
  displayName: string;
  /// Build the cheap DETECT-tier prompt (runs every tick).
  buildDetectPrompt(ctx: WatchTickContext): string;
  /// Build the ANSWER-tier prompt (runs only when detect escalates).
  buildAnswerPrompt(ctx: WatchAnswerContext): string;
}

/// Parse the shared `<watch_report>` JSON block out of a tick reply. Lenient:
/// tolerates surrounding prose, a code fence inside the block, and missing
/// fields (which default to a safe "nothing happened" reading). Returns null
/// only when no block is present at all.
export function parseWatchReport(text: string): WatchTickReport | null {
  const m = /<watch_report>\s*([\s\S]*?)\s*<\/watch_report>/i.exec(text);
  if (!m) return null;
  const inner = m[1]
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(inner) as Record<string, unknown>;
  } catch {
    return { answered: 0, needsWork: false, note: 'Watch tick report was unparsable JSON.' };
  }
  const answered =
    typeof obj.answered === 'number' && Number.isFinite(obj.answered)
      ? Math.max(0, Math.floor(obj.answered))
      : 0;
  const note = typeof obj.note === 'string' ? obj.note.trim() : '';
  const answeredIds = Array.isArray(obj.answered_ids)
    ? obj.answered_ids.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : undefined;
  return {
    answered,
    answeredIds: answeredIds && answeredIds.length > 0 ? answeredIds : undefined,
    answerNeeded: obj.answer_needed === true,
    toolsUnavailable: obj.tools_unavailable === true,
    needsWork: obj.needs_work === true,
    note: note || (answered > 0 ? `Answered ${answered} comment(s).` : 'No new comments.'),
  };
}

const SOURCES = new Map<string, WatchSource>();

export function registerWatchSource(source: WatchSource): void {
  SOURCES.set(source.id, source);
}

/// Resolve a source by id, falling back to the AI-defined source so a run
/// persisted under a since-removed preset still ticks.
export function getWatchSource(id: string): WatchSource {
  return SOURCES.get(id) ?? SOURCES.get('ai') ?? aiFallback;
}

export function listWatchSources(): Array<{ id: string; displayName: string }> {
  return Array.from(SOURCES.values()).map((s) => ({ id: s.id, displayName: s.displayName }));
}

/// Last-ditch source used only if even 'ai' isn't registered yet (it always
/// is, via ./generic). Kept tiny and self-contained.
const aiFallback: WatchSource = {
  id: 'ai',
  displayName: 'AI-defined watch',
  buildDetectPrompt: (ctx) =>
    [
      `Watch target: ${ctx.binding || '(see instructions)'}.`,
      'Check it for responses newer than the cursor using whatever tools you have.',
      detectContract(ctx),
    ].join('\n'),
  buildAnswerPrompt: (ctx) =>
    [
      `Watch target: ${ctx.binding || '(see instructions)'}.`,
      answerContract(ctx),
    ].join('\n'),
};
