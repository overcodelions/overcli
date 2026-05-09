// Single source of truth for the rebound preset library — preset
// definitions, persona prompt preambles, and per-CLI tier maps.
//
// The renderer uses RESOLVED_PRESETS to populate the preset picker and
// to translate a preset selection into concrete reviewer config
// (backend / model / persona / mode). The runner uses PERSONA_PREAMBLES
// at prompt-build time to prepend the persona text. Storing the persona
// KEY (not the body) in conversation state means we can iterate on
// wording without migrating saved conversations.

import { Backend, EffortLevel, PersonaKey, ReviewPreset } from './types';

/// Cheap and smart model ids per CLI. Ollama has no canonical tiers, so
/// the tier-based presets are disabled for it (renderer greys them out).
/// Keep these as the literal flag values the CLIs accept — they're
/// passed straight through to `--model X` (claude) or `-m X` (codex,
/// gemini). Update here when models rotate; no other file should know.
export const TIERS: Partial<Record<Backend, { cheap: string; smart: string }>> = {
  claude: { cheap: 'claude-sonnet-4-6', smart: 'claude-opus-4-7' },
  codex: { cheap: 'gpt-5.4-mini', smart: 'gpt-5.5' },
  gemini: { cheap: 'gemini-3.1-flash-lite', smart: 'gemini-3.1-pro' },
};

// Always emit at least one line — without this hard rule the model
// sometimes ends the turn silently after extended thinking, leaving
// the verdict card empty.
const ALWAYS_RESPOND =
  ' You MUST always reply with at least one sentence; never end your turn silently.';

// Appended to personas where we want visible reasoning. Tested: claude
// will NOT reliably emit thinking content blocks even at --effort high
// for review-style prompts (the model decides quick checks don't need
// extended thinking). Asking it to "list what you checked" in its text
// response works much better — the reasoning shows up in the visible
// verdict text as a numbered list / sections, which renders cleanly
// through the existing Markdown component. Trade-off: verdict text is
// longer; we updated isAllGoodReviewerResponse to check the LAST line
// so "Looks complete." at the end of a structured response still
// short-circuits the feedback round.
const SHOW_YOUR_WORK =
  ' List the specific checks you considered (one per line) before your verdict, then end with the verdict on its own final line.';

// For personas that need to actually inspect code. The reviewer CLI is
// invoked with --allowedTools whitelisting Read/Grep/Glob/git Bash, so
// these instructions are honored. Without the nudge the model often
// just trusts the assistant's summary; with it, the model opens files
// and runs git diff to ground each finding in actual code.
const USE_TOOLS_TO_VERIFY =
  ' You can read files (Read), search code (Grep, Glob), and inspect changes via Bash (git diff/log/show/status). Use them — do NOT just trust the assistant\'s description of what changed. Open the affected files, run `git diff` to see the actual edits, and ground every finding in real code.';

/// Per-persona reasoning effort. Most reviewers (half-finished, critic,
/// skeptical-user) are doing pattern-matching / quick-judgment work and
/// run fine on `low` — keeps cost predictable and stops the model from
/// burning its output budget on extended thinking. Security review is
/// the exception: subtle bugs (race conditions, auth bypass paths,
/// deserialization gotchas) genuinely benefit from deeper analysis, so
/// it gets `medium`. Applied to claude via `--effort` and to codex via
/// the app-server `effortLevel` param. Gemini has no equivalent flag,
/// so the value is ignored on that path.
export const PERSONA_EFFORT: Record<PersonaKey, EffortLevel> = {
  // 'high' is the floor where claude actually emits thinking content
  // blocks via stream-json — at low/medium the model thinks internally
  // but emits only the final text, so we'd pay for invisible reasoning.
  // High costs more per review but the user can SEE what was checked,
  // which is the whole point of the visible-work UX.
  'half-finished': 'high',
  security: 'high',
  // Critic powers cheap-and-paranoid, where the cost story is the whole
  // pitch. Bumping to high would balloon cost (Opus + extended thinking
  // every turn). Kept low; users who want visible critique should
  // pick a different preset.
  critic: 'low',
  // Skeptical-user is same-CLI same-tier, so the cost bump from low →
  // high is modest (no Opus tax). Worth the visibility for "did it do
  // what I asked?" which is the kind of judgment call that benefits
  // from seeing the model's reasoning.
  'skeptical-user': 'high',
  // Design judgment is hard — needs thinking budget for the model to
  // actually weigh trade-offs vs. just naming surface issues.
  design: 'high',
};

