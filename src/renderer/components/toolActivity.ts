// The one-line "what is it doing right now" for a tool call — shared by the
// subagent card and the Workers tab's Now cards, so both say it the same way.

/// Produce the "currently doing" one-liner from a tool call. Each tool
/// gets a hand-picked detail field (file_path for Read, command for
/// Bash, pattern for Grep, …). Unknown tools fall back to truncating
/// the raw input JSON so the line is never blank.
export function toolActivityLine(use: { name: string; inputJSON: string }): { name: string; detail: string } {
  let input: any = {};
  try {
    input = JSON.parse(use.inputJSON);
  } catch {
    // ignore — incomplete partial JSON during streaming
  }
  switch (use.name) {
    case 'Bash':
      return { name: 'Bash', detail: trimDetail(input.description || input.command || '') };
    case 'Read':
      return { name: 'Read', detail: trimDetail(input.file_path || '') };
    case 'Write':
      return { name: 'Write', detail: trimDetail(input.file_path || '') };
    case 'Edit':
    case 'MultiEdit':
      return { name: use.name, detail: trimDetail(input.file_path || '') };
    case 'Grep':
      return { name: 'Grep', detail: input.pattern ? `"${trimDetail(input.pattern)}"` : '' };
    case 'Glob':
      return { name: 'Glob', detail: trimDetail(input.pattern || '') };
    case 'WebFetch':
      return { name: 'WebFetch', detail: trimDetail(input.url || '') };
    case 'WebSearch':
      return { name: 'WebSearch', detail: input.query ? `"${trimDetail(input.query)}"` : '' };
    case 'TodoWrite':
      return { name: 'TodoWrite', detail: `${Array.isArray(input.todos) ? input.todos.length : 0} items` };
    case 'Task':
    case 'Agent':
      return { name: 'Agent', detail: trimDetail(input.subagent_type || input.description || '') };
    case 'Artifact':
      return { name: 'Artifact', detail: trimDetail(input.title || input.file_path || '') };
    case 'DesignSync':
      return { name: 'DesignSync', detail: trimDetail(designSyncDetail(input)) };
    default:
      return { name: use.name, detail: trimDetail(use.inputJSON.replace(/^\{|\}$/g, '')) };
  }
}

/// DesignSync packs eleven operations behind one tool name, so the method is
/// the only part of the input that says what is about to happen. `finalize_plan`
/// carries the consent boundary — the exact write/delete sets — and its path
/// list is the thing worth counting rather than truncating.
function designSyncDetail(input: any): string {
  const method = typeof input?.method === 'string' ? input.method : '';
  if (!method) return '';
  const writes = Array.isArray(input.writes) ? input.writes.length : 0;
  const deletes = Array.isArray(input.deletes) ? input.deletes.length : 0;
  if (method === 'finalize_plan') return `finalize_plan — ${writes} writes, ${deletes} deletes`;
  const files = Array.isArray(input.files) ? input.files.length : 0;
  if (method === 'write_files') return `write_files — ${files} files`;
  const paths = Array.isArray(input.paths) ? input.paths.length : 0;
  if (method === 'delete_files') return `delete_files — ${paths} paths`;
  if (method === 'create_project' && input.name) return `create_project — ${input.name}`;
  if (method === 'get_file' && input.path) return `get_file — ${input.path}`;
  return method;
}

export function trimDetail(s: string): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  return trimmed.length > 60 ? trimmed.slice(0, 57) + '…' : trimmed;
}
