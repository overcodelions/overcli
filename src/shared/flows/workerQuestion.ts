// How a flow step's "I need a decision" turn is recognised, and how that
// recorded question is matched back to the message that asked it.
//
// This lives in shared because BOTH sides need the same rule and they used to
// each have their own. The runtime recorded the LAST PARAGRAPH of an untagged
// question, while the renderer's timeline matcher proposed the WHOLE message —
// so any multi-paragraph question failed to match, and its answer fell out of
// the transcript into the trailing fallback list at the bottom of the pane.
// One rule, one place.

/// Pull the question out of an assistant turn that is asking the owning
/// Worker to decide something. Prefers the explicit protocol tag. The narrow
/// question-mark fallback keeps older flows useful: only a missing-output
/// final response that ends as a direct question is promoted, never incidental
/// questions inside prose.
export function extractWorkerQuestion(text: string): string | null {
  const tagged = text.match(/<worker_question\b[^>]*>([\s\S]*?)<\/worker_question\s*>/i)?.[1]?.trim();
  if (tagged) return tagged.slice(0, 4_000);
  const last = plainTextQuestion(text);
  return last === null ? null : last;
}

/// Every string an assistant turn could have been RECORDED as, for matching a
/// persisted exchange back to the event that asked it. Superset of
/// `extractWorkerQuestion` on purpose: the untagged case also offers the whole
/// cleaned message, so exchanges written by builds that recorded it that way
/// still find their event instead of falling to the bottom of the pane.
export function workerQuestionCandidates(text: string): string[] {
  const tagged = [...text.matchAll(/<worker_question\b[^>]*>([\s\S]*?)<\/worker_question\s*>/gi)]
    .map((match) => match[1]?.trim())
    .filter((question): question is string => !!question);
  if (tagged.length > 0) return tagged;
  const last = plainTextQuestion(text);
  if (last === null) return [];
  const cleaned = text.trim();
  return last === cleaned ? [cleaned] : [last, cleaned];
}

/// Normalized form used for equality between a recorded question and a
/// candidate pulled from transcript text — whitespace and case differ freely
/// between a live event and a CLI history replay.
export function normalizedWorkerQuestion(question: string): string {
  return question.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/// The legacy fallback, shared by both readers above. Deliberately plain text:
/// regex-based tag removal is not a sanitizer, so marked-up responses must use
/// the explicit worker_question protocol rather than being reinterpreted here.
function plainTextQuestion(text: string): string | null {
  if (text.includes('<') || text.includes('>')) return null;
  const cleaned = text.trim();
  if (!cleaned.endsWith('?')) return null;
  const paragraphs = cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paragraphs.at(-1) ?? '';
  if (!last.endsWith('?') || last.length > 4_000) return null;
  return last;
}
