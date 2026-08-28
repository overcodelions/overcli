import { describe, expect, it } from 'vitest';

import { buildFlowCiDeploy } from './ciDeploy';
import type { Flow } from './schema';

function flow(over: Partial<Flow> = {}): Flow {
  return {
    id: 'nightly-tidy',
    name: 'Nightly Tidy',
    input: 'user_prompt',
    defaultPrompt: 'Tidy the changelog',
    participants: [{ id: 'primary', name: 'P', backend: 'claude', model: 'claude-sonnet-4-6' }],
    steps: [
      { id: 's1', participantId: 'primary', role: 'planner', inputs: ['user_prompt'], tools: ['Read'], output: 'plan.md' },
    ],
    source: 'user',
    filePath: '/tmp/nightly-tidy.yaml',
    ...over,
  };
}

describe('buildFlowCiDeploy', () => {
  it('writes the flow beside a pipeline file', () => {
    const plan = buildFlowCiDeploy({ flow: flow(), target: 'github', flowYaml: 'name: Nightly Tidy\n' });
    expect(plan.files.map((f) => f.path)).toEqual([
      '.overcli/flows/nightly-tidy.yaml',
      '.github/workflows/overcli-flow-nightly-tidy.yml',
    ]);
  });

  it('carries no state directory or trust — a flow has neither', () => {
    const contents = buildFlowCiDeploy({ flow: flow(), target: 'github', flowYaml: 'x' }).files[1].contents;
    expect(contents).not.toContain('--state-dir');
    expect(contents).not.toContain('--trust');
    expect(contents).not.toContain('actions/cache');
  });

  it('bakes the flow’s default prompt in as the dispatch default', () => {
    const contents = buildFlowCiDeploy({ flow: flow(), target: 'github', flowYaml: 'x' }).files[1].contents;
    expect(contents).toContain('workflow_dispatch:');
    expect(contents).toContain('default: "Tidy the changelog"');
  });

  it('prefers an explicit prompt over the flow’s default', () => {
    const contents = buildFlowCiDeploy({
      flow: flow(),
      target: 'github',
      flowYaml: 'x',
      prompt: 'Only the security section',
    }).files[1].contents;
    expect(contents).toContain('Only the security section');
    expect(contents).not.toContain('Tidy the changelog');
  });

  it('quotes a prompt containing a colon, which would otherwise break the YAML', () => {
    const contents = buildFlowCiDeploy({
      flow: flow(),
      target: 'github',
      flowYaml: 'x',
      prompt: 'Fix: the parser',
    }).files[1].contents;
    expect(contents).toContain('default: "Fix: the parser"');
  });

  it('escapes a quote in a Jenkins prompt rather than closing the string', () => {
    const contents = buildFlowCiDeploy({
      flow: flow(),
      target: 'jenkins',
      flowYaml: 'x',
      prompt: "it's fine",
    }).files[1].contents;
    expect(contents).toContain("\\'s fine");
  });

  it('warns when the flow has no prompt at all', () => {
    const plan = buildFlowCiDeploy({
      flow: flow({ defaultPrompt: undefined }),
      target: 'github',
      flowYaml: 'x',
    });
    expect(plan.warnings.some((w) => w.includes('no default prompt'))).toBe(true);
  });

  it('takes the allow-list from the steps, so a Bash step gets Bash', () => {
    const plan = buildFlowCiDeploy({
      flow: flow({
        steps: [
          { id: 's1', participantId: 'primary', role: 'implementer', inputs: [], tools: ['Bash'], output: 'o.md' },
        ],
      }),
      target: 'github',
      flowYaml: 'x',
    });
    // The old generator emitted a Read/Grep/Glob default and then warned that
    // the flow wanted Bash — a mismatch it created itself.
    expect(plan.files[1].contents).toContain('--allow-tool Bash');
    expect(plan.warnings.some((w) => w.includes('denied'))).toBe(false);
  });

  it('unions the tools across every step', () => {
    const plan = buildFlowCiDeploy({
      flow: flow({
        steps: [
          { id: 's1', participantId: 'primary', role: 'planner', inputs: [], tools: ['Read'], output: 'a.md' },
          { id: 's2', participantId: 'primary', role: 'implementer', inputs: [], tools: ['Edit', 'Read'], output: 'b.md' },
        ],
      }),
      target: 'github',
      flowYaml: 'x',
    });
    expect(plan.files[1].contents).toContain('--allow-tool Edit,Read');
  });

  it('says which steps it could not narrow rather than widening them', () => {
    const plan = buildFlowCiDeploy({
      flow: flow({
        steps: [
          { id: 'open', participantId: 'primary', role: 'implementer', inputs: [], tools: [], output: 'o.md' },
        ],
      }),
      target: 'github',
      flowYaml: 'x',
    });
    expect(plan.warnings.some((w) => w.includes('declare no tools') && w.includes('open'))).toBe(true);
  });

  it('installs the backend package for a Jenkins agent', () => {
    const plan = buildFlowCiDeploy({ flow: flow(), target: 'jenkins', flowYaml: 'x' });
    expect(plan.files[1].contents).toContain('npm i -g @overcodelions/overcli@alpha @anthropic-ai/claude-code');
  });

  it('warns about Ollama, which stock runners do not have', () => {
    const plan = buildFlowCiDeploy({
      flow: flow({ participants: [{ id: 'primary', name: 'P', backend: 'ollama', model: 'qwen' }] }),
      target: 'github',
      flowYaml: 'x',
    });
    expect(plan.warnings.some((w) => w.includes('Ollama'))).toBe(true);
  });
});

