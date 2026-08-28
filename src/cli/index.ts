#!/usr/bin/env node
// `overcli` — the flows and workers you built in the app, run from a command
// line: one-shot in CI, or on a box you own.
//
// There is no second runtime here. This file installs a host (src/main/host.ts)
// and drives the same RunnerManager / FlowRuntimeImpl / WorkerEngine the
// desktop app drives. Anything that behaves differently headless does so
// because of an explicit decision — the permission policy, the ignored
// cadence, the state directory — not because the code path is different.
//
// Nothing on this file's import graph may reach `electron`. `cli.noElectron.test.ts`
// enforces that; the packaged CLI runs under plain node, where importing it
// throws at require time and would take every command down with it.

import fs from 'node:fs';
import path from 'node:path';

import { HELP, parseArgs } from './args';
import { EXIT, makeReporter, runFile, writeArtifacts } from './run';

function version(): string {
  try {
    // Two levels up from dist/cli/, and from src/cli/ when run through tsx.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return String(pkg.version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n\nTry: overcli --help\n`);
    return EXIT.BAD_INPUT;
  }
  const { command, run: opts, warnings } = parsed.args;

  if (command === 'help') {
    process.stdout.write(HELP);
    return EXIT.OK;
  }
  if (command === 'version') {
    process.stdout.write(`${version()}\n`);
    return EXIT.OK;
  }
  if (!opts) return EXIT.BAD_INPUT;

  const reporter = makeReporter(opts.json);
  for (const w of warnings) reporter.warn(w);

  const { summary, engines } = await runFile(opts, reporter);
  summary.warnings.unshift(...warnings);

  if (opts.artifactsDir && summary.runId && engines) {
    try {
      const written = writeArtifacts(opts.artifactsDir, engines.flowRuntime.getRun(summary.runId));
      summary.artifacts = written.map((p) => ({ name: path.basename(p), path: p }));
      if (written.length > 0) reporter.progress(`wrote ${written.length} artifact(s) to ${opts.artifactsDir}`);
    } catch (err) {
      reporter.warn(`could not write artifacts: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  engines?.dispose();

  if (opts.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    process.stdout.write(`\n${summary.status}${summary.error ? ` — ${summary.error}` : ''}\n`);
    for (const s of summary.steps) process.stdout.write(`  ${s.id}: ${s.status}\n`);
    for (const w of summary.warnings) process.stdout.write(`  ! ${w}\n`);
  }
  return summary.exitCode;
}

// `require.main === module` rather than a bare call: `main` is imported by the
// tests, and a top-level invocation would run a flow every time the suite
// loaded this file.
if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      // The runner keeps handles open (reconcile timer, backend procs) that
      // dispose() cannot always retract in time. An explicit exit is the
      // difference between a job that finishes and one that hangs until the
      // CI timeout with the answer already printed.
      process.exit(code);
    })
    .catch((err) => {
      process.stderr.write(`overcli: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(EXIT.RUN_FAILED);
    });
}
