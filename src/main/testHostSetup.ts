// Vitest setup file: installs a default host before any test module is
// imported. Registered in vitest.config.ts.
//
// This exists because of an ordering rule, not for convenience. `host()`
// throws when nothing is installed, and a handful of modules — the worker
// engine's default deps most visibly — reach a store while they are being
// imported. Every ES import in a test file is fully evaluated before the
// file's first top-level statement runs, so a `useTestHost(...)` line in the
// test file itself is already too late for those.
//
// The directory here is a per-process scratch root that no assertion should
// ever look at. A suite that cares where its files land calls `useTestHost`
// at its own top level and overwrites this one, which happens before any
// `it()` body runs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { useTestHost } from './testHost';

// A scratch HOME for the whole run. Several paths are fixed under the user's
// home rather than the host's data directory — `~/.overcli/session.log`,
// `worktrees/`, `attachments/`, `inbox/` — and without this every test that
// logs or reaches one of them wrote into the real ~/.overcli. The inbox is
// the sharp case: other tools read that folder existing as "overcli is
// installed". `os.homedir()` reads $HOME on macOS and Linux, so this covers
// every caller without each one growing a test seam.
//
// Git still needs an identity for the suites that commit, and it used to
// find one in the real ~/.gitconfig.
//
// One fixed folder, reused: this file runs once per test file, and a fresh
// temp dir each time left a few hundred behind per run.
const home = path.join(os.tmpdir(), 'overcli-test-home');
fs.mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.GIT_AUTHOR_NAME ??= 'overcli test';
process.env.GIT_AUTHOR_EMAIL ??= 'test@example.com';
process.env.GIT_COMMITTER_NAME ??= 'overcli test';
process.env.GIT_COMMITTER_EMAIL ??= 'test@example.com';

useTestHost(path.join(os.tmpdir(), `overcli-test-default-${process.pid}`));
