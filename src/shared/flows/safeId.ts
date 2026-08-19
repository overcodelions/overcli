/// A single id must be usable as one path segment. `[A-Za-z0-9._-]` alone is
/// not enough: `.` and `..` match it and resolve to the parent directory at
/// any sink that joins the id without appending a suffix.
export function isSafeIdSegment(id: string): boolean {
  if (id === '.' || id === '..') return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}
