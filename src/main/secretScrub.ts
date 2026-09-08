// Keeping credentials out of anything overcli sends off the machine.
//
// WHY THIS EXISTS. `webhookNotify.ts` POSTs a notification's title and body to
// a URL the user configured — Slack, ntfy, webhook.site, whatever. The callers
// hand it raw text: `scheduler.ts` passes `body: res.error` at its failed-run
// and failed-to-start sites, and a dozen sites in `workerEngine.ts` do the same
// with `res.error`, `built.error`, or a model-authored subject. That text is
// whatever a backend CLI, a git invocation, or a model turn produced. If a
// build printed an AWS key, a `git push` echoed a PAT, or a curl dumped an
// `Authorization` header, it went out over the wire with zero inspection and
// then sat in a third-party channel's retained history.
//
// WHAT THIS IS NOT: a security boundary — the same disclaimer
// `shared/flows/riskScan.ts` opens with, and for the same reason. These are
// plain-text regexes plus an exact-match list. They will MISS real credentials
// (anything encoded, split across lines, or in a format nobody published) and
// they will sometimes redact something harmless. The design bias is deliberate
// and one-directional: over-redacting mangles a notification, under-redacting
// leaks a live credential, so every judgement call here goes the redacting way.
//
// RELATIONSHIP TO `riskScan.ts`: none, and deliberately so. That module scans
// flow *definitions* for references to credential *paths* (`~/.ssh`,
// `.aws/credentials`) and lives in `src/shared`, where it explicitly cannot
// import from `src/main`. This one scans free text for credential *values*.
// Different input, different question, different home.
//
// THE TWO HALVES, and why the second one matters more than it looks.
// (a) Pattern rules catch credentials whose format is public — AKIA…, `ghp_`,
//     `xox…`, a PEM block. That is the mandated floor and it is genuinely
//     useful, but it can only ever recognise formats someone published.
// (b) Known-value rules catch credentials because THIS MACHINE HOLDS THEM,
//     whatever they look like. A database password, a vendor token with no
//     prefix, the webhook's own bearer token echoed back inside an HTTP error
//     body — none of those have a recognisable shape, so no pattern set will
//     ever find them. Exact-matching against values we can enumerate is the
//     only thing that can.

/// Bits of Shannon entropy per character. Used as a SECONDARY signal on the two
/// rules that would otherwise fire constantly (see below) — the same role it
/// plays in gitleaks, where the regex is the primary signal and entropy only
/// decides whether a candidate is random enough to be a real secret.
export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/// Below this, a "high-entropy value" is not high-entropy. `password=aaaaaaaaaaaaaaaaaa`
/// scores 0 and a repeated placeholder scores under 2; a real base64 or hex
/// credential scores well above 3.
const MIN_ENTROPY_BITS = 3.0;

/// Ignore a known value shorter than this. A 4-character "secret" appears
/// inside ordinary words, and redacting every occurrence of it would shred the
/// notification without protecting anything worth protecting.
const MIN_KNOWN_VALUE_LEN = 8;

/// Environment variables whose NAME says the value is a credential. Matched
/// loosely on purpose — the cost of including a non-secret is that we redact a
/// string the user probably did not want in a Slack message anyway.
const CREDENTIAL_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_KEY|PRIVATE_KEY)/i;

/// Values that are obviously not credentials even under a credential-shaped
/// name: paths (`$HOME/.aws`), and anything with whitespace in it.
function looksLikeACredentialValue(raw: string): boolean {
  const v = raw.trim();
  if (v.length < 16) return false;
  if (/\s/.test(v)) return false;
  if (v.startsWith('/') || v.startsWith('~') || v.startsWith('./') || v.startsWith('../')) return false;
  return shannonEntropy(v) >= MIN_ENTROPY_BITS;
}

/// Every credential value this process can enumerate, longest first.
///
/// `env` defaults to `process.env`, which is the only impure thing in this
/// module — pass an explicit object to keep a caller (or a test) deterministic.
/// `extra` is for credentials that live outside the environment; the webhook's
/// own auth token is passed in this way rather than re-read from the keychain,
/// so this function never touches `host()`.
///
/// Longest-first ordering matters: if two known values overlap, replacing the
/// longer one first stops the shorter replacement from splitting it into two
/// halves, one of which would survive.
export function collectKnownSecretValues(
  env: NodeJS.ProcessEnv = process.env,
  extra: ReadonlyArray<string | null | undefined> = [],
): string[] {
  const out = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (!CREDENTIAL_ENV_NAME.test(name)) continue;
    if (!looksLikeACredentialValue(value)) continue;
    out.add(value.trim());
  }
  for (const value of extra) {
    const v = value?.trim();
    if (v && v.length >= MIN_KNOWN_VALUE_LEN) out.add(v);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/// One pattern rule. `gate` is an optional second opinion on the captured
/// value, for the rules whose regex alone is too broad to act on.
interface Rule {
  kind: string;
  re: RegExp;
  /// Which capture group holds the credential itself. 0 = the whole match.
  /// Anything before it is re-emitted verbatim, so `api_key=` survives and
  /// only the value after it is replaced — the message still reads.
  ///
  /// INVARIANT: the credential group must be a SUFFIX of the whole match —
  /// nothing in the pattern may follow it. The replacement slices the prefix
  /// off by length rather than reassembling the groups, so a rule with a
  /// trailing group would silently drop the tail.
  group: number;
  gate?: (value: string) => boolean;
}

/// A 40-character base64-ish blob is the shape of an AWS secret access key. It
/// is ALSO the shape of a git SHA-1, which appears constantly in the very text
/// this scrubber sees (`res.error` from a failed git command). Requiring mixed
/// case rules out hex digests in either case while leaving real base64 alone —
/// 30 random bytes of base64 essentially always contains both cases.
function looksLikeBase64Secret(value: string): boolean {
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value)) return false;
  return shannonEntropy(value) >= MIN_ENTROPY_BITS;
}

