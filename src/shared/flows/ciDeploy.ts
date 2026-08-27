// Turning a worker into a CI job: the same share bundle plus a pipeline file
// (GitHub Actions or Jenkins) that fires it on a schedule. Pure generator —
// no fs, no electron, no path — so it stays testable and the preview in the
// renderer is exactly what gets written to disk.
//
// The generated files reference an `overcli` CLI (`overcli run`, `overcli
// setup --mcp`) that does not ship yet. That is expected here: this module
// only produces the files a project would commit, it does not run them.

import { type Flow, resolveStepModel } from './schema';
import type { ScheduleTrigger } from './schedule';
import type { Worker } from './worker';
import type { Backend } from '../types';

export type CiTarget = 'github' | 'jenkins';

/// The prerequisite neither generated file can satisfy for itself.
///
/// Both pipelines start by installing the `overcli` CLI — the GitHub one via
/// `overcodelions/setup-overcli@v1`, the Jenkins one via `npm i -g overcli`.
/// Neither exists yet: the package is a 404 on npm and the action has never
/// been published. So a job created from these files fails at its SETUP step,
/// before it reaches anything Overcli generated, with an error that points at
/// GitHub or npm rather than at the real cause.
///
/// Surfaced as a warning rather than a checklist item because it is not
/// something the user can tick off — it blocks the job outright, and someone
/// deploying deserves to know that before they commit a file, not after a red
/// build. Delete this and the two `installLine` branches once the CLI ships.
export const CI_CLI_NOT_PUBLISHED =
  'The overcli CLI is not published yet — `npm i -g overcli` 404s and ' +
  'overcodelions/setup-overcli@v1 does not exist. This job will fail at its setup step until ' +
  'that ships. The rest of the file is correct and worth committing now; the setup step is the ' +
  'only line that needs changing later.';

/// How the checklist names a secret, which is not the same word in both
/// systems. GitHub has repository secrets under Settings; Jenkins has
/// credentials with an ID, and the generated Jenkinsfile references them by
/// that ID through `withCredentials`. Telling a Jenkins user to "create a
/// repository secret" names a thing their UI does not have.
function secretInstruction(target: CiTarget, name: string, what: string): string {
  return target === 'github'
    ? `Create the repository secret ${name} for ${what} — Settings → Secrets and variables → Actions.`
    : `Add a "Secret text" credential with the ID ${name} for ${what} — Manage Jenkins → Credentials.`;
}

export interface CiDeployFile {
  path: string;
  contents: string;
}

export interface CiDeployPlan {
  files: CiDeployFile[];
  checklist: string[];
  warnings: string[];
}

/// A filename-safe slug for the worker, matching `workerShareFilename`'s
/// rules so the bundle path and the pipeline path read as a matched pair.
export function ciSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'worker'
  );
}

/// A worker's cadence, rendered as the cron expression a CI scheduler
/// understands. `null` means on demand — there is no cron for that, the
/// caller has to trigger the job by hand.
export function cronFromCadence(c: ScheduleTrigger | null): string | null {
  if (c === null) return null;
  const dayField = c.days && c.days.length > 0 ? [...c.days].sort((a, b) => a - b).join(',') : '*';
  if (c.kind === 'daily') {
    const parts = c.time.split(':');
    const hh = parseInt(parts[0], 10);
    const mm = parseInt(parts[1], 10);
    return `${mm} ${hh} * * ${dayField}`;
  }
  const mins = Math.max(1, Math.floor(c.everyMinutes));
  let startH = 0;
  let startM = 0;
  let endH = 23;
  if (c.window) {
    const start = c.window.start.split(':');
    const end = c.window.end.split(':');
    startH = parseInt(start[0], 10);
    startM = parseInt(start[1], 10);
    endH = parseInt(end[0], 10);
  }
  let minuteField: string;
  let hourField: string;
  if (mins < 60) {
    minuteField = '*/' + mins;
    hourField = c.window ? hourRange(startH, endH) : '*';
  } else {
    const hours = Math.max(1, Math.round(mins / 60));
    minuteField = String(c.window ? startM : 0);
    hourField = c.window ? `${hourRange(startH, endH)}/${hours}` : '*/' + hours;
  }
  return `${minuteField} ${hourField} * * ${dayField}`;
}