/// User-facing label + one-line description for each persona. Single
/// source of truth for the persona picker UI — without this, each
/// picker has to hand-code the list and adding a new persona silently
/// misses any picker we forgot to update (this exact bug landed when
/// `design` was added to the table but not to the conversation-header
/// picker until a reviewer caught it).
export const PERSONA_DISPLAY: Record<PersonaKey, { label: string; description: string }> = {
  'half-finished': { label: 'Half-finished', description: 'Stubs, TODOs, missed branches.' },
  security: { label: 'Security', description: 'Injection, auth bypass, secrets.' },
  critic: { label: 'Critic', description: 'Direct, specific feedback.' },
  'skeptical-user': { label: 'Skeptical user', description: 'Did it answer the actual ask?' },
  design: { label: 'Design', description: 'Architecture, abstractions, naming.' },
};

/// Personas that only make sense when the assistant turn actually
/// changed code. Without diffs, half-finished and security have nothing
/// to evaluate — they'd just emit "Looks complete." / "No issues" and
/// burn tokens. Other personas (skeptical-user, critic, design) work
/// fine on text-only turns (architectural discussions, scope-creep
/// checks, etc.) so they always fire.
export const PERSONA_REQUIRES_CODE_CHANGES: Record<PersonaKey, boolean> = {
  'half-finished': true,
  security: true,
  critic: false,
  'skeptical-user': false,
  design: false,
};

/// True when the just-completed turn invoked at least one code-mutating
/// tool (Edit/Write/MultiEdit/Patch/NotebookEdit). Used by runner hooks
/// to short-circuit reviewers whose persona requires code changes when
/// the turn was text-only.
export function didMutateCode(toolActivity: string[]): boolean {
  return toolActivity.some(
    (line) =>
      line.startsWith('• Edit ') ||
      line.startsWith('• Write ') ||
      line.startsWith('• MultiEdit ') ||
      line.startsWith('• Patch ') ||
      line.startsWith('• NotebookEdit '),
  );
}

/// The "all good" template each persona prompt instructs the reviewer
/// to use when there's nothing to flag. Used by isAllGoodReviewerResponse
/// to detect a no-op review and skip the feed-back-to-primary round.
/// Phrases are matched case-insensitively after trimming trailing
/// punctuation/whitespace, so the model can wrap them in a sentence
/// boundary without breaking detection.
/// The "all good" phrase a persona uses when there's nothing to flag.
/// Lowercased, no trailing punctuation. Exported so the reviewer can
/// synthesize it as a fallback when the model emits zero content
/// blocks but exits successfully (Opus on `--effort low` does this
/// occasionally — it's saying "nothing to add" by saying nothing at
/// all, which our UI would otherwise render as "(no output)").
const ALL_GOOD_PHRASES: Record<PersonaKey, string> = {
  'half-finished': 'looks complete',
  security: 'no security issues found',
  critic: 'looks fine',
  'skeptical-user': 'matches the ask',
  design: 'design looks sound',
};

/// True when a reviewer's text is essentially the persona's "all good"
/// template — possibly with a brief elaboration, but with no actionable
/// feedback. The runner uses this to skip the synthetic feed-back-to-
/// primary prompt when there's nothing to engage with. Without this
/// check, a "Looks fine." review still triggers a primary turn that
/// has to fabricate a response, wasting tokens (real money on
/// cheap-and-paranoid where every primary turn is Sonnet → Opus →
/// Sonnet).
/// User-facing "all good" verdict text for a persona, properly cased
/// and punctuated. Used by the reviewer to synthesize a meaningful
/// verdict when the model exits with no content blocks (rare but real
/// — Opus on low effort sometimes ends the turn silently when it has
/// nothing to add). The synthesized text passes through
/// `isAllGoodReviewerResponse` normally so the synthetic feedback
/// round still gets correctly skipped.
export function defaultAllGoodVerdict(persona: PersonaKey): string {
  const phrase = ALL_GOOD_PHRASES[persona];
  if (!phrase) return 'Looks fine.';
  return phrase.charAt(0).toUpperCase() + phrase.slice(1) + '.';
}

export function isAllGoodReviewerResponse(
  text: string,
  persona: PersonaKey | null | undefined,
): boolean {
  if (!persona) return false;
  const phrase = ALL_GOOD_PHRASES[persona];
  if (!phrase) return false;
  // Reviewer prompts now ask the model to "list checks then verdict on
  // own final line," so the all-good template usually arrives at the
  // END of a longer structured response. Inspect just the last
  // non-empty line: lowercase, drop common verdict-prefix words like
  // "verdict:" / "conclusion:", strip trailing punctuation, then match
  // against the persona's phrase. Length guard rejects substantive
  // last-line responses (e.g. "Issue: missing null check on line 42").
  const lines = text
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  const lastLine = lines[lines.length - 1] ?? '';
  const normalized = lastLine
    .toLowerCase()
    .replace(/^(verdict|conclusion|result|status)\s*:\s*/, '')
    .replace(/[.!?\s]+$/, '');
  if (normalized.length > 80) return false;
  return normalized === phrase || normalized.startsWith(phrase) || normalized.endsWith(phrase);
}

