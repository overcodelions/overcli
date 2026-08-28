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
import { host } from '../host';

import { Store } from '../store';
import { parseFlowYaml, serializeFlow } from '../../shared/flows/yaml';
import type { Flow } from '../../shared/flows/schema';
import { SLUG_RE, validateFlow } from '../../shared/flows/validation';
import { scanFlowRisks, type FlowRiskFinding } from '../../shared/flows/riskScan';

const USER_FLOWS_DIRNAME = 'flows';
/// Worker-drafted flows live beside the user's, not among them: same load
/// path (a run has to resolve them), separate directory so "delete everything
/// a worker invented" stays a one-directory operation.
const GENERATED_FLOWS_DIRNAME = 'flows-generated';
const PROJECT_FLOWS_DIRNAME = path.join('.overcli', 'flows');
const YAML_EXT = '.yaml';

function userFlowsDir(): string {
  return path.join(host().dataDir(), USER_FLOWS_DIRNAME);
}

function generatedFlowsDir(): string {
  return path.join(host().dataDir(), GENERATED_FLOWS_DIRNAME);
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

function loadFlowsFromDir(dir: string, source: Flow['source']): Flow[] {
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
  target: Flow['source'];
  flowId: string;
  projectPath?: string;
}): string {
  const dir =
    args.target === 'user'
      ? userFlowsDir()
      : args.target === 'generated'
        ? generatedFlowsDir()
        : projectFlowsDir(args.projectPath ?? '');
  return path.join(dir, `${args.flowId}${YAML_EXT}`);
}

/// Load every flow from both the user dir and (optionally) the supplied
/// project dirs. When the same id appears in multiple project dirs, the
/// first one wins (the caller's list is responsibility-ordered); when a
/// project flow shares an id with a user flow, the project wins.
export function loadAllFlows(args: { projectPaths?: string[] } = {}): Flow[] {
  const byId = new Map<string, Flow>();
  // Generated first so a user or project flow of the same id always wins:
  // promoting a worker's draft must shadow the original, not race it.
  for (const f of loadFlowsFromDir(generatedFlowsDir(), 'generated')) byId.set(f.id, f);
  for (const f of loadFlowsFromDir(userFlowsDir(), 'user')) byId.set(f.id, f);
  for (const projectPath of args.projectPaths ?? []) {
    const projFlows = loadFlowsFromDir(projectFlowsDir(projectPath), 'project');
    for (const f of projFlows) byId.set(f.id, f); // project overrides user
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/// Save a flow (validates first). Returns the resolved file path or an
/// error object the renderer can surface inline.
///
/// `risks` is the advisory heuristic content scan (see
/// shared/flows/riskScan.ts). It rides along on success and NEVER blocks the
/// write — same contract as the registry install path. It matters here
/// because the registry is only one of the doors a flow can come through:
/// hand-authoring in the builder, pasting YAML, worker drafting
/// (`target: 'generated'`) and share-file import all land on `saveFlow`, and
/// until now none of them looked at what the step prompts actually said.
export function saveFlow(args: {
  flow: Flow;
  target: Flow['source'];
  projectPath?: string;
}): { ok: true; filePath: string; risks: FlowRiskFinding[] } | { ok: false; error: string } {
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
    return { ok: true, filePath, risks: scanFlowRisks(args.flow) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/// Drop a deleted flow's registry bookkeeping. `installedRegistryFlows` is
/// what the browse UI reads to say "✓ installed" and what the inline search
/// uses to hide flows you already have — leaving an entry for a file that
/// no longer exists makes a deleted flow both wrongly-marked and
/// impossible to reinstall from search. Cheap no-op for non-registry flows.
///
/// User layer only: every entry's `filename` names a file in
/// `userFlowsDir()` (see `registry.ts`, which mints
/// `installed-<registryId>-<entryId>.yaml` there), so a project-layer flow
/// that happens to share the name refers to a different file entirely.
function forgetInstalledFlow(filename: string): void {
  const settings = Store.load().settings;
  const list = settings.installedRegistryFlows ?? [];
  const kept = list.filter((i) => i.filename !== filename);
  if (kept.length !== list.length) {
    Store.saveSettings({ ...settings, installedRegistryFlows: kept });
  }
}

/// Delete a flow file. The caller specifies which layer to delete from
/// (you might have a flow with the same id in both layers and only want to
/// remove one). The `projectPath` is required when source === 'project'.
export function deleteFlow(args: {
  flowId: string;
  source: Flow['source'];
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
    args.source === 'user'
      ? userFlowsDir()
      : args.source === 'generated'
        ? generatedFlowsDir()
        : projectFlowsDir(args.projectPath ?? '');
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
    if (args.source === 'user') forgetInstalledFlow(path.basename(filePath));
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
