// A picture for a new worker, picked for it: a short model turn names what
// to look for (a role, a fitting animal or mascot), overcli searches the
// Fluent pictures for it, and a second turn picks the one that suits the job
// best. A pass that finds nothing fitting tries other words, twice at most.
// Nothing here is shown a picture: Fluent's names say what each one is.

import { searchPictures } from '../../shared/flows/avatars';
import { FLUENT_EMOJI } from '../../shared/flows/fluentEmoji';

/// One model turn: system prompt and message in, its text out (null: none).
export type PictureAsk = (system: string, message: string) => Promise<string | null>;

const TERMS_SYSTEM = [
  'You choose a picture for an AI worker at a company, from a library of about 1,600 3D emoji-style pictures',
  'named the way emoji are: people by role ("Woman technologist", "Detective", "Scientist", "Judge", "Teacher",',
  '"Office worker", "Pilot"), animals ("Owl", "Fox", "Penguin"), and things ("Magnifying glass", "Bar chart", "Rocket").',
  'Suggest single words to search those names for, best first: the role that matches the job, then a fitting',
  'animal or mascot, then an object that stands for the work. A person or an animal reads best as a colleague.',
  'Answer with JSON only, no prose and no code fence: {"terms": ["word", "word", ...]} with 4 to 6 words.',
].join('\n');

const PICK_SYSTEM = [
  'You choose a picture for an AI worker at a company from a numbered list of picture names.',
  'Pick the one that best suits its job and would read well as its face in Slack: a person by a matching role,',
  'or an animal or mascot that fits, before an object. Skip anything silly, rude, sad or off-topic for work.',
  'If nothing on the list suits it, say so.',
  'Answer with JSON only, no prose and no code fence: {"pick": <its number, or null>}',
].join('\n');

function json(text: string | null): Record<string, unknown> | null {
  const m = text ? /\{[\s\S]*\}/.exec(text) : null;
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/// The picture's link, or null when two passes found nothing that suits.
/// `taken`: links other workers already have, which it won't reuse.
export async function pickPicture(ask: PictureAsk, worker: { name: string; job: string; tagline?: string }, taken: readonly string[] = []): Promise<string | null> {
  const about = `The worker: ${worker.name}${worker.tagline ? ` — ${worker.tagline}` : ''}\nIts job: ${worker.job.replace(/\s+/g, ' ').slice(0, 1200)}`;
  const tried = new Set<string>();
  for (let pass = 0; pass < 2; pass++) {
    const asked = json(await ask(TERMS_SYSTEM, pass === 0 ? about : `${about}\n\nThese found nothing that suited it, so suggest different words: ${[...tried].join(', ')}`));
    const terms = (Array.isArray(asked?.terms) ? asked!.terms : []).filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter((t) => t && !tried.has(t)).slice(0, 6);
    if (!terms.length) return null;
    terms.forEach((t) => tried.add(t));
    const seen = new Set<string>(taken);
    const found = terms.flatMap((t) => searchPictures(FLUENT_EMOJI, t, 8)).filter((p) => !seen.has(p.url) && (seen.add(p.url), true)).slice(0, 40);
    if (!found.length) continue;
    const list = found.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
    const picked = json(await ask(PICK_SYSTEM, `${about}\n\nPictures:\n${list}`));
    const n = typeof picked?.pick === 'number' ? picked.pick : typeof picked?.pick === 'string' ? Number(picked.pick) : NaN;
    if (Number.isInteger(n) && found[n - 1]) return found[n - 1].url;
  }
  return null;
}