export const PERSONA_PREAMBLES: Record<PersonaKey, string> = {
  'half-finished':
    'You are reviewing the assistant turn below for incomplete work only. Look for stubs, TODO/FIXME markers, dead branches, missing return paths, half-applied refactors, and edits that reference functions or files that don\'t exist. Ignore style, naming, and architectural opinions. If everything is wired up, say "Looks complete." in one line.' +
    ALWAYS_RESPOND +
    USE_TOOLS_TO_VERIFY +
    SHOW_YOUR_WORK,
  security:
    'You are reviewing the assistant turn below as a security reviewer. Flag injection (SQL/shell/template), auth bypass, secrets in logs or files, unsafe deserialization, missing input validation at trust boundaries, and overly permissive access. Ground each finding in a specific line of the diff. No generic advice. If you find nothing, say "No security issues found." in one line.' +
    ALWAYS_RESPOND +
    USE_TOOLS_TO_VERIFY +
    SHOW_YOUR_WORK,
  critic:
    'You are reviewing the assistant turn below as a critic. Be direct: name specific issues and suggest fixes in 1-2 sentences each. If it looks fine, say "Looks fine." in one sentence. No preamble, no generic advice.' +
    ALWAYS_RESPOND +
    USE_TOOLS_TO_VERIFY,
  'skeptical-user':
    'You are the user reading the assistant\'s turn below. Did the assistant do what was actually asked, or something adjacent? Flag scope creep, missed asks, over-engineering, and unrequested changes. If the turn matches the ask, say "Matches the ask." in one line.' +
    ALWAYS_RESPOND +
    USE_TOOLS_TO_VERIFY +
    SHOW_YOUR_WORK,
  design:
    'You are reviewing the assistant turn below for design and architecture. Evaluate the choice of abstractions, separation of concerns, naming, API ergonomics, and whether the chosen approach matches the problem\'s actual shape. Suggest design alternatives where the chosen approach is questionable. Skip implementation details (style, syntax, formatting) — those belong to other reviewers. If the design is sound, say "Design looks sound." in one line.' +
    ALWAYS_RESPOND +
    USE_TOOLS_TO_VERIFY +
    SHOW_YOUR_WORK,
};

/// Concrete preset definition. `backend: 'same'` means "use the
/// primary's CLI as the reviewer" — the resolver substitutes the
/// primary backend at selection time. `tier: 'smart' | 'cheap'` looks
/// up TIERS[backend] at selection time and writes the model string.
/// `requiresPrimary` lets a preset declare it only makes sense with a
/// specific primary tier (e.g. cheap-paranoid wants Haiku/Sonnet, not
/// Opus already running everything).
export interface PresetSpec {
  key: ReviewPreset;
  label: string;
  description: string;
  /// 'same' = use the primary's CLI as the reviewer (persona shift only).
  /// 'different' = pick any installed CLI that isn't the primary, in the
  /// preference order codex → claude → gemini. Used by 'independent' so
  /// the reviewer is genuinely a different reasoning lineage no matter
  /// which CLI you've picked as primary.
  /// Or a literal Backend value when a preset hard-codes one.
  backend: 'same' | 'different' | Backend;
  tier?: 'cheap' | 'smart' | null;
  persona: PersonaKey | null;
  mode: 'review' | 'collab';
  /// One-line "use this when…" guidance shown on the welcome-pane card
  /// so users don't have to know the persona/cost story by heart.
  /// Different from `description` (what it does) — this is when to use it.
  bestFor: string;
  /// Relative per-review cost. Drives the dot indicator on the preset
  /// card so users see at a glance whether a preset is cheap or pricey
  /// before opting in. low = same model, low effort. medium = same
  /// model with extra effort, or persistent codex thread. high =
  /// smart-tier reviewer (Opus/GPT-5.4-pro) per turn.
  relativeCost: 'low' | 'medium' | 'high';
  /// When set, the preset is only enabled if the primary's current
  /// model matches one of these tiers. Used by cheap-paranoid to gate
  /// itself on a non-smart primary so the upgrade actually means
  /// something.
  requiresPrimaryTier?: 'cheap' | 'cheap-or-mid';
}

