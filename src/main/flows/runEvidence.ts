// A run's evidence: files a tool made for the run (the screenshots the
// test-systems tool takes), kept by the server, never in a repo, and shown
// with the run's Files. Removed with the run.
//
// Under the folder the server starts relayed tools in (tool-home, runner.ts
// relayLaunchFor), because a tool that uploads a file takes it only from
// inside its own working folder: the Jira tool attaches a screenshot from
// here, and from nowhere a worker could write.

import fs from 'node:fs';
import path from 'node:path';

import { host } from '../host';

const MAX_FILES = 50;
const MAX_BYTES = 16 * 1024 * 1024;

export function runEvidenceDir(runId: string): string {
  return path.join(host().dataDir(), 'tool-home', 'run-evidence', runId.replace(/[^A-Za-z0-9-]/g, ''));
}

/// The files in a run's evidence folder, oldest first.
export function runEvidenceFiles(runId: string): Array<{ name: string; path: string; bytes: number }> {
  const dir = runEvidenceDir(runId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; path: string; bytes: number; at: number }> = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      out.push({ name, path: full, bytes: st.size, at: st.mtimeMs });
    } catch {
      // Gone meanwhile.
    }
  }
  return out
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_FILES)
    .map(({ name, path: p, bytes }) => ({ name, path: p, bytes }));
}

export function removeRunEvidence(runId: string): void {
  try {
    fs.rmSync(runEvidenceDir(runId), { recursive: true, force: true });
  } catch {
    // Nothing kept, or already gone.
  }
}
