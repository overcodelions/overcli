// A connected repo's test command, run by the server before it pushes a
// worker's change (landBranches.ts): as the test user when one is set, with
// no server secrets in its environment.

import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import { testUserRefusal } from '../main/org/repos';
import { stripSecrets } from '../main/org/secrets';
import { runEnv } from '../main/runEnv';
import { SETPRIV, asWorkerUser } from '../main/org/workerUser';

export type RepoTestResult = { ok: true } | { ok: false; error: string; refused?: true };

export interface RepoTestDeps {
  env: NodeJS.ProcessEnv;
  /// `child_process.execFile`, or a stand-in for tests.
  execFile: (
    file: string,
    args: string[],
    options: { cwd: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv; uid?: number; gid?: number },
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => unknown;
  /// Switch user through setpriv rather than execFile's uid option. On by
  /// default on Linux where it is installed: a server that holds capabilities
  /// (the worker-user entrypoint) would otherwise pass them to the tests, since
  /// a switch between two non-root users keeps ambient capabilities.
  setpriv?: boolean;
}

/// Run `command` in `cwd` through the shell. Refused, without running, when
/// the server has no safe user to run it as (testUserRefusal).
export function runRepoTests(command: string, cwd: string, deps: RepoTestDeps = { env: process.env, execFile: nodeExecFile as RepoTestDeps['execFile'] }): Promise<RepoTestResult> {
  return new Promise((resolve) => {
    const refusal = testUserRefusal(deps.env);
    if (refusal) return resolve({ ok: false, error: refusal, refused: true });
    // Set OVERCLI_TEST_UID to run repo tests as a user that cannot read the data directory (secrets.key).
    const uid = deps.env.OVERCLI_TEST_UID?.trim();
    const gid = deps.env.OVERCLI_TEST_GID?.trim() || uid;
    try {
      const viaSetpriv = !!uid && (deps.setpriv ?? (process.platform === 'linux' && fs.existsSync(SETPRIV)));
      const launch = viaSetpriv
        ? asWorkerUser({ uid: Number(uid), gid: Number(gid) }, '/bin/sh', ['-c', command])
        : { command: '/bin/sh', args: ['-c', command] };
      deps.execFile(launch.command, launch.args, { cwd, timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024, env: stripSecrets(runEnv(deps.env, cwd)),
        ...(uid && !viaSetpriv ? { uid: Number(uid), gid: Number(gid) } : {}) }, (err, stdout, stderr) =>
        resolve(err ? { ok: false, error: `${stdout}${stderr}`.trim() || err.message } : { ok: true }),
      );
    } catch (err) {
      // Some bad ids (out of range, say) throw here instead of reaching the callback.
      const as = uid ? ` as user ${uid}${gid !== uid ? ` (group ${gid})` : ''}` : '';
      resolve({ ok: false, error: `Could not run the tests${as}: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}
