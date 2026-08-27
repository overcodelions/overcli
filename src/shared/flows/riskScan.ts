// Best-effort heuristic risk scan for a flow definition.
//
// WHAT THIS IS NOT: a security boundary. It is a set of plain-text regexes over
// a step's own prompt and tool list. It will MISS real risk — anything
// obfuscated (base64, zero-width characters, homoglyphs), anything expressed in
// a language these patterns don't spell, anything the model is talked into by a
// file it reads at runtime — and it will sometimes FLAG BENIGN FLOWS, because a
// prompt that says "never read ~/.ssh" contains the same bytes as one that says
// "read ~/.ssh". Treat every finding as "a human should look at this line",
// never as "this is malicious" or (worse) "no finding means this is safe".
// Nothing here is allowed to block an install; callers surface findings and the
// user decides.
//
// WHY IT EXISTS: a flow installed from a registry is a set of instructions that
// later runs with real tool access — shell, file edits, network. Until this
// module, the only checks between "fetched some YAML off the internet" and
// "wrote it into the user's flow library" were a SHA-256 integrity check (which
// proves the bytes match the listing, not that the listing is safe) and
// `validateFlow` (which is purely structural: ids, required fields, model
// support). Nothing read the actual instructions. 2026 reporting on agent-skill
// marketplaces puts double-digit percentages of community-published skills in
// the malicious bucket, and the canonical shape — a plausible description over a
// prompt that reads a credential file and POSTs it somewhere — is exactly what
// the two categories below look for.
//
// RELATIONSHIP TO `resolveStepEffect` (src/main/flows/runtime.ts): that function
// is the runtime's own regex classifier, and it deliberately does NOT trust
// `effect: 'local'` — it re-infers from the prompt and can upgrade a step to
// 'external'. But its detectors hunt for push/deploy/message/ticket verbs, and
// none of them mention curl, wget, nc, scp, or an HTTP POST. Its other guard is
// tool-based and fails closed on anything outside a read-only allowlist. So a
// step declaring `effect: local` with `tools: [Read]` and an exfiltration
// instruction in its prompt resolves to 'local' and no pause fires. That gap is
// what `egress-effect-mismatch` below is for. This module lives in `shared` and
// cannot import from `main`, so the vocabulary overlap is deliberate, not reuse.

import type { Flow, FlowStep } from './schema';

export interface FlowRiskFinding {
  /// The `FlowStep.id` the finding belongs to, so a caller can say which step.
  stepId: string;
  /// `high` — the pattern only really has a hostile reading, or the step's own
  /// `effect` declaration contradicts what its prompt says it does.
  /// `medium` — the same pattern with weaker context (e.g. no `effect`
  /// declared at all, where the runtime's own inference already covers more).
  severity: 'high' | 'medium';
  /// Stable slug for grouping/filtering. Kept a plain string on the type so
  /// adding a category later is not a breaking change for callers.
  category: string;
  /// One sentence, addressed to the person deciding whether to install.
  message: string;
}

/// The step fields this scan reads. Declared as a `Pick` rather than a full
/// `FlowStep` so the runtime can scan a partially-typed step on the pause path
/// without constructing one.
export type ScannableStep = Pick<
  FlowStep,
  'id' | 'systemPromptOverride' | 'tools' | 'effect'
>;

