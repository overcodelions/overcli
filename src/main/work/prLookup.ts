// Which PR did a branch end up in?
//
// PRs get opened in many places — the review sheet, a flow step running
// `gh pr create`, by hand in a terminal — and none of them leave a record the
// app keeps. Asking GitHub by branch catches all of them, including work that
// happened before this existed.
//
// One `gh pr list` per repo, cached. Anything that fails (no gh, not a GitHub
// remote, not signed in) is an empty list: a record without its PR is still a
// record.

import { execFile } from 'node:child_process';

import { gitEnv } from '../git';
import type { WorkPr } from '../../shared/workRecords';

const TTL_MS = 10 * 60_000;
const CONCURRENCY = 4;

const cache = new Map<string, { at: number; prs: WorkPr[] }>();

function listPrs(repoPath: string): Promise<WorkPr[]> {
  const hit = cache.get(repoPath);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.prs);
  const args = [
    'gh',
    'pr',
    'list',
    '--state',
    'all',
    '--limit',
    '200',
    '--json',
    'number,url,state,title,headRefName,mergedAt',
  ];
  const [cmd, ...rest] = process.platform === 'win32' ? args : ['/usr/bin/env', ...args];
  return new Promise((resolve) => {
    execFile(cmd, rest, { cwd: repoPath, env: gitEnv(), timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      let prs: WorkPr[] = [];
      if (!err) {
        try {
          const parsed = JSON.parse(stdout) as WorkPr[];
          if (Array.isArray(parsed)) prs = parsed;
        } catch {
          // Unexpected output — treat as no PRs.
        }
      }
      cache.set(repoPath, { at: Date.now(), prs });
      resolve(prs);
    });
  });
}

export async function lookupPrs(repoPaths: string[]): Promise<Record<string, WorkPr[]>> {
  const unique = [...new Set(repoPaths)];
  const out: Record<string, WorkPr[]> = {};
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const repo = unique[next++];
      out[repo] = await listPrs(repo);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  return out;
}
