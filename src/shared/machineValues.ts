// Machine values that are credentials, told apart from the ones that are not.
//
// Shared because both sides need the same answer: the engine uses it to move a
// password out of the plain-text file on first load, and the pane uses it to
// default a newly typed name to "secret" before anyone has thought about it.

/// Whether a name reads like a credential. Splits on separators and on a
/// lower-to-upper boundary (so `dbPassword` sees "db"/"password" too), then
/// checks each piece against a token list and, for names with no separator at
/// all, against a list of longer embedded substrings. Deliberately loose —
/// marking a non-secret as secret costs a masked field, the other mistake
/// costs a password in a plain-text file.
const SECRET_TOKENS = new Set([
  'pass', 'passwd', 'password', 'pwd', 'secret', 'secrets', 'token', 'tokens',
  'credential', 'credentials', 'key', 'keys', 'auth', 'private',
]);

/// Run-together names — `AWS_SECRETKEY`, `apikey` — split into no useful
/// token, and calling those non-secret is the one mistake this file exists to
/// avoid. Long enough not to fire on `PASSENGER`, so `pass` is not in here.
const EMBEDDED_TOKENS = ['password', 'passwd', 'secret', 'credential', 'apikey', 'privatekey', 'token'];

/// Names ending in one of these describe where something is, not what it is.
const LOCATOR_TOKENS = new Set(['url', 'uri', 'host', 'hostname', 'endpoint', 'port', 'path', 'dir', 'file', 'name', 'id']);

export function isSecretName(name: string): boolean {
  const parts = name
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  if (parts.length === 0) return false;
  if (LOCATOR_TOKENS.has(parts[parts.length - 1])) return false;
  return parts.some((p) => SECRET_TOKENS.has(p) || EMBEDDED_TOKENS.some((t) => p.includes(t)));
}

/// What a secret's value becomes anywhere it is shown: the Overrides tab, a
/// log line that echoed it back.
export const SECRET_MASK = '••••••';
