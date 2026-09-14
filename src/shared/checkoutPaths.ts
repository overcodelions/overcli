// A command that names a checkout by its path.
//
// Commands brought over from another tool arrive with the folder they were
// written against. Switching the service to another worktree moves the
// process, but a command that says `/repos/app` keeps reaching back to it.
// `${CHECKOUT}` is the spelling that follows the switch.

/// The known checkouts a command names outright, longest first — so a
/// worktree nested beside the main checkout is found before its shorter
/// prefix.
export function hardcodedCheckouts(command: string, checkouts: readonly string[]): string[] {
  return normalise(checkouts).filter((p) => pathPattern(p).test(command));
}

/// The command with every known checkout path replaced by `${CHECKOUT}`.
export function useCheckoutPlaceholder(command: string, checkouts: readonly string[]): string {
  let out = command;
  for (const p of normalise(checkouts)) out = out.replace(pathPattern(p, 'g'), '${CHECKOUT}');
  return out;
}

function normalise(checkouts: readonly string[]): string[] {
  const paths = checkouts.map((p) => p.replace(/\/+$/, '')).filter((p) => p.length > 1);
  return [...new Set(paths)].sort((a, b) => b.length - a.length);
}

/// The path as a whole segment run: `/repos/app` inside `/repos/app/src` or
/// `"/repos/app"`, never inside `/repos/app-next`.
function pathPattern(p: string, flags = ''): RegExp {
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`, flags);
}