describe('the instructions name what each system actually calls things', () => {
  it('says "repository secret" for GitHub', () => {
    const plan = buildFlowCiDeploy({ flow: flow(), target: 'github', flowYaml: 'x' });
    expect(plan.steps[0]).toContain('repository secret');
    expect(plan.steps[0]).toContain('Settings → Secrets and variables → Actions');
  });

  it('says "credential" for Jenkins, which has no repository secrets', () => {
    const plan = buildFlowCiDeploy({ flow: flow(), target: 'jenkins', flowYaml: 'x' });
    expect(plan.steps[0]).toContain('credential');
    expect(plan.steps[0]).toContain('Manage Jenkins');
    expect(plan.steps[0]).not.toContain('repository secret');
  });

  it('warns up front that the CLI it invokes is not published yet', () => {
    for (const target of ['github', 'jenkins'] as const) {
      const plan = buildFlowCiDeploy({ flow: flow(), target, flowYaml: 'x' });
      expect(plan.toolNotice).toContain('Publish the CLI first');
      expect(plan.warnings.some((w) => w.includes('Publish the CLI first'))).toBe(false);
    }
  });
})

describe('a flow deployed across a workspace', () => {
  const ws = {
    name: 'unifyr',
    members: [
      { name: 'api', dir: 'api', remote: 'https://github.com/unifyr/api.git' },
      { name: 'web', dir: 'web', remote: 'git@github.com:unifyr/web.git' },
    ],
    unreachable: [] as string[],
  };
  const plan = (target: 'github' | 'jenkins') =>
    buildFlowCiDeploy({ flow: flow(), target, flowYaml: 'x', workspace: ws });

  it('checks every member out and runs across them', () => {
    const gh = plan('github').files[1].contents;
    expect(gh).toContain('repository: unifyr/api');
    expect(gh).toContain('path: workspace/web');
    expect(gh).toContain('--cwd workspace');
  });

  it('assembles the workspace on Jenkins, which has no checkout action', () => {
    const j = plan('jenkins').files[1].contents;
    expect(j).toContain("stage('Assemble workspace')");
    expect(j).toContain('git clone --depth 1 https://github.com/unifyr/api.git workspace/api');
  });

  it('blocks the project write — a workspace is a scope, not a repository', () => {
    expect(plan('github').block?.reason).toContain('unifyr');
    expect(plan('github').block?.remedy).toContain('2 member repositories');
  });

  it('leaves a single-project flow running where it always did', () => {
    const p = buildFlowCiDeploy({ flow: flow(), target: 'github', flowYaml: 'x' });
    expect(p.files[1].contents).toContain('--cwd .');
    expect(p.block).toBeUndefined();
  });
});