/// Credential and secret paths. Each entry pairs the pattern with the plain
/// English the message uses, so the finding names what was seen rather than
/// echoing a regex at the user.
const SENSITIVE_PATHS: Array<{ re: RegExp; what: string }> = [
  // `~/.ssh`, `$HOME/.ssh`, or a bare `.ssh/` path segment. The leading
  // alternation keeps it off words that merely end in "ssh".
  { re: /(?:~|\$HOME)?\/\.ssh\b|(?:^|[\s'"`(])\.ssh\//i, what: 'an SSH key directory (~/.ssh)' },
  // Private key filenames, in the three shapes ssh-keygen actually emits.
  { re: /\bid_(?:rsa|ed25519|ecdsa)\b/i, what: 'a private SSH key file (id_rsa)' },
  { re: /\.aws\/credentials\b/i, what: 'AWS credentials (.aws/credentials)' },
  // `.npmrc` / `.netrc` hold bearer tokens and passwords. Anchored on a
  // separator so `foo.npmrc-example` in prose doesn't trip it.
  { re: /(?:^|[\s'"`(\/])\.npmrc\b/i, what: 'the npm auth file (.npmrc)' },
  { re: /(?:^|[\s'"`(\/])\.netrc\b/i, what: 'the netrc credential file (.netrc)' },
  { re: /\.git-credentials\b/i, what: 'stored git credentials (.git-credentials)' },
  { re: /\/etc\/passwd\b/i, what: 'the system account file (/etc/passwd)' },
];

/// A `.env` file READ specifically. `.env` is far too common a token to flag on
/// its own — "environment", "the .env is gitignored", a step that merely names
/// the file — so this requires a read/exfiltrate verb within a short window
/// BEFORE it. `[^.\n]` in the gap is load-bearing: it stops the window from
/// spanning another dotted token, which is what would let "read the docs.
/// The .env..." match across a sentence boundary.
const ENV_FILE_READ =
  /\b(?:cat|read|open|load|source|less|head|tail|dump|print|show|exfiltrate|upload|send|copy)\b[^.\n]{0,40}(?:^|[\s'"`(\/])\.env\b/i;

/// Network egress primitives. These are the ways a prompt tells an agent to
/// move bytes off the machine without going through a declared tool.
const EGRESS: Array<{ re: RegExp; what: string }> = [
  { re: /\bcurl\b/i, what: 'curl' },
  { re: /\bwget\b/i, what: 'wget' },
  // The spec's `nc ` — netcat. `\b` before `nc` means a preceding word
  // character blocks the match, so "Inc ", "sync ", "func " are all safe.
  { re: /\bnc\s+/i, what: 'nc (netcat)' },
  { re: /\bscp\b/i, what: 'scp' },
  { re: /\bwebhook\b/i, what: 'a webhook' },
  // An HTTP POST to a URL, in either word order. The bounded gap keeps
  // "post a summary" and an unrelated URL two paragraphs later apart.
  { re: /\bPOST\b[^\n]{0,60}\bhttps?:\/\//i, what: 'an HTTP POST' },
  { re: /\bhttps?:\/\/[^\s]{0,60}[^\n]{0,40}\bPOST\b/i, what: 'an HTTP POST' },
];

/// Strip clauses that PROHIBIT the thing we are looking for, from the negation
/// to the end of that sentence. A prompt saying "Do NOT shell out to curl —
/// call the MCP tools" contains the same bytes as one telling the agent to
/// curl, and flagging it is noise: it is a step being careful, which is the
/// opposite of what this scan is for. Found against a real flow library, where
/// it was the only false positive in 46 flows.
///
/// `resolveStepEffect` (src/main/flows/runtime.ts) does exactly this for its
/// own detectors and for the same reason, but it stops the strip at the next
/// `.` of any kind. That is wrong here: the things this module hunts for ARE
/// dotted (`~/.ssh`, `.aws/credentials`), so "Never read ~/.ssh/id_rsa." would
/// strip only as far as `~/` and then flag the rest. The clause therefore runs
/// to a real sentence end — a period followed by whitespace, or end of line.
///
/// The obvious evasion — "never read ~/.ssh (unless asked)" — works. That is
/// an accepted cost: this is a heuristic that has to survive contact with
/// careful, well-written prompts, and a scan nobody trusts because it cries
/// wolf gets ignored, which protects no one.
const NEGATED_CLAUSE =
  /\b(?:do\s+not|don'?t|never|must\s+not|avoid|refrain\s+from)\b[^\n]{0,60}?\b(?:curl|wget|nc|scp|shell\s+out|webhook|post|read|open|cat|access|touch|use|send|upload)\b(?:(?!\.\s|\.$)[^\n])*/gim;

/// Scan one step. Exported separately from `scanFlowRisks` so the runtime can
/// ask about a single step on the pre-step pause path without re-scanning the
/// whole flow on every step transition.
export function scanStepRisks(step: ScannableStep): FlowRiskFinding[] {
  const findings: FlowRiskFinding[] = [];
  // The corpus is the step's own instructions plus its declared tools. Tool ids
  // are included because a scoped bash tool (`Bash(curl:*)`) carries the same
  // signal as the prompt naming curl, and both are author-controlled text.
  const raw = [step.systemPromptOverride ?? '', ...(step.tools ?? [])].join('\n');
  if (!raw.trim()) return findings;
  const text = raw.replace(NEGATED_CLAUSE, ' ');

  for (const { re, what } of SENSITIVE_PATHS) {
    if (re.test(text)) {
      findings.push({
        stepId: step.id,
        severity: 'high',
        category: 'sensitive-path',
        // Deliberately says nothing about installing: the same finding is
        // shown on a registry preview, on an install, and after a plain save
        // in the builder. "Before you run this" is the one phrasing that is
        // true on all three surfaces.
        message: `Prompt references ${what}. Check what this step does before you run it.`,
      });
    }
  }
  if (ENV_FILE_READ.test(text)) {
    findings.push({
      stepId: step.id,
      severity: 'high',
      category: 'sensitive-path',
      message: 'Prompt appears to read a .env file, which usually holds secrets.',
    });
  }

  // Egress is only interesting when it disagrees with what the step CLAIMS to
  // do. A step that honestly declares `effect: external` is already handled by
  // the runtime: a worker-owned run pauses before it. Saying anything here
  // would be noise on a correctly-labelled step.
  if (step.effect !== 'external') {
    for (const { re, what } of EGRESS) {
      if (!re.test(text)) continue;
      findings.push(
        step.effect === 'local'
          ? {
              stepId: step.id,
              severity: 'high',
              category: 'egress-effect-mismatch',
              message: `Prompt reaches the network via ${what}, but the step declares "effect: local". A step that sends data off the machine is not a local-only step.`,
            }
          : {
              stepId: step.id,
              severity: 'medium',
              category: 'egress-undeclared',
              message: `Prompt reaches the network via ${what} and the step declares no effect, so the runtime has to guess whether to pause before it.`,
            },
      );
    }
  }
  return findings;
}

/// Scan every step in a flow. Pure: no I/O, no clock, no randomness — the same
/// flow always produces the same findings in the same order (step order, then
/// the fixed pattern order above), which is what lets a caller diff two scans.
export function scanFlowRisks(flow: Flow): FlowRiskFinding[] {
  return (flow.steps ?? []).flatMap((step) => scanStepRisks(step));
}
