// The Agent SDK (@anthropic-ai/claude-agent-sdk) spawns a Claude Code binary.
// By default it would spawn its own ~200 MB native binary, shipped as a
// platform package (@anthropic-ai/claude-agent-sdk-<platform>-<arch>). We do
// NOT bundle that with overcli — it bloats the build and, inside `app.asar`,
// can't be spawned at all (`spawn ENOTDIR`). The packaged build excludes it
// (see the `files` negation in package.json).
//
// overcli already depends on the user's own Claude Code install (the same one
// the default 'cli' transport spawns). So for the experimental SDK transport
// we point the SDK at that installed binary via `pathToClaudeCodeExecutable`.

import { resolveBackendPath } from './backendPaths';

/// Absolute path to the user's installed `claude`, for the SDK to spawn via
/// `pathToClaudeCodeExecutable`. `override` is the user's Settings →
/// backendPaths.claude entry, if any. Returns undefined when no install is
/// found, in which case the SDK falls back to its own resolution (which only
/// succeeds in dev, where the platform package is present in node_modules).
export function claudeSdkExecutablePath(override?: string): string | undefined {
  return resolveBackendPath('claude', override) ?? undefined;
}