/// The hour field for an active window. `ScheduleTrigger.window` allows
/// `start` after `end` to mean a window that wraps midnight (22:00–02:00) —
/// see `schedule.ts`. A plain `start-end` range is descending in that case,
/// which cron parsers reject outright, so a wrapping window is split into
/// two ranges joined with a comma instead.
function hourRange(startH: number, endH: number): string {
  return startH <= endH ? `${startH}-${endH}` : `${startH}-23,0-${endH}`;
}

/// The permission policy a generated job runs with. Never `auto-approve` —
/// an unattended CI runner is not a place to skip approval, whatever the
/// worker's trust level.
export function ciPermissions(worker: Worker): 'deny' | 'allow-list' {
  return worker.trust === 'probation' ? 'deny' : 'allow-list';
}

/// Tools an `allow-list` job starts with.
///
/// `--permissions allow-list` with no `--allow-tool` denies everything, which
/// is `deny` wearing a different hat — a generated job that looked configured
/// and could not read a file. These three are the read-only set the runtime
/// itself classifies as local (`resolveStepEffect`), so seeding them makes the
/// job able to work without widening anything that could push, message, or
/// mutate. Anything beyond this is the user's call, and the checklist says so.
export const CI_DEFAULT_ALLOW_TOOLS = ['Read', 'Grep', 'Glob'];

/// MCP server names that are safe to interpolate into a generated pipeline.
///
/// `mcpServers` travels in a shared worker bundle and `coerceMcpServers`
/// (workerYaml.ts) only checks it is a non-empty string — so the name is
/// attacker-controlled text arriving from whoever sent the file. It then lands
/// in two shell contexts here: a GitHub `run:` line and a single-quoted
/// Groovy `sh '...'`. A name containing a quote, a semicolon or a newline
/// escapes either one and executes on the runner, with the job's secrets in
/// scope — and the generated file is committed, so it runs on every shift.
///
/// The env-var path already folds these names down to `[A-Z0-9_]`; this is the
/// same rule for the command path, which was missed. Names that do not match
/// are DROPPED rather than escaped: a server whose name is not a plain
/// identifier is not a server the runner could resolve anyway, and dropping is
/// the behaviour `resolveMcpScope` already has for names that do not exist.
const SAFE_MCP_NAME = /^[A-Za-z0-9._-]+$/;

export function partitionMcpNames(names: string[]): { safe: string[]; rejected: string[] } {
  const safe: string[] = [];
  const rejected: string[] = [];
  for (const n of names) (SAFE_MCP_NAME.test(n) ? safe : rejected).push(n);
  return { safe, rejected };
}

/// Every backend this worker's turns might touch: its heartbeat, plus
/// whatever its flows' steps resolve to. The runner needs all of them
/// installed, not just the heartbeat's.
export function ciBackends(worker: Worker, flows: Flow[]): Backend[] {
  const set = new Set<Backend>();
  set.add(worker.heartbeatBackend ?? 'claude');
  for (const flow of flows) {
    for (const step of flow.steps) {
      set.add(resolveStepModel(flow, step).backend);
    }
  }
  return [...set].sort();
}

