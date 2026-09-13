// Machine values that are credentials, told apart from the ones that are not.
//
// Shared because both sides need the same answer: the engine uses it to move a
// password out of the plain-text file on first load, and the pane uses it to
// default a newly typed name to "secret" before anyone has thought about it.

/// Whether a name reads like a credential. Deliberately loose — marking a
/// non-secret as secret costs a masked field, the other mistake costs a
/// password in a plain-text file.
export function isSecretName(name: string): boolean {
  return /pass|secret|token|key|credential|auth|private/i.test(name);
}

/// What a secret's value becomes anywhere it is shown: the Overrides tab, a
/// log line that echoed it back.
export const SECRET_MASK = '••••••';
