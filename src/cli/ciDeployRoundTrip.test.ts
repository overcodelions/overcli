// The generated pipeline file has to be a command this CLI actually accepts.
//
// These two halves are written in different files by different people at
// different times: `shared/flows/ciDeploy.ts` composes a shell line, and
// `cli/args.ts` parses one. Nothing else connects them, so a renamed flag or a
// changed enum value would ship a generator that emits a job which dies on its
// first argument — and it would die in CI, on the user's runner, days later.
//
// So this pulls the `overcli run ...` line back out of the generated file and
// feeds it to the real parser. It is the only test that fails when the two
// drift apart.

import { describe, expect, it } from 'vitest';

import { buildCiDeploy, buildFlowCiDeploy, type CiTarget } from '../shared/flows/ciDeploy';
import type { Flow } from '../shared/flows/schema';
import type { Worker } from '../shared/flows/worker';
import { parseArgs } from './args';

function flow(): Flow {
  return {
    id: 'f',
    name: 'F',
    input: 'user_prompt',
    participants: [{ id: 'primary', name: 'P', backend: 'claude', model: 'claude-sonnet-4-6' }],
    steps: [
      { id: 's', participantId: 'primary', role: 'planner', inputs: ['user_prompt'], tools: ['Read'], output: 'o.md' },
    ],
    source: 'user',
    filePath: '/tmp/f.yaml',
  };
}

function worker(over: Partial<Worker> = {}): Worker {
  return {
    id: 'w',
    name: 'Release Nanny',
    jobDescription: 'Watch the release branch.',
    projectPath: '/repo',
    cadence: { kind: 'daily', time: '09:00' },
    trust: 'trusted',
    caps: { maxItemsPerShift: 3, runIn: 'worktree' },
    budgetUSDPerMonth: 12,
    heartbeatModel: 'claude-sonnet-4-6',
    heartbeatBackend: 'claude',
    flowIds: ['f'],
    enabled: true,
    createdAt: 1,
    ...over,
  };
}

/// Pull the `overcli run …` invocation out of a generated pipeline file and
/// split it into argv. Handles both the GitHub form (`- run: overcli run …`)
/// and the Jenkins form (`sh 'overcli run …'`).
function extractRunArgv(contents: string): string[] {
  const line = contents.split('\n').find((l) => l.includes('overcli run '));
  if (!line) throw new Error('no `overcli run` line in the generated file');
  const start = line.indexOf('overcli run ');
  let cmd = line.slice(start + 'overcli '.length);
  cmd = cmd.replace(/'$/, '').replace(/\s*>\s*run\.json.*$/, '').trim();
  return cmd.split(/\s+/).filter(Boolean);
}

describe.each<CiTarget>(['github', 'jenkins'])('a generated %s job', (target) => {
  it('is a command the CLI parses without complaint', () => {
    const plan = buildCiDeploy({ worker: worker(), flows: [flow()], target, workerYaml: 'kind: worker\n' });
    const parsed = parseArgs(extractRunArgv(plan.files[1].contents));
    expect(parsed.ok, parsed.ok ? '' : `generated command rejected: ${parsed.error}`).toBe(true);
    if (!parsed.ok) return;
    // No warnings either: "allow-list with no --allow-tool denies everything"
    // is exactly the silently-useless job this pairing exists to prevent.
    expect(parsed.args.warnings).toEqual([]);
  });

  it('carries the worker’s trust, so the shift is not stuck on probation', () => {
    const plan = buildCiDeploy({
      worker: worker({ trust: 'autonomous' }),
      flows: [flow()],
      target,
      workerYaml: 'kind: worker\n',
    });
    const parsed = parseArgs(extractRunArgv(plan.files[1].contents));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.args.run?.trust).toBe('autonomous');
  });

  it('never generates a job that can approve its own tool use', () => {
    const plan = buildCiDeploy({
      worker: worker({ trust: 'autonomous', caps: { maxItemsPerShift: 1, runIn: 'cwd', allowExternalActions: true } }),
      flows: [flow()],
      target,
      workerYaml: 'kind: worker\n',
    });
    const parsed = parseArgs(extractRunArgv(plan.files[1].contents));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.args.run?.permissions).not.toBe('auto-approve');
  });

  it('points the run at the bundle it also wrote', () => {
    const plan = buildCiDeploy({ worker: worker(), flows: [flow()], target, workerYaml: 'kind: worker\n' });
    const parsed = parseArgs(extractRunArgv(plan.files[1].contents));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.args.run?.file).toBe(plan.files[0].path);
  });
});

// The same guard for the FLOW half. It has its own generator, its own flags
// (--input, no --trust, no --state-dir) and its own quoting, so passing the
// worker round-trip says nothing about it.
describe.each<CiTarget>(['github', 'jenkins'])('a generated %s FLOW job', (target) => {
  function plan(over: Partial<Parameters<typeof buildFlowCiDeploy>[0]> = {}) {
    return buildFlowCiDeploy({
      flow: {
        id: 'nightly-tidy',
        name: 'Nightly Tidy',
        input: 'user_prompt',
        defaultPrompt: 'Tidy the changelog',
        participants: [{ id: 'primary', name: 'P', backend: 'claude', model: 'm' }],
        steps: [
          { id: 's', participantId: 'primary', role: 'planner', inputs: ['user_prompt'], tools: ['Read'], output: 'o.md' },
        ],
        source: 'user',
        filePath: '/tmp/f.yaml',
      },
      target,
      flowYaml: 'name: Nightly Tidy\n',
      ...over,
    });
  }

  /// The prompt is a quoted argument, so a naive whitespace split would turn
  /// "Tidy the changelog" into three positionals. Strip the --input value out
  /// before splitting — the parser's own handling of it is covered elsewhere.
  function argvWithoutInput(contents: string): string[] {
    const line = contents.split('\n').find((l) => l.includes('overcli run '))!;
    let cmd = line.slice(line.indexOf('overcli run ') + 'overcli '.length);
    cmd = cmd.replace(/'$/, '').replace(/\s*>\s*run\.json.*$/, '').trim();
    cmd = cmd.replace(/--input\s+("[^"]*"|'[^']*'|\S+)/, '--input PROMPT');
    return cmd.split(/\s+/).filter(Boolean);
  }

  it('is a command the CLI parses without complaint', () => {
    const parsed = parseArgs(argvWithoutInput(plan().files[1].contents));
    expect(parsed.ok, parsed.ok ? '' : `generated command rejected: ${parsed.error}`).toBe(true);
    if (parsed.ok) expect(parsed.args.warnings).toEqual([]);
  });

  it('points the run at the flow file it also wrote', () => {
    const p = plan();
    const parsed = parseArgs(argvWithoutInput(p.files[1].contents));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.args.run?.file).toBe(p.files[0].path);
  });

  it('never generates a flow job that can approve its own tool use', () => {
    const parsed = parseArgs(argvWithoutInput(plan().files[1].contents));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.args.run?.permissions).not.toBe('auto-approve');
  });
});