/// Deploy a FLOW as a CI job.
///
/// Simpler than the worker case, and deliberately so. A worker carries a
/// cadence, a trust level, a journal and a budget — the four things that need
/// `--trust`, `--state-dir` and a cache step. A flow has none of them: it is a
/// pipeline you hand a prompt, it keeps nothing between runs, and two of them
/// running at once collide over nothing. So this emits no state directory, no
/// concurrency group, and no schedule.
///
/// What it DOES need that a worker does not is the prompt. A worker plans its
/// own shift; a flow's `user_prompt` is an argument, so it has to be baked into
/// the job (or supplied by a `workflow_dispatch` input, which is what the
/// GitHub form does).
export function buildFlowCiDeploy(args: {
  flow: Flow;
  target: CiTarget;
  flowYaml: string;
  /// The `user_prompt` the job launches with. Falls back to the flow's own
  /// `default_prompt`, which is the line the launch composer prefills.
  prompt?: string;
  /// Tools the job may use. Anything outside this is denied, because there is
  /// nobody to approve it — see the CLI's --permissions.
  allowTools?: string[];
  runIn?: 'cwd' | 'worktree';
}): CiDeployPlan {
  const { flow, target } = args;
  const slug = ciSlug(flow.id || flow.name);
  const flowPath = `.overcli/flows/${slug}.yaml`;
  const prompt = (args.prompt ?? flow.defaultPrompt ?? '').trim();
  const { safe: allowTools, rejected: rejectedTools } = partitionToolNames(
    args.allowTools ?? CI_DEFAULT_ALLOW_TOOLS,
  );
  const runIn = args.runIn ?? 'cwd';

  const backends = new Set<Backend>();
  for (const step of flow.steps) backends.add(resolveStepModel(flow, step).backend);
  const installBackends = [...backends].filter((b) => b !== 'ollama').sort();
  if (installBackends.length === 0) installBackends.push('claude');

  const warnings: string[] = [CI_CLI_NOT_PUBLISHED];
  if (backends.has('ollama')) {
    warnings.push(
      'This flow uses local Ollama models, which stock runners do not have. Add --model-override ollama=claude:<model> or use a self-hosted runner with a GPU.',
    );
  }
  if (!prompt) {
    warnings.push(
      'This flow has no default prompt, so the job launches with an empty user_prompt. Set one here, or edit --input in the generated file.',
    );
  }
  if (rejectedTools.length > 0) {
    warnings.push(`Dropped tool name(s) that are not plain identifiers: ${rejectedTools.join(', ')}.`);
  }
  // The tools the flow's steps actually ask for, minus what the job allows.
  // Under the CLI's policy the intersection is what runs, so a step asking for
  // Bash on a Read-only allow-list silently does less than the flow says.
  const declared = new Set(flow.steps.flatMap((s) => s.tools ?? []));
  const unmet = [...declared].filter((t) => !allowTools.includes(t));
  if (unmet.length > 0) {
    warnings.push(
      `Steps ask for ${unmet.join(', ')}, which the job does not allow. Those calls will be denied. ` +
        'Add them to the allowed tools if the flow needs them.',
    );
  }

  const checklist: string[] = [secretInstruction(target, 'ANTHROPIC_API_KEY', 'the Claude backend')];
  checklist.push(
    `The job may use ${allowTools.length > 0 ? allowTools.join(', ') : 'no tools at all'}. ` +
      'Everything else is denied, because there is nobody to approve it.',
  );
  if (runIn === 'worktree') {
    checklist.push('runs in a worktree, so changes land on a branch — add a step to push or open a PR if you want them kept.');
  }
  checklist.push(
    target === 'github'
      ? 'Trigger it from the Actions tab (Run workflow), or add an on.schedule block for a timer.'
      : 'Trigger it from Jenkins (Build with Parameters), or add a triggers { cron(...) } block for a timer.',
  );
  checklist.push('Commit and push these files.');

  const pipeline =
    target === 'github'
      ? githubFlowFile({ slug, name: flow.name, flowPath, prompt, allowTools, installBackends, runIn })
      : jenkinsFlowFile({ slug, flowPath, prompt, allowTools, installBackends, runIn });

  return { files: [{ path: flowPath, contents: args.flowYaml }, pipeline], checklist, warnings };
}

/// Tool names are interpolated into a shell line, exactly like MCP names.
/// Same rule, same reason — see SAFE_MCP_NAME.
function partitionToolNames(names: string[]): { safe: string[]; rejected: string[] } {
  const safe: string[] = [];
  const rejected: string[] = [];
  for (const n of names) (/^[A-Za-z0-9_()*:.-]+$/.test(n) ? safe : rejected).push(n);
  return { safe, rejected };
}

