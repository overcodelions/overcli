// Machine values that are credentials, told apart from the ones that are not.
//
// Shared because both sides need the same answer: the engine uses it to move a
// password out of the plain-text file on first load, and the pane uses it to
// default a newly typed name to "secret" before anyone has thought about it.

/// Whether a name reads like a credential. Splits on separators and on a
/// lower-to-upper boundary (so `dbPassword` sees "db"/"password" too), then
/// weighs each piece. Deliberately loose — marking a non-secret as secret
/// costs a masked field, the other mistake costs a password in a plain-text
/// file AND in every service log line, because only values in the encrypted
/// store reach the masker.

/// Words that say "credential" on their own. One of these wins outright, even
/// over a locator suffix: SECRET_ID is Vault AppRole's actual credential, not
/// an identifier.
const UNAMBIGUOUS = ['password', 'passwd', 'pwd', 'passphrase', 'secret', 'credential'];

/// Words that only suggest one, and defer to a locator: AUTH_URL and
/// SSH_KEY_PATH name where something lives, not what it is.
const AMBIGUOUS = ['token', 'apikey', 'privatekey', 'key', 'auth', 'pass', 'private'];

/// Names ending in one of these describe where something is, not what it is.
const LOCATOR_TOKENS = new Set(['url', 'uri', 'host', 'hostname', 'endpoint', 'port', 'path', 'dir', 'file', 'name', 'id']);

/// Run-together names — `AWS_SECRETKEY`, `apikey` — split into no useful token,
/// and calling those non-secret is the one mistake this file exists to avoid.
/// Matched as a substring, so every word here is long enough not to fire on an
/// ordinary one: `pass` matches as a whole piece only, never inside PASSENGER.
const EMBEDDABLE = new Set(['password', 'passwd', 'passphrase', 'secret', 'credential', 'apikey', 'privatekey', 'token']);

function carries(part: string, words: readonly string[]): boolean {
  return words.some((w) => (EMBEDDABLE.has(w) ? part.includes(w) : part === w));
}

export function isSecretName(name: string): boolean {
  const parts = name
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  if (parts.length === 0) return false;
  if (parts.some((p) => carries(p, UNAMBIGUOUS))) return true;
  if (LOCATOR_TOKENS.has(parts[parts.length - 1])) return false;
  return parts.some((p) => carries(p, AMBIGUOUS));
}

/// What a secret's value becomes anywhere it is shown: the Overrides tab, a
/// log line that echoed it back.
export const SECRET_MASK = '••••••';
