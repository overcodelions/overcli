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
type ConversationExtender = (conversationId: string) => Record<string, string>;

let conversationExtenders: ConversationExtender[] = [];

/// What a run's own process adds for its conversation (a worker's cloud role,
/// workerCloud.ts). Returns the undo, for tests.
export function addConversationEnv(fn: ConversationExtender): () => void {
  conversationExtenders = [...conversationExtenders, fn];
  return () => {
    conversationExtenders = conversationExtenders.filter((f) => f !== fn);
  };
}

/// The additions for one run's conversation. One that throws is skipped.
export function conversationEnv(conversationId: string): Record<string, string> {
  return conversationExtenders.reduce<Record<string, string>>((acc, fn) => {
    try {
      return { ...acc, ...fn(conversationId) };
    } catch {
      return acc;
    }
  }, {});
}

export function runEnv(env: NodeJS.ProcessEnv, cwd?: string): NodeJS.ProcessEnv {
  return extenders.reduce((acc, fn) => {
    try {
      return fn(acc, cwd);
    } catch {
      return acc;
    }
  }, env);
}
