// The host for everything that is not the desktop app: `overcli run` in CI,
// `overcli serve` on a box you own, and every test that needs a data
// directory without booting Electron.
//
// No electron import, direct or transitive — `src/cli/index.ts` reaches the
// engines through this file, and `cli.noElectron.test.ts` fails the build if
// anything on that path pulls electron in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { HostEnv, HostSecrets } from './host';
import { withWebhookNotify } from './webhookNotify';

/// Where a headless install keeps its state when nobody said otherwise.
/// `~/.overcli` has precedent — `diagnostics.ts` already writes its log there,
/// so a headless run and the app's own diagnostics agree on one root.
export function defaultDataDir(): string {
  const fromEnv = process.env.OVERCLI_HOME?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.overcli');
}

/// Registry tokens come from the environment headless, never from a file.
/// A CI job's data directory is routinely cached and uploaded as an artifact;
/// a bearer token written into it would travel with it. The name is
/// `OVERCLI_REGISTRY_TOKEN_<ID>`, upper-cased with non-alphanumerics folded to
/// `_`, so a registry id of `acme-flows` reads `OVERCLI_REGISTRY_TOKEN_ACME_FLOWS`.
export function registryTokenEnvName(registryId: string): string {
  return `OVERCLI_REGISTRY_TOKEN_${registryId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

const envSecrets: HostSecrets = {
  get(key) {
    return process.env[registryTokenEnvName(key)]?.trim() || null;
  },
  // Headless secrets are read-only by design: the environment is the store,
  // and writing one back would either mutate the parent process's env (which
  // dies with the job) or persist it to disk (which is the thing we are
  // avoiding). Reported rather than thrown so `flows:setRegistryAuth` can say
  // "set $OVERCLI_REGISTRY_TOKEN_X instead" rather than crashing the run.
  set() {
    return false;
  },
};

export interface NodeHostOptions {
  /// Overrides `$OVERCLI_HOME` / `~/.overcli`. The CLI passes `--state-dir`;
  /// tests pass a temp directory.
  dataDir?: string;
  /// Where `notify` writes. Defaults to stderr, so a `--json` run's stdout
  /// stays a clean stream of one JSON object.
  onNotify?: (args: { title: string; body: string }) => void;
  secrets?: HostSecrets;
}

/// A host backed by a plain directory. The directory is created on first use
/// rather than at construction: `overcli run --json` on a bad path should fail
/// with the run's own error, not leave a stray directory behind first.
export function nodeHost(options: NodeHostOptions = {}): HostEnv {
  const root = options.dataDir ? path.resolve(options.dataDir) : defaultDataDir();
  let ensured = false;
  return {
    dataDir() {
      if (!ensured) {
        fs.mkdirSync(root, { recursive: true });
        ensured = true;
      }
      return root;
    },
    secrets: options.secrets ?? envSecrets,
    // The wrap goes OUTSIDE the `??`, not on the default: `overcli run`
    // supplies its own `onNotify` (cli/run.ts routes it into the reporter),
    // so wrapping only the stderr fallback would leave every real headless
    // run with no webhook at all.
    notify: withWebhookNotify(
      options.onNotify ?? ((args) => process.stderr.write(`${args.title}: ${args.body}\n`)),
    ),
  };
}
