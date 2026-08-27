// Making a borrowed worker yours.
//
// A shared worker arrives carrying its previous owner. The job description
// that made your friend's chief of staff useful names THEIR manager, THEIR
// standup time, THEIR Slack channel, THEIR repo — and none of it is wrong in
// a way the importer can see, because a job description reads perfectly well
// while quietly being about somebody else. The worker then runs a shift and
// posts your digest to a channel you are not in.
//
// So import gets one optional pass: a turn reads the arriving job description
// (and its flow) and names the details that are about the sender, each as a
// question. The user answers what they care about, skips the rest, and the
// answers are routed through the SAME reviser the editor's AI box uses — a
// personalization is a worker revision with the instruction written for you.
//
// Answers are also kept, as `UserProfile`, so the second borrowed worker asks
// once and pre-fills. That is the whole point of the store: an install that
// re-interrogates you on every import is a wizard, not a memory.
//
// Nothing here calls a CLI or touches disk. The turn lives in
// src/main/flows/workerDrafter.ts and the file in
// src/main/flows/userProfileStore.ts; this is the format both sides agree on.

/// One thing this install knows about its user, learned from an answer they
/// typed. Deliberately open-ended key/value rather than a fixed schema of
/// name/timezone/email: the questions are written by a model reading a job
/// description, and the details that matter for a chief of staff (who you
/// report to, when your day starts) are not the ones that matter for a
/// release nanny (which repo, which channel).
export interface ProfileFact {
  /// Slug the questions are matched against — see `profileKey`.
  key: string;
  /// Human label, as the question that taught us this phrased it.
  label: string;
  value: string;
  updatedAt: number;
}

export interface UserProfile {
  facts: ProfileFact[];
}

/// One owner-specific detail found in an arriving worker, as a question.
export interface PersonalizationQuestion {
  key: string;
  /// Short noun phrase for the form row: "Digest channel", "Reports to".
  label: string;
  /// What the FILE says — the sender's value, quoted back. Shown struck
  /// through next to the input, because the useful thing to see is not
  /// "answer a question" but "this worker currently thinks X".
  found: string;
  /// The question, in the second person.
  question: string;
  /// What the user typed, or what the profile already knew. Empty means
  /// unanswered, which means leave the worker's text alone.
  answer: string;
  /// True when `answer` came from the profile rather than from the user this
  /// time round, so the form can say where it got that.
  fromProfile?: boolean;
}

/// A profile that never grows without bound. Nothing here expires on its own
/// — a fact is replaced when a later answer contradicts it — so the cap is
/// the only pressure valve, and it is generous because facts are one line.
export const PROFILE_MAX_FACTS = 60;

/// Normalize a key so "Slack channel", "slack_channel" and "SLACK CHANNEL"
/// are one fact rather than three. The model writes these, and it will not
/// spell the same concept the same way twice across two imports.
export function profileKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

/// Pull the questions out of a personalization turn's reply.
///
/// Same shape as the hire and revise turns: prose first, then exactly one
/// tagged block. Returns null when there is no parseable block at all, and an
/// EMPTY ARRAY when the model looked and found nothing owner-specific — those
/// are different outcomes and the caller shows different things for them.
export function parsePersonalization(text: string): PersonalizationQuestion[] | null {
  const block =
    text.match(/<personalize>([\s\S]*?)<\/personalize>/i)?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!block) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.trim());
  } catch {
    return null;
  }
  const rows = (parsed as { details?: unknown })?.details;
  if (!Array.isArray(rows)) return null;

  const out: PersonalizationQuestion[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const label = typeof r.label === 'string' ? r.label.trim() : '';
    const question = typeof r.question === 'string' ? r.question.trim() : '';
    const found = typeof r.found === 'string' ? r.found.trim() : '';
    // A row with no question is a row the form cannot draw. A row with no
    // `found` is the model volunteering a detail the file does not contain,
    // which is how a personalization pass turns into a survey.
    if (!label || !question || !found) continue;
    const key = profileKey(typeof r.key === 'string' && r.key.trim() ? r.key : label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label, found, question, answer: '' });
  }
  return out;
}

/// Fill in what this install already knows. The user can still overtype every
/// row — a pre-filled answer is a suggestion, not a decision, which is why
/// `fromProfile` rides along for the form to caption.
export function prefillFromProfile(
  questions: PersonalizationQuestion[],
  profile: UserProfile | null,
): PersonalizationQuestion[] {
  if (!profile || profile.facts.length === 0) return questions;
  const known = new Map(profile.facts.map((f) => [f.key, f.value]));
  return questions.map((q) => {
    const value = known.get(q.key);
    return value ? { ...q, answer: value, fromProfile: true } : q;
  });
}

