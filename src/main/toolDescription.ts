// One-line digests of tool uses for prompts and activity captions.
// Ideally callers (the reviewer prompt, the activity strip) see enough
// to reconstruct what happened without us dumping the full tool_use JSON
// (which can be many KB for patch / file writes).

/// One-line digest of a tool use. Falls back to the raw input JSON for
/// unknown tools.
export function summarizeToolUse(name: string, inputJSON: string, filePath?: string): string {
  let parsed: any = null;
  try {
    parsed = JSON.parse(inputJSON);
  } catch {
    // inputJSON might not be JSON (we pack `command.join(' ')` straight
    // in for shell/bash from codex); treat as opaque.
  }
  if (name === 'Bash' || name === 'shell' || name === 'exec_command') {
    const cmd =
      typeof parsed?.command === 'string'
        ? parsed.command
        : Array.isArray(parsed?.command)
        ? parsed.command.join(' ')
        : inputJSON;
    return `• Bash: ${truncate(cmd, 240)}`;
  }
  if (name === 'Edit' || name === 'MultiEdit') {
    return `• Edit ${filePath ?? parsed?.file_path ?? ''}`.trim();
  }
  if (name === 'Write') {
    return `• Write ${filePath ?? parsed?.file_path ?? ''}`.trim();
  }
  if (name === 'Read') {
    return `• Read ${filePath ?? parsed?.file_path ?? ''}`.trim();
  }
  if (name === 'TodoWrite') {
    const count = Array.isArray(parsed?.todos) ? parsed.todos.length : 0;
    return `• TodoWrite (${count})`;
  }
  return `• ${name} ${truncate(inputJSON, 160)}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
