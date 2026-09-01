// Size caps for files the user hands us. Shared because the renderer decides
// what to reject before reading anything and the main process re-checks
// before writing — one number, checked twice.
//
// These were a single constant for a while, which read as tidy and was
// wrong: the two paths are limited by completely different things. An
// attachment is bounded by what an API request can carry; a document dropped
// into a project folder is bounded by nothing but our own judgement.

/// 25 MB; matches the Claude API document/image cap. Raising this only moves
/// the rejection from us to the API — the bytes go out base64-encoded, a
/// third larger than what we measured here.
export const MAX_LLM_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/// 50 MB. A file dropped into a project folder is copied to disk and never
/// sent to a model, so the API cap has no say: a 34 MB deck belongs in
/// someone's Documents folder. Where the platform gives us the real path the
/// copy never passes through the renderer at all, so this is a policy limit
/// rather than a memory one.
export const MAX_PROJECT_FILE_BYTES = 50 * 1024 * 1024;

/// One phrasing of "too big", so the number in the message can never drift
/// from the number in the check.
export function tooLargeReason(name: string, size: number, limit: number): string {
  return `${name || 'file'} is ${megabytes(size)} MB; max is ${megabytes(limit)} MB.`;
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}