/// The answered rows, in the order the turn asked them.
export function answered(questions: PersonalizationQuestion[]): PersonalizationQuestion[] {
  return questions.filter((q) => q.answer.trim().length > 0);
}

/// Turn answers into ONE instruction for `reviseWorkerFromPrompt`.
///
/// Routing through the existing reviser rather than rewriting the job
/// description here is the load-bearing decision. A borrowed chief of staff
/// does not only name its owner in its persona text — its FLOW hardcodes the
/// sender's channel in a post step, their repo in a checkout. The reviser is
/// already the thing that decides which half of a worker a change lands on,
/// and it edits flows through the flow editor's own schema-aware pass. A
/// bespoke find-and-replace here would fix the prose and leave the machinery
/// pointed at the sender.
///
/// Returns null when nothing was answered — there is no such thing as an
/// empty revision, and asking the CLI for one burns a turn to change nothing.
export function personalizationInstruction(
  questions: PersonalizationQuestion[],
  workerName: string,
): string | null {
  const rows = answered(questions);
  if (rows.length === 0) return null;
  return [
    `This worker was shared with me by someone else, so parts of it are about THEM.`,
    `Re-point it at me. For each detail below, replace the previous owner's value with mine`,
    `everywhere it appears — in the job description and in the flow — and leave everything`,
    `else exactly as it is. This is a re-targeting, not a rewrite: do not restyle the prose,`,
    `do not add or remove steps, do not change what ${workerName || 'the worker'} does.`,
    '',
    ...rows.map((q) => `  - ${q.label}: currently "${q.found}" — mine is "${q.answer.trim()}".`),
    '',
    'If a value appears somewhere I did not mention — a second channel, a signature, an',
    'example addressed to the previous owner — re-point that too, consistently.',
  ].join('\n');
}

/// Fold answers into the profile so the next import pre-fills.
///
/// A later answer REPLACES an earlier one for the same key rather than piling
/// up: this is a record of what is true now, and two contradicting facts under
/// one key would silently pick one at prefill time. Answers that only came
/// from the profile in the first place are still written back, which is what
/// refreshes their `updatedAt` and keeps the newest-first cap meaningful.
export function rememberAnswers(
  profile: UserProfile | null,
  questions: PersonalizationQuestion[],
  now: number,
): UserProfile {
  const rows = answered(questions);
  if (rows.length === 0) return profile ?? { facts: [] };
  const replacing = new Set(rows.map((q) => q.key));
  const kept = (profile?.facts ?? []).filter((f) => !replacing.has(f.key));
  const fresh: ProfileFact[] = rows.map((q) => ({
    key: q.key,
    label: q.label,
    value: q.answer.trim(),
    updatedAt: now,
  }));
  return {
    facts: [...fresh, ...kept]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, PROFILE_MAX_FACTS),
  };
}

/// Read a profile off disk / off IPC without trusting its shape.
export function coerceProfile(raw: unknown): UserProfile {
  const facts = (raw as { facts?: unknown })?.facts;
  if (!Array.isArray(facts)) return { facts: [] };
  const rows: ProfileFact[] = [];
  for (const row of facts) {
    if (!row || typeof row !== 'object') continue;
    const f = row as Record<string, unknown>;
    const key = typeof f.key === 'string' ? profileKey(f.key) : '';
    const value = typeof f.value === 'string' ? f.value.trim() : '';
    if (!key || !value) continue;
    rows.push({
      key,
      label: typeof f.label === 'string' && f.label.trim() ? f.label.trim() : key,
      value,
      updatedAt: typeof f.updatedAt === 'number' ? f.updatedAt : 0,
    });
  }
  // Sorted BEFORE the duplicate keys collapse, so a file that somehow carries
  // two answers for one key keeps the newer one. Deduping in file order would
  // resolve a contradiction by whichever line happened to be written first.
  const out: ProfileFact[] = [];
  const seen = new Set<string>();
  for (const fact of rows.sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (seen.has(fact.key)) continue;
    seen.add(fact.key);
    out.push(fact);
  }
  return { facts: out.slice(0, PROFILE_MAX_FACTS) };
}