export function buildCiDeploy(args: {
  worker: Worker;
  flows: Flow[];
  target: CiTarget;
  workerYaml: string;
  missingFlowIds?: string[];
}): CiDeployPlan {
  const { worker, target } = args;
  const slug = ciSlug(worker.name);
  const cron = cronFromCadence(worker.cadence);
  const perms = ciPermissions(worker);
  // A worker bundle deliberately does not carry its trust (workerYaml.ts), so
  // the CLI defaults to probation — which parks every proposal and exits 2.
  // The desk knows the real level, so the generated job carries it explicitly.
  const trust = worker.trust;
  const allowTools = perms === 'allow-list' ? CI_DEFAULT_ALLOW_TOOLS : [];
  const backends = ciBackends(worker, args.flows);
  // A worker whose every backend is Ollama would otherwise leave the runner
  // with nothing installed at all; the Ollama warning below already points
  // at --model-override, which needs *something* on the runner to override
  // to, so this falls back to Claude rather than an empty install list.
  const installBackends = backends.filter((b) => b !== 'ollama');
  if (installBackends.length === 0) installBackends.push('claude');
  const { safe: mcp, rejected: rejectedMcp } = partitionMcpNames(worker.mcpServers ?? []);
  const bundlePath = '.overcli/workers/' + slug + '.worker.yaml';

  const warnings: string[] = [CI_CLI_NOT_PUBLISHED];
  if (backends.includes('ollama')) {
    warnings.push(
      'This worker uses local Ollama models, which stock runners do not have. Add --model-override ollama=claude:<model> or use a self-hosted runner with a GPU.',
    );
  }
  if (rejectedMcp.length > 0) {
    warnings.push(
      `Dropped ${rejectedMcp.length} MCP server name(s) that are not plain identifiers: ` +
        `${rejectedMcp.map((n) => JSON.stringify(n)).join(', ')}. ` +
        'A name with quotes, semicolons or newlines would become a command in the generated pipeline.',
    );
  }
  if (args.missingFlowIds?.length) {
    warnings.push(`Flows not in your library travel as names only: ${args.missingFlowIds.join(', ')}.`);
  }
  if (
    worker.cadence?.kind === 'interval' &&
    worker.cadence.everyMinutes >= 60 &&
    worker.cadence.everyMinutes % 60 !== 0
  ) {
    warnings.push('Cadence was rounded to the nearest hour — cron cannot express it exactly.');
  }
  if (cron === null) {
    warnings.push('This worker is on demand, so the job has no schedule — trigger it manually.');
  }
  if (worker.trust === 'probation') {
    warnings.push(
      'This worker is on probation, so the job parks every proposal for review and exits 2 without doing the work. ' +
        'Promote it on the trust ladder first, or edit --trust in the generated file.',
    );
  }

  const checklist: string[] = [secretInstruction(target, 'ANTHROPIC_API_KEY', 'the Claude backend')];
  for (const name of mcp) {
    checklist.push(
      secretInstruction(
        target,
        `OVERCLI_MCP_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TOKEN`,
        `the ${name} MCP server`,
      ),
    );
  }
  if (cron) {
    checklist.push(
      target === 'github'
        ? 'GitHub cron runs in UTC, and your cadence was written in local time — adjust the cron line if the hour matters.'
        : 'Jenkins cron runs in the agent’s timezone — adjust the cron line if the hour matters.',
    );
  }
  if (allowTools.length > 0) {
    checklist.push(
      `The job may use ${allowTools.join(', ')} and nothing else. Add --allow-tool names if a step needs more; ` +
        'everything not listed is denied, because there is nobody to approve it.',
    );
  }
  if (worker.budgetUSDPerMonth > 0) {
    checklist.push(
      `The monthly budget ($${worker.budgetUSDPerMonth}) only accrues if the state directory survives between runs — the cached .overcli-state step does that.`,
    );
  }
  checklist.push('Commit and push these files, then pause the local worker so shifts do not run in two places.');

  const pipelineFile =
    args.target === 'github'
      ? githubFile({ slug, cron, perms, trust, allowTools, installBackends, mcp, bundlePath })
      : jenkinsFile({ slug, cron, perms, trust, allowTools, installBackends, mcp, bundlePath });

  return {
    files: [{ path: bundlePath, contents: args.workerYaml }, pipelineFile],
    checklist,
    warnings,
  };
}

function allowToolsFlag(allowTools: string[]): string {
  return allowTools.length > 0 ? ` --allow-tool ${allowTools.join(',')}` : '';
}

