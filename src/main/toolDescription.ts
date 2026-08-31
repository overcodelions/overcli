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
  // Ollama built-in tools — exposed to local models that support tool
  // calling. Naming uses the function-style name from the schema rather
  // than the cloud CLIs' PascalCase.
  if (name === 'read_file') {
    return `• Read ${filePath ?? parsed?.path ?? ''}`.trim();
  }
  if (name === 'list_dir') {
    return `• List ${parsed?.path ?? '.'}`.trim();
  }
  if (name === 'grep') {
    const pat = typeof parsed?.pattern === 'string' ? parsed.pattern : '';
    return `• Grep ${truncate(pat, 80)}`.trim();
  }
  // Artifact publishes a local HTML file to claude.ai. The URL is the point
  // of the call, so the digest names what is going out rather than the 2 MB
  // of inlined editor that a raw input dump would lead with.
  if (name === 'Artifact') {
    const title = typeof parsed?.title === 'string' ? parsed.title : '';
    const target = filePath ?? parsed?.file_path ?? '';
    return `• Artifact publish ${title ? `"${truncate(title, 60)}" ` : ''}${target}`.trim();
  }
  if (name === 'DesignSync') {
    const method = typeof parsed?.method === 'string' ? parsed.method : '(unknown method)';
    const writes = Array.isArray(parsed?.writes) ? parsed.writes.length : 0;
    const deletes = Array.isArray(parsed?.deletes) ? parsed.deletes.length : 0;
    if (method === 'finalize_plan') {
      return `• DesignSync finalize_plan (${writes} writes, ${deletes} deletes, from ${parsed?.localDir ?? 'cwd'})`;
    }
    return `• DesignSync ${method}`;
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
