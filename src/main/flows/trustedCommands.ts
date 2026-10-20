// Commands an admin named as safe to run without asking — a connected repo's
// test command (org/repos.ts), as narrowed grants like `Bash(npm test:*)`.
// Running a repo's own tests changes nothing outside the worktree, and a PR
// worker that must ask before every test run is one nobody keeps. Read by
// `resolveStepEffect` (runtime.ts); set by org/repoGrants.ts.

const trusted = new Set<string>();

export function setTrustedCommands(grants: readonly string[]): void {
  trusted.clear();
  for (const g of grants) trusted.add(g.toLowerCase().trim());
}

/// Reading the web (searching, opening a page) as local: on the org's server
/// unless its rules say otherwise. Research is most of what workers do, and
/// one that must ask before every page is one nobody keeps. Off everywhere
/// else, the desktop included.
let webReads: () => boolean = () => false;

export function setWebReadsTrusted(fn: () => boolean): void {
  webReads = fn;
}

/// `name` lowercased, as resolveStepEffect compares tool names.
export function isTrustedCommand(name: string): boolean {
  if (trusted.has(name)) return true;
  return (name === 'webfetch' || name === 'websearch' || /^web(fetch|search)\(/.test(name)) && webReads();
}
