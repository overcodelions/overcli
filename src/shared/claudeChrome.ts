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
