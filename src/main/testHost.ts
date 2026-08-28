// The host a test installs. Not shipped — nothing outside `*.test.ts` imports
// this — but it lives beside the production hosts rather than in a fixtures
// directory because it is the third implementation of `HostEnv` and drifts if
// it is kept somewhere the other two are not.
//
// This replaces the stanza that used to open two dozen suites:
//
//   vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }));
//
// which worked only because every store reached the disk through
// `app.getPath('userData')`. Now they reach it through `host()`, so a suite
// says where its data directory is instead of impersonating Electron.
//
// `dataDir` takes a thunk as well as a string on purpose: most suites point it
// at a `let` they rewrite in `beforeEach` to get a fresh temp directory per
// test, and a value captured once at install time would send every test in the
// file to the first one's directory.

import { setHost, type HostEnv } from './host';

export interface TestHostHandle {
  /// Every notification the code under test raised, in order. Lets a suite
  /// assert that a shift actually told somebody, which was unobservable when
  /// notifications went straight to `new Notification()`.
  notifications: Array<{ title: string; body: string }>;
  secrets: Map<string, string>;
}

/// Install a host backed by a plain directory and an in-memory secret map.
/// Deliberately does NOT create the directory: the old electron mock did not
/// either, and the stores under test are the things responsible for calling
/// `mkdirSync` — a helper that pre-created the root would hide a store that
/// forgot to.
export function useTestHost(dataDir: string | (() => string)): TestHostHandle {
  const handle: TestHostHandle = { notifications: [], secrets: new Map() };
  const env: HostEnv = {
    dataDir: () => (typeof dataDir === 'function' ? dataDir() : dataDir),
    secrets: {
      get: (key) => handle.secrets.get(key) ?? null,
      set: (key, value) => {
        if (value == null || value === '') handle.secrets.delete(key);
        else handle.secrets.set(key, value);
        return true;
      },
    },
    notify: (args) => {
      handle.notifications.push(args);
    },
  };
  setHost(env);
  return handle;
}
