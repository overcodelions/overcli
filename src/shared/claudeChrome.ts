// Claude in Chrome, as it behaves in the headless sessions overcli drives.
//
// Two facts, both established by probing the 2.1.258 CLI directly:
//
//   1. The browser TOOLS do work under `-p`. Launching with `--chrome`
//      attaches the extension and exposes ~22 `mcp__claude-in-chrome__*`
//      tools (navigate, computer, read_page, form_input, javascript_tool,
//      read_console_messages, browser_batch, …). On CLI 2.1.258 they ARE
//      present in the `init` message's `tools` array, alongside an
//      `mcp_servers` entry `{name: "claude-in-chrome", status: "connected"}`
//      — confirmed by diffing `init` with and without `--chrome` (54 vs 32
//      tools). An earlier version of this comment claimed the tools were
//      absent from `init` because the extension's MCP connection completes
//      after init is emitted; that was wrong on this CLI version, and was
//      also not actually why the Capabilities sheet omitted Chrome — see
//      GitHub #268. The sheet's MCP tab comes from a filesystem scan (see
//      src/main/capabilities.ts) that can't see this server because it's
//      injected internally rather than written to a config file; the fix
//      there folds in `lastInit.tools`/`lastInit.mcpServers` instead
//      (see liveMcp.ts). They also survive `--strict-mcp-config`, meaning
//      turbo and `skipGlobalMcp` don't strip them: the server is injected
//      internally rather than through `--mcp-config`.
//
//   2. The `/chrome` SLASH COMMAND does not work under `-p` at all. It is
//      an interactive-only picker/status screen, and headless it answers
//      with the constant line matched below.
//
// Fact 2 is why this file is not a copy of claudeArtifacts.ts. The
// `/design` gate could be detected from its usage line because that line
// appears ONLY when the gate is shut. `/chrome` prints its unavailable
// line in every session overcli drives — with `--chrome` and without it,
// with the setting on and off. So the notice below must never be read as
// "the setting is off"; it means "this command has no headless form", and
// the UI says something different depending on what the setting actually
// is. Matching it as a gate signal would offer "turn this on" to users who
// already have it on.
const CHROME_UNAVAILABLE_RE = /^\s*\/chrome\s+isn't\s+available\s+in\s+this\s+environment\.?\s*$/i;

/// True for the CLI's headless answer to `/chrome`. Says nothing about
/// whether Claude in Chrome is enabled — see the note above.
export function isChromeUnavailableNotice(text: string): boolean {
  return CHROME_UNAVAILABLE_RE.test(text);
}

/// What to do with a composer submission that starts with `/chrome`.
///
/// `/chrome` is intercepted by the CLI before the model is ever invoked —
/// the reply comes back as local command output, not a turn — and the
/// picker ignores whatever follows it. So `/chrome navigate to cnn` is a
/// guaranteed no-op: it costs a round trip, answers with the constant line
/// matched above, and does this with the setting on or off. The browser
/// TOOLS are what actually does the work, and they take plain prose.
///
/// Hence: rewrite the submission to its prose when the tools are attached,
/// and when they aren't, hold it and offer the switch — sending the prose
/// into a session with no browser tools just relocates the dead end, and
/// silently dropping the `/chrome` there would also drop the one prompt
/// the user gets to turn it on.
export type ChromeCommandVerdict =
  | { kind: 'pass' }
  /// Send `prose` in place of what was typed; the tools are attached.
  | { kind: 'rewrite'; prose: string }
  /// Don't send. Offer to enable Chrome and then send `prose`.
  | { kind: 'blocked'; prose: string };

/// Case-sensitive, and requiring whitespace before the prose, so this
/// matches exactly what the CLI itself intercepts. `/CHROME foo` and
/// `/chromecast` are NOT slash commands to it — they reach the model as
/// ordinary prompts, and rewriting them here would corrupt a real message.
const CHROME_COMMAND_RE = /^\s*\/chrome[ \t]+([\s\S]*\S)\s*$/;

export function chromeCommandVerdict(
  text: string,
  opts: { backend?: string; chromeOn: boolean },
): ChromeCommandVerdict {
  // Only claude has this command; every other backend takes `/chrome …`
  // as prose already.
  if (opts.backend !== 'claude') return { kind: 'pass' };
  // A bare `/chrome` is a real request for the picker, not a misdirected
  // instruction. Leave it alone — the CLI's reply plus `ChromeNotice`
  // already explain that case correctly.
  const prose = CHROME_COMMAND_RE.exec(text)?.[1];
  if (!prose) return { kind: 'pass' };
  return opts.chromeOn ? { kind: 'rewrite', prose } : { kind: 'blocked', prose };
}

/// The Chrome Web Store listing for the Claude in Chrome extension. The
/// `--chrome` flag only asks the CLI to attach; without this installed and
/// enabled, the browser tools fail at call time and nothing in overcli said
/// why — the user had to guess the extension existed.
export const CLAUDE_IN_CHROME_URL =
  'https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn';

/// MCP servers that give a non-Claude backend a real browser to drive. Used
/// to tell a codex user whether they already have one or need to add one.
const BROWSER_MCP_RE = /puppeteer|playwright|chrome-devtools|browser/i;

export function isBrowserMcpName(name: string): boolean {
  return BROWSER_MCP_RE.test(name);
}

const CHROME_TOOL_PREFIX = 'mcp__claude-in-chrome__';

type ChromeScanEvent = {
  kind:
    | { type: 'localUser' }
    | { type: 'assistant'; info: { toolUses: Array<{ id: string; name: string }> } }
    | { type: 'toolResult'; results: Array<{ id: string; content: string; isError: boolean }> }
    | { type: string };
};

/// The latest turn's failed Claude in Chrome call, if its last browser call
/// failed. Keyed on the tool name, not the error text: the extension's
/// messages vary by version (not installed, disabled, Chrome closed, signed
/// into another account) and all of them come down to the same setup check.
/// A later successful call in the same turn clears it — the model recovered.
export function lastChromeToolFailure(
  events: readonly ChromeScanEvent[],
): { id: string; content: string } | null {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind.type === 'localUser') {
      start = i + 1;
      break;
    }
  }
  const chromeIds = new Set<string>();
  let last: { id: string; content: string; isError: boolean } | null = null;
  for (let i = start; i < events.length; i++) {
    const k = events[i].kind;
    if (k.type === 'assistant' && 'info' in k) {
      for (const t of k.info.toolUses) if (t.name.startsWith(CHROME_TOOL_PREFIX)) chromeIds.add(t.id);
    } else if (k.type === 'toolResult' && 'results' in k) {
      for (const r of k.results) if (chromeIds.has(r.id)) last = r;
    }
  }
  return last?.isError ? { id: last.id, content: last.content } : null;
}
