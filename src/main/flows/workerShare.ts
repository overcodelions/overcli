// Handing a worker to another team, and taking one from them.
//
// The file format is src/shared/flows/workerYaml.ts; this is the part that
// touches the library. Two decisions live here rather than in the format:
//
//   - Export resolves the worker's flow ids against the library so the file
//     carries the machinery, not just its names. A flow the sender no longer
//     has is exported as a name only, and the importer is told.
//   - Import never overwrites a flow. If the receiving library already has
//     the id, the local one wins and the imported definition is dropped. That
//     is the safe half of the trade — a shared worker cannot silently rewrite
//     a flow other things already run — and the import reports it, so a real
//     divergence is visible rather than mysterious.
//
// Nothing here hires anybody. Import produces a draft for the hire editor;
// the user picks the project and clicks the button, which is what makes an
// arriving worker a deliberate act rather than a file that starts running.

import type { Flow } from '../../shared/flows/schema';
import type { Worker } from '../../shared/flows/worker';
import {
  parseWorkerYaml,
  serializeWorker,
  workerShareFilename,
  type WorkerBundle,
  type WorkerImportNotes,
} from '../../shared/flows/workerYaml';

export interface WorkerShareFile {
  yaml: string;
  filename: string;
  /// Ids the worker references that the library could not supply. The file is
  /// still valid — the receiving side simply has to be told these are missing.
  missingFlowIds: string[];
}

/// Build the share file for one worker against a flow library.
export function buildWorkerShare(args: {
  worker: Worker;
  library: Flow[];
  description?: string;
}): WorkerShareFile {
  const byId = new Map(args.library.map((f) => [f.id, f]));
  const flows = args.worker.flowIds
    .map((id) => byId.get(id))
    .filter((f): f is Flow => Boolean(f));
  return {
    yaml: serializeWorker({
      worker: args.worker,
      flows,
      description: args.description,
    }),
    filename: workerShareFilename(args.worker.name),
    missingFlowIds: args.worker.flowIds.filter((id) => !byId.has(id)),
  };
}

export interface WorkerImport {
  bundle: WorkerBundle;
  notes: WorkerImportNotes;
}

/// Read a share file and land its flows in the library. `saveFlow` and
/// `existingFlowIds` are injected so this stays testable without Electron —
/// index.ts passes the real storage functions.
export function importWorkerYaml(args: {
  yaml: string;
  existingFlowIds: string[];
  saveFlow: (flow: Flow) => { ok: true } | { ok: false; error: string };
}): { ok: true; result: WorkerImport } | { ok: false; error: string } {
  const parsed = parseWorkerYaml(args.yaml);
  if (!parsed.ok) return parsed;

  const existing = new Set(args.existingFlowIds);
  const notes: WorkerImportNotes = {
    installedFlowIds: [],
    reusedFlowIds: [],
    missingFlowIds: [...parsed.missingFlowIds],
    failedFlowIds: [],
  };

  for (const flow of parsed.bundle.flows) {
    if (existing.has(flow.id)) {
      notes.reusedFlowIds.push(flow.id);
      continue;
    }
    const saved = args.saveFlow(flow);
    if (saved.ok) {
      notes.installedFlowIds.push(flow.id);
      existing.add(flow.id);
    } else {
      // A flow that would not save is a flow the worker cannot launch, which
      // is the same situation as one that never arrived.
      notes.failedFlowIds.push({ id: flow.id, error: saved.error });
      notes.missingFlowIds.push(flow.id);
    }
  }

  return { ok: true, result: { bundle: parsed.bundle, notes } };
}

/// One line for the import banner. Deliberately says the missing flows last
/// and plainly: it is the only part that means the worker will arrive unable
/// to do its job.
export function describeImport(notes: WorkerImportNotes): string {
  const parts: string[] = [];
  if (notes.installedFlowIds.length > 0) {
    parts.push(
      `Added ${notes.installedFlowIds.length} flow${notes.installedFlowIds.length === 1 ? '' : 's'} to your library (${notes.installedFlowIds.join(', ')}).`,
    );
  }
  if (notes.reusedFlowIds.length > 0) {
    parts.push(
      `Kept your own ${notes.reusedFlowIds.join(', ')} — the file's version was not installed.`,
    );
  }
  if (notes.missingFlowIds.length > 0) {
    parts.push(
      `Missing: ${notes.missingFlowIds.join(', ')}. The worker cannot launch ${notes.missingFlowIds.length === 1 ? 'it' : 'them'} until you add ${notes.missingFlowIds.length === 1 ? 'it' : 'them'}.`,
    );
  }
  return parts.join(' ');
}
