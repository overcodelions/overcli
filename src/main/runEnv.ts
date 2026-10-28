// What a worker's process and a repo's tests start with, beyond the app's own
// environment: installed toolchains (org/toolchains.ts), set by whoever owns
// them. Kept here so the runner needn't know about the org.

type Extender = (env: NodeJS.ProcessEnv, cwd?: string) => NodeJS.ProcessEnv;

let extenders: Extender[] = [];

/// Returns the undo, for tests.
export function addRunEnv(fn: Extender): () => void {
  extenders = [...extenders, fn];
  return () => {
    extenders = extenders.filter((f) => f !== fn);
  };
}

/// `env` as a run in `cwd` sees it. An extender that throws is skipped: a
/// toolchain's trouble never stops a run.
export function runEnv(env: NodeJS.ProcessEnv, cwd?: string): NodeJS.ProcessEnv {
  return extenders.reduce((acc, fn) => {
    try {
      return fn(acc, cwd);
    } catch {
      return acc;
    }
  }, env);
}