function githubFile(args: {
  slug: string;
  cron: string | null;
  perms: 'deny' | 'allow-list';
  trust: Worker['trust'];
  allowTools: string[];
  installBackends: Backend[];
  mcp: string[];
  bundlePath: string;
}): CiDeployFile {
  const { slug, cron, perms, trust, allowTools, installBackends, mcp, bundlePath } = args;
  const lines: string[] = [];
  lines.push('# Generated by Overcli. Safe to edit.');
  lines.push(`name: overcli-${slug}`);
  lines.push('on:');
  if (cron !== null) {
    lines.push('  schedule:');
    lines.push(`    - cron: "${cron}"`);
  }
  lines.push('  workflow_dispatch:');
  lines.push(`concurrency: overcli-worker-${slug}`);
  lines.push('jobs:');
  lines.push('  shift:');
  lines.push('    runs-on: ubuntu-latest');
  lines.push('    steps:');
  lines.push('      - uses: actions/checkout@v4');
  lines.push('        with:');
  lines.push('          fetch-depth: 0');
  lines.push('      - uses: overcodelions/setup-overcli@v1');
  lines.push('        with:');
  lines.push(`          backends: ${installBackends.join(',')}`);
  if (mcp.length > 0) {
    lines.push(`      - run: overcli setup --mcp ${mcp.join(' ')}`);
    lines.push('        env:');
    for (const name of mcp) {
      const upper = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      lines.push(`          OVERCLI_MCP_${upper}_TOKEN: \${{ secrets.OVERCLI_MCP_${upper}_TOKEN }}`);
    }
  }
  lines.push('      - uses: actions/cache@v4');
  lines.push('        with:');
  lines.push('          path: .overcli-state');
  lines.push(`          key: overcli-worker-${slug}`);
  lines.push(
    `      - run: overcli run ${bundlePath} --state-dir .overcli-state${allowToolsFlag(allowTools)} --permissions ${perms} --trust ${trust} --run-in cwd --artifacts-dir out --json > run.json`,
  );
  lines.push('        env:');
  lines.push('          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}');
  lines.push('      - uses: actions/upload-artifact@v4');
  lines.push('        if: always()');
  lines.push('        with:');
  lines.push(`          name: overcli-${slug}`);
  lines.push('          path: out');
  return { path: `.github/workflows/overcli-${slug}.yml`, contents: lines.join('\n') + '\n' };
}

/// The npm package each backend's CLI ships as, for the Jenkins Setup stage
/// (GitHub gets this for free from `setup-overcli@v1`'s own `backends:`
/// input). Ollama is never a key — it never reaches `installBackends`.
const BACKEND_PACKAGES: Partial<Record<Backend, string>> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
  copilot: '@github/copilot',
};

function jenkinsFile(args: {
  slug: string;
  cron: string | null;
  perms: 'deny' | 'allow-list';
  trust: Worker['trust'];
  allowTools: string[];
  installBackends: Backend[];
  mcp: string[];
  bundlePath: string;
}): CiDeployFile {
  const { slug, cron, perms, trust, allowTools, installBackends, mcp, bundlePath } = args;
  const packages = installBackends.map((b) => BACKEND_PACKAGES[b]).filter((p): p is string => Boolean(p));
  const lines: string[] = [];
  lines.push('// Generated by Overcli. Safe to edit.');
  lines.push('pipeline {');
  lines.push('  agent any');
  lines.push('  options { disableConcurrentBuilds() }');
  if (cron !== null) {
    lines.push(`  triggers { cron('${cron}') }`);
  }
  lines.push('  environment { OVERCLI_STATE = "${WORKSPACE}/.overcli-state" }');
  lines.push('  stages {');
  lines.push("    stage('Setup') {");
  lines.push('      steps {');
  lines.push(`        sh 'npm i -g overcli ${packages.join(' ')}'`);
  if (mcp.length > 0) {
    lines.push(`        sh 'overcli setup --mcp ${mcp.join(' ')}'`);
  }
  lines.push('      }');
  lines.push('    }');
  lines.push("    stage('Shift') {");
  lines.push('      steps {');
  const credentials = [
    "string(credentialsId: 'ANTHROPIC_API_KEY', variable: 'ANTHROPIC_API_KEY')",
    ...mcp.map((name) => {
      const upper = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      return `string(credentialsId: 'OVERCLI_MCP_${upper}_TOKEN', variable: 'OVERCLI_MCP_${upper}_TOKEN')`;
    }),
  ];
  lines.push(`        withCredentials([${credentials.join(', ')}]) {`);
  lines.push(
    `          sh 'overcli run ${bundlePath} --state-dir "$OVERCLI_STATE"${allowToolsFlag(allowTools)} --permissions ${perms} --trust ${trust} --run-in cwd --artifacts-dir out --json > run.json'`,
  );
  lines.push('        }');
  lines.push('      }');
  lines.push('    }');
  lines.push('  }');
  lines.push("  post { always { archiveArtifacts artifacts: 'out/**, run.json', allowEmptyArchive: true } }");
  lines.push('}');
  return { path: `Jenkinsfile.overcli-${slug}`, contents: lines.join('\n') + '\n' };
}