/// Order is load-bearing. The specific formats run before the generic
/// assignment catch-all, so `api_key=AKIA…` is labelled `aws-access-key-id`
/// rather than the vaguer `generic-assignment`, and is counted exactly once.
const RULES: Rule[] = [
  {
    kind: 'pem-private-key',
    // Non-greedy body so two keys in one message are two matches, not one
    // giant one that swallows the prose between them.
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    group: 0,
  },
  { kind: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, group: 0 },
  { kind: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, group: 0 },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, group: 0 },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, group: 0 },
  { kind: 'stripe-key', re: /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{16,}/g, group: 0 },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    group: 0,
  },
  {
    kind: 'bearer-token',
    // The word `Bearer` is kept so the reader can tell an auth header from a
    // stray blob; only the credential after it is replaced.
    re: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/g,
    group: 2,
  },
  {
    kind: 'aws-secret-access-key',
    // No lookbehind: the leading boundary is a real capture group that gets
    // re-emitted, which keeps this compiling under every target this repo
    // builds for.
    re: /(^|[^A-Za-z0-9+/=])([A-Za-z0-9+/]{40})(?![A-Za-z0-9+/=])/g,
    group: 2,
    gate: looksLikeBase64Secret,
  },
  {
    kind: 'generic-assignment',
    re: /\b(api[_-]?key|token|secret|password)(\s*[=:]\s*['"]?)([A-Za-z0-9+/_-]{16,})/gi,
    group: 3,
    gate: (v) => shannonEntropy(v) >= MIN_ENTROPY_BITS,
  },
];

function marker(kind: string): string {
  return `[REDACTED:${kind}]`;
}

/// Replace anything that looks like a live credential with a `[REDACTED:<kind>]`
/// marker, and say how many replacements were made.
///
/// Pure: same inputs, same output, no I/O, no clock, no environment. The caller
/// supplies `knownValues` (from `collectKnownSecretValues`) rather than this
/// function going and finding them, so it stays testable as a plain function.
///
/// The raw value is NEVER returned, logged, or embedded in the marker — the
/// count is the only thing that escapes, which is what lets the caller warn the
/// user that scrubbing happened without re-leaking what it scrubbed.
///
/// A marker cannot be re-matched by a later rule: every rule needs at least 16
/// contiguous characters from an alphanumeric-ish class, and the longest such
/// run inside `[REDACTED:aws-access-key-id]` is `REDACTED` (8).
export function redactSecrets(
  text: string,
  knownValues: readonly string[] = [],
): { text: string; redactedCount: number } {
  if (!text) return { text: text ?? '', redactedCount: 0 };
  let out = text;
  let redactedCount = 0;

  // Known values first: highest confidence, so they win the labelling race
  // against any pattern that would also have matched.
  for (const value of knownValues) {
    if (!value || value.length < MIN_KNOWN_VALUE_LEN) continue;
    if (!out.includes(value)) continue;
    // `split`/`join` rather than a regex: a credential can contain any of
    // `. * + ? ( ) [ ] \ $ ^ | { }`, and escaping it to build a pattern is a
    // bug waiting to happen for zero benefit.
    const parts = out.split(value);
    redactedCount += parts.length - 1;
    out = parts.join(marker('known-secret'));
  }

  for (const rule of RULES) {
    // A fresh RegExp per pass: the module-level literals carry `g`, so a shared
    // `lastIndex` would make a second call on the same rule start mid-string.
    const re = new RegExp(rule.re.source, rule.re.flags);
    out = out.replace(re, (match, ...groups) => {
      const captured = rule.group === 0 ? match : (groups[rule.group - 1] as string | undefined);
      if (captured === undefined) return match;
      if (rule.gate && !rule.gate(captured)) return match;
      redactedCount += 1;
      const prefixEnd = match.length - captured.length;
      // Everything the pattern matched BEFORE the credential is re-emitted, so
      // `Bearer ` and `api_key=` survive the replacement.
      return `${match.slice(0, prefixEnd)}${marker(rule.kind)}`;
    });
  }

  return { text: out, redactedCount };
}