export const PRESETS: PresetSpec[] = [
  {
    key: 'half-finished',
    label: 'Half-finished work check',
    description: 'Same model. Looks for stubs, TODOs, missed branches. Cheap.',
    bestFor: 'Risky changes, refactors. Skip for quick iteration.',
    relativeCost: 'low',
    backend: 'same',
    tier: null,
    persona: 'half-finished',
    mode: 'review',
  },
  {
    key: 'security',
    label: 'Security review',
    description: 'Smarter model reads the diff for vulnerabilities.',
    bestFor: 'Anything touching auth, input handling, or secrets.',
    relativeCost: 'high',
    backend: 'same',
    tier: 'smart',
    persona: 'security',
    mode: 'review',
  },
  {
    key: 'cheap-paranoid',
    label: 'Cheap-and-paranoid',
    description: 'Cheap primary writes; smart reviewer checks every turn.',
    bestFor: 'When you live on Sonnet primary and want a hedge.',
    relativeCost: 'high',
    backend: 'same',
    tier: 'smart',
    persona: 'critic',
    mode: 'review',
    requiresPrimaryTier: 'cheap',
  },
  {
    key: 'skeptical-user',
    label: 'Skeptical user',
    description: '"Did it actually do what I asked?" Catches scope creep.',
    bestFor: 'When work might drift from the original ask.',
    relativeCost: 'low',
    backend: 'same',
    tier: null,
    persona: 'skeptical-user',
    mode: 'review',
  },
  {
    key: 'design-review',
    label: 'Design review',
    description: 'Smart model evaluates architecture, abstractions, and approach.',
    bestFor: 'New modules, refactor proposals, approach discussions.',
    relativeCost: 'high',
    backend: 'same',
    tier: 'smart',
    persona: 'design',
    mode: 'review',
  },
  {
    key: 'independent',
    label: 'Independent second opinion',
    description: 'Different CLI for fully independent reasoning.',
    bestFor: 'High-stakes work where a different reasoning lineage matters.',
    relativeCost: 'medium',
    backend: 'different',
    tier: null,
    persona: 'critic',
    mode: 'review',
  },
];

export interface ResolvedPreset {
  reviewBackend: Backend;
  reviewMode: 'review' | 'collab';
  reviewModel: string | null;
  reviewPersona: PersonaKey | null;
}

/// Preference order used by `'different'` presets when picking a
/// non-primary CLI for the reviewer. We try cloud CLIs (codex, claude,
/// gemini) before ollama because the "different reasoning lineage"
/// story is much weaker for a local model. Order within cloud CLIs is
/// arbitrary — codex first because that was the original hardcoded
/// choice.
const DIFFERENT_BACKEND_PREFERENCE: Backend[] = ['codex', 'claude', 'gemini', 'ollama'];

function pickDifferentBackend(primary: Backend): Backend | null {
  for (const b of DIFFERENT_BACKEND_PREFERENCE) {
    if (b !== primary) return b;
  }
  return null;
}

/// Translate a preset selection into concrete reviewer config for the
/// given primary backend. Returns null when the preset can't resolve
/// (e.g. tier preset on Ollama where TIERS has no entry, or a
/// 'different' preset when the primary is the only available CLI) —
/// caller should treat that as "preset disabled, leave settings
/// unchanged".
export function resolvePreset(
  presetKey: ReviewPreset,
  primaryBackend: Backend,
): ResolvedPreset | null {
  if (presetKey === 'custom') return null;
  const spec = PRESETS.find((p) => p.key === presetKey);
  if (!spec) return null;

  let backend: Backend;
  if (spec.backend === 'same') {
    backend = primaryBackend;
  } else if (spec.backend === 'different') {
    const picked = pickDifferentBackend(primaryBackend);
    if (!picked) return null;
    backend = picked;
  } else {
    backend = spec.backend;
  }

  const tierMap = TIERS[backend];
  // Tier-based preset on a CLI with no tier table (ollama): can't
  // resolve, signal disabled.
  if (spec.tier && !tierMap) return null;
  const reviewModel = spec.tier && tierMap ? tierMap[spec.tier] : null;

  return {
    reviewBackend: backend,
    reviewMode: spec.mode,
    reviewModel,
    reviewPersona: spec.persona,
  };
}

/// Used by the renderer to decide whether to disable cheap-paranoid
/// for a primary that's already on the smart tier. Returns the tier
/// the given model string sits on, or null if we don't recognise it
/// (treat unknown as "passes any gate" so we don't lock users out).
export function modelTier(
  backend: Backend,
  model: string | null | undefined,
): 'cheap' | 'smart' | null {
  if (!model) return null;
  const tierMap = TIERS[backend];
  if (!tierMap) return null;
  if (model === tierMap.cheap) return 'cheap';
  if (model === tierMap.smart) return 'smart';
  return null;
}