/// A flow's prompt travels as a `workflow_dispatch` input with the baked-in
/// value as its default, so the same job can be re-run against a different ask
/// from the Actions tab without editing the file. Quoted for YAML because a
/// prompt routinely contains a colon.
function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

/// Single-quoted Groovy: the only escape that matters is the quote itself.
function groovyQuote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ')}'`;
}

function githubFlowFile(args: {
  slug: string;
  name: string;
  flowPath: string;
  prompt: string;
  allowTools: string[];
  installBackends: Backend[];
  runIn: 'cwd' | 'worktree';
}): CiDeployFile {
  const { slug, name, flowPath, prompt, allowTools, installBackends, runIn } = args;
  const lines: string[] = [];
  lines.push('# Generated by Overcli. Safe to edit.');
  lines.push(`name: overcli-flow-${slug}`);
  lines.push('on:');
  lines.push('  workflow_dispatch:');
  lines.push('    inputs:');
  lines.push('      prompt:');
  lines.push(`        description: What ${name} should work on`);
  lines.push('        required: false');
  lines.push(`        default: ${yamlQuote(prompt)}`);
  lines.push('jobs:');
  lines.push('  run:');
  lines.push('    runs-on: ubuntu-latest');
  lines.push('    steps:');
  lines.push('      - uses: actions/checkout@v4');
  lines.push('        with:');
  // A shallow checkout trips the unreviewed-work guard (#210).
  lines.push('          fetch-depth: 0');
  lines.push('      - uses: overcodelions/setup-overcli@v1');
  lines.push('        with:');
  lines.push(`          backends: ${installBackends.join(',')}`);
  lines.push(
    `      - run: overcli run ${flowPath} --input "\${{ inputs.prompt }}"${allowToolsFlag(allowTools)} --permissions allow-list --run-in ${runIn} --artifacts-dir out --json > run.json`,
  );
  lines.push('        env:');
  lines.push('          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}');
  lines.push('      - uses: actions/upload-artifact@v4');
  lines.push('        if: always()');
  lines.push('        with:');
  lines.push(`          name: overcli-flow-${slug}`);
  lines.push('          path: |');
  lines.push('            out');
  lines.push('            run.json');
  return { path: `.github/workflows/overcli-flow-${slug}.yml`, contents: lines.join('\n') + '\n' };
}

function jenkinsFlowFile(args: {
  slug: string;
  flowPath: string;
  prompt: string;
  allowTools: string[];
  installBackends: Backend[];
  runIn: 'cwd' | 'worktree';
}): CiDeployFile {
  const { slug, flowPath, prompt, allowTools, installBackends, runIn } = args;
  const packages = installBackends.map((b) => BACKEND_PACKAGES[b]).filter((p): p is string => Boolean(p));
  const lines: string[] = [];
  lines.push('// Generated by Overcli. Safe to edit.');
  lines.push('pipeline {');
  lines.push('  agent any');
  lines.push('  parameters {');
  lines.push(`    string(name: 'PROMPT', defaultValue: ${groovyQuote(prompt)}, description: 'What the flow should work on')`);
  lines.push('  }');
  lines.push('  stages {');
  lines.push("    stage('Setup') {");
  lines.push('      steps {');
  lines.push(`        sh 'npm i -g overcli ${packages.join(' ')}'`);
  lines.push('      }');
  lines.push('    }');
  lines.push("    stage('Run') {");
  lines.push('      steps {');
  lines.push("        withCredentials([string(credentialsId: 'ANTHROPIC_API_KEY', variable: 'ANTHROPIC_API_KEY')]) {");
  lines.push(
    `          sh 'overcli run ${flowPath} --input "$PROMPT"${allowToolsFlag(allowTools)} --permissions allow-list --run-in ${runIn} --artifacts-dir out --json > run.json'`,
  );
  lines.push('        }');
  lines.push('      }');
  lines.push('    }');
  lines.push('  }');
  lines.push("  post { always { archiveArtifacts artifacts: 'out/**, run.json', allowEmptyArchive: true } }");
  lines.push('}');
  return { path: `Jenkinsfile.overcli-flow-${slug}`, contents: lines.join('\n') + '\n' };
}
