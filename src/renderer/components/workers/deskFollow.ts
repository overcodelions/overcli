// Whether the desk should follow the turn a worker is working right now.
//
// A transcript that always jumps to the bottom fights anyone reading further
// up; one that never does leaves the live turn writing itself off-screen. The
// rule both halves need is small enough to state, so it lives here where it
// can be tested rather than inline in an effect.

/// How far off the bottom still counts as standing at the bottom. One line of
/// slack, so a stray trackpad nudge doesn't stop the desk following the work.
export const DESK_PIN_SLACK = 48;

/// Is the reader at the bottom of the transcript? Measured on scroll rather
/// than after new content lands: by then the new text has already pushed the
/// bottom away, and every check would answer "no".
export function pinnedToBottom(
  m: { scrollHeight: number; scrollTop: number; clientHeight: number },
  slack: number = DESK_PIN_SLACK,
): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight < slack;
}

/// Should this frame scroll the desk to the bottom?
///
/// A turn STARTING is worth interrupting for — it is the answer to "did it
/// hear me", and seeing the work begin is the whole reason the live turn is
/// rendered at all. Once it is running, following is conditional on the reader
/// still being at the bottom.
export function shouldFollowLive(args: {
  live: boolean;
  wasLive: boolean;
  pinned: boolean;
}): boolean {
  if (args.live && !args.wasLive) return true;
  return args.live && args.pinned;
}
