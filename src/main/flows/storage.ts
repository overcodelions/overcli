// Flow library storage. Flows live on disk as YAML files in two locations:
//
//   <userData>/flows/*.yaml                      — user-global, available everywhere
//   <projectPath>/.overcli/flows/*.yaml          — project-local, committable to git
//
// When the same flow id (filename without `.yaml`) exists in both, the
// project-local version wins. `loadAllFlows` walks both layers and applies
// the override, returning the merged list with `source` set on each Flow.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

import { parseFlowYaml, serializeFlow } from '../../shared/flows/yaml';
import type { Flow } from '../../shared/flows/schema';
import { SLUG_RE, validateFlow } from '../../shared/flows/validation';

const USER_FLOWS_DIRNAME = 'flows';
const PROJECT_FLOWS_DIRNAME = path.join('.overcli', 'flows');
const YAML_EXT = '.yaml';

function userFlowsDir(): string {
  return path.join(app.getPath('userData'), USER_FLOWS_DIRNAME);
}

function projectFlowsDir(projectPath: string): string {
  return path.join(projectPath, PROJECT_FLOWS_DIRNAME);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readDirSafe(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function loadFlowsFromDir(dir: string, source: 'user' | 'project'): Flow[] {
  const out: Flow[] = [];
  for (const name of readDirSafe(dir)) {
    if (!name.endsWith(YAML_EXT)) continue;
    const filePath = path.join(dir, name);
    let body: string;
    try {
      body = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const id = name.slice(0, -YAML_EXT.length);
    const flow = parseFlowYaml({ yaml: body, id, source, filePath });
    if (flow) out.push(flow);
  }
  // Sort by id so the UI list is stable.
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/// Resolve the on-disk path a flow would live at, given target + id.
/// Project-local saves require a projectPath; user saves ignore it.
function resolveSavePath(args: {
  target: 'user' | 'project';
  flowId: string;
  projectPath?: string;
}): string {
  const dir =
    args.target === 'user'
      ? userFlowsDir()
      : projectFlowsDir(args.projectPath ?? '');
  return path.join(dir, `${args.flowId}${YAML_EXT}`);
}

/// Load every flow from both the user dir and (optionally) the supplied
/// project dirs. When the same id appears in multiple project dirs, the
/// first one wins (the caller's list is responsibility-ordered); when a
/// project flow shares an id with a user flow, the project wins.
export function loadAllFlows(args: { projectPaths?: string[] } = {}): Flow[] {
  const userFlows = loadFlowsFromDir(userFlowsDir(), 'user');
  const byId = new Map<string, Flow>();
  for (const f of userFlows) byId.set(f.id, f);
  for (const projectPath of args.projectPaths ?? []) {
    const projFlows = loadFlowsFromDir(projectFlowsDir(projectPath), 'project');
    for (const f of projFlows) byId.set(f.id, f); // project overrides user
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/// Save a flow (validates first). Returns the resolved file path or an
/// error object the renderer can surface inline.
export function saveFlow(args: {
  flow: Flow;
  target: 'user' | 'project';
  projectPath?: string;
}): { ok: true; filePath: string } | { ok: false; error: string } {
  const v = validateFlow(args.flow);
  if (!v.ok) {
    return {
      ok: false,
      error: `Flow has validation errors: ${v.errors.map(e => `${e.path}: ${e.message}`).join('; ')}`,
    };
  }
  if (args.target === 'project' && !args.projectPath) {
    return { ok: false, error: 'Cannot save project flow without a project path.' };
  }
  const filePath = resolveSavePath({
    target: args.target,
    flowId: args.flow.id,
    projectPath: args.projectPath,
  });
  try {
    ensureDir(path.dirname(filePath));
    const body = serializeFlow({ ...args.flow, source: args.target, filePath });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, body, 'utf-8');
    fs.renameSync(tmp, filePath);
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/// Delete a flow file. The caller specifies which layer to delete from
/// (you might have a flow with the same id in both layers and only want to
/// remove one). The `projectPath` is required when source === 'project'.
export function deleteFlow(args: {
  flowId: string;
  source: 'user' | 'project';
  projectPath?: string;
}): { ok: true } | { ok: false; error: string } {
  if (args.source === 'project' && !args.projectPath) {
    return { ok: false, error: 'Cannot delete project flow without a project path.' };
  }
  // Unlike saveFlow, delete has no full Flow to run through validateFlow —
  // so guard the id directly. A flow id becomes a filename, and a malformed
  // one (e.g. "../../foo") would let an unlinkSync escape the flows dir.
  if (!SLUG_RE.test(args.flowId)) {
    return { ok: false, error: `Invalid flow id "${args.flowId}".` };
  }
  const dir =
    args.source === 'user' ? userFlowsDir() : projectFlowsDir(args.projectPath ?? '');
  const filePath = resolveSavePath({
    target: args.source,
    flowId: args.flowId,
    projectPath: args.projectPath,
  });
  // Defense in depth: the resolved path must stay inside the layer's dir.
  const rel = path.relative(dir, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: 'Refusing to delete a flow outside its flows directory.' };
  }
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/// Parse + validate a YAML body without writing it to disk. Used by the
/// builder's right-pane preview to surface inline errors while the user
/// hand-edits, and by `flows:save` server-side as a final gate.
export function validateFlowYaml(args: {
  yaml: string;
  id?: string;
}): { ok: true; flow: Flow } | { ok: false; errors: Array<{ path: string; message: string }> } {
  const id = args.id?.trim() || 'untitled';
  const parsed = parseFlowYaml({
    yaml: args.yaml,
    id,
    source: 'user',
    filePath: '',
  });
  if (!parsed) {
    return {
      ok: false,
      errors: [{ path: '', message: 'YAML failed to parse.' }],
    };
  }
  const result = validateFlow(parsed);
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, flow: parsed };
}
