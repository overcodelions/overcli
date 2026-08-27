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

import os from 'node:os';
import path from 'node:path';

import { useTestHost } from './testHost';

useTestHost(path.join(os.tmpdir(), `overcli-test-default-${process.pid}`));
