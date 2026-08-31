// Claude Code gates its Artifact tool — and the `/design` canvas skill that
// publishes through it — behind a capability check that assumes a headless
// session has nowhere to put an artifact. The relevant branch, deminified
// from the 2.1.251 binary:
//
//   function E(){ if(auth()!=="firstParty") return false;
//                 if(isFalsy(CLAUDE_CODE_ARTIFACT)) return false;
//                 if(!isSet(CLAUDE_CODE_ARTIFACT) && headless()) return false;
//                 return true }
//
// `headless()` is true for `-p`/stream-json runs, which is every way overcli
// drives the CLI — so the gate closes on us by default and `/design` falls
// through to its own subcommand stub ("Usage: /design consent | /design
// revoke"). Setting CLAUDE_CODE_ARTIFACT skips that third check outright.
//
// Two caveats this cannot paper over, both of which fail *open* into the
// usage line rather than into anything broken:
//   - it needs a first-party claude.ai login; an API key never qualifies.
//   - two account-level gates still apply and we can't see them from here.
// So this is an enabler, not a guarantee: DESIGN_UNAVAILABLE_RE below is how
// we notice it didn't take.
//
// An undocumented env var behind a minified gate is load-bearing here, and it
// can move in any weekly CLI release. It stays opt-in for that reason.
export const CLAUDE_ARTIFACT_ENV = 'CLAUDE_CODE_ARTIFACT';

/// Env overlay for a Claude spawn. Empty when the setting is off, so the
/// var is absent rather than set-to-falsy — the CLI treats an explicit
/// falsy value as "artifacts disabled", which is a different thing from
/// "unset" and would opt the user *out* of a default they might otherwise
/// get.
export function claudeArtifactEnv(enabled: boolean | undefined): Record<string, string> {
  return enabled ? { [CLAUDE_ARTIFACT_ENV]: '1' } : {};
}

/// What `/design` answers with when the canvas skill is gated off. The CLI
/// registers one `design` command whose subcommands survive even when the
/// skill behind it doesn't, so a gated session gets its bare usage line
/// instead of an error — silent enough that the user reads it as overcli
/// mangling the command. Matching it lets us say what actually happened.
const DESIGN_UNAVAILABLE_RE = /^\s*Usage:\s*\/design\s+consent\s*\|\s*\/design\s+revoke\s*$/i;

export function isDesignUnavailableNotice(text: string): boolean {
  return DESIGN_UNAVAILABLE_RE.test(text);
}
