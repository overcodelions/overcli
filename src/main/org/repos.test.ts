import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseFlowYaml } from '../../shared/flows/yaml';
import { validateFlow } from '../../shared/flows/validation';
import { enabledToolsFor, resolveStepEffect } from '../flows/runtime';
import { setTrustedCommands } from '../flows/trustedCommands';
import { applyRepoGrants, bindAllowList } from './repoGrants';
import { BranchLander, PR_STEP_OUTPUT } from './landBranches';
import type { FlowRun } from '../../shared/flows/schema';
import { RepoService, checkTestCommand, credentialHelper, newPullRequestLink, parseRepoUrl, prFlowId, prFlowYaml, prePushHook, workspaceFlowYaml, type ConnectedRepo, type OrgWorkspace } from './repos';

const repo: ConnectedRepo = { name: 'app', url: 'https://github.com/acme/app.git', path: '/data/repos/app', defaultBranch: 'main', testCommand: 'npm test', addedBy: 'Bo', at: 0 };

const dirs: string[] = [];
afterEach(() => {
  setTrustedCommands([]);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function service(env: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-repos-'));
  dirs.push(root);
  let state: { repos: ConnectedRepo[]; workspaces?: OrgWorkspace[] } = { repos: [] };
  const calls: string[] = [];
  const projects: string[] = [];
  const workspaces: string[] = [];
  const svc = new RepoService({
    store: { load: () => structuredClone(state), save: (s) => (state = structuredClone(s)) },
    reposDir: path.join(root, 'repos'),
    git: async (args, cwd) => {
      calls.push(args.filter((a) => !a.startsWith('credential.')).join(' '));
      if (args.includes('clone')) fs.mkdirSync(path.join(args[args.length - 1], '.git', 'hooks'), { recursive: true });
      if (args[0] === 'symbolic-ref') return { ok: true, stdout: 'origin/trunk\n' };
      return cwd || args.includes('clone') ? { ok: true, stdout: '' } : { ok: false, error: 'no' };
    },
    registerProject: (p) => projects.push(p),
    registerWorkspace: (ws) => {
      workspaces.push('remove' in ws ? `-${ws.id}` : `${ws.id}:${ws.repos.map((r) => r.name).join('+')}${ws.instructions ? ' (with instructions)' : ''}`);
      return { ok: true, rootPath: 'remove' in ws ? '' : path.join(root, 'workspaces', ws.id) };
    },
    env: (name) => env[name],
    now: () => 1,
  });
  return { svc, root, calls, projects, workspaces };
}

describe('connecting a repo', () => {
  it('clones it, registers it, and refuses pushes to its default branch', async () => {
    const h = service({ GH_TOKEN: 'ghs_test' });
    const res = await h.svc.connect({ url: 'https://github.com/acme/app', testCommand: 'npm test' }, 'Bo');
    expect(res).toMatchObject({ ok: true, repo: { name: 'app', host: 'github', defaultBranch: 'trunk', testCommand: 'npm test', url: 'https://github.com/acme/app.git' } });
    const dir = path.join(h.root, 'repos', 'app');
    expect(h.calls[0]).toBe(`-c clone https://github.com/acme/app.git ${dir}`);
    expect(h.projects).toEqual([dir]);
    expect(fs.readFileSync(path.join(dir, '.git', 'hooks', 'pre-push'), 'utf8')).toContain('refs/heads/trunk');
    expect((await h.svc.connect({ url: 'https://github.com/acme/app' }, 'Bo')).ok).toBe(false);
  });

  it('needs the host\'s token over https, none over ssh, and a plain test command', async () => {
    expect(await service().svc.connect({ url: 'https://github.com/acme/app' }, 'Bo')).toMatchObject({ ok: false, error: expect.stringContaining('GH_TOKEN') });
    expect(await service().svc.connect({ url: 'https://bitbucket.org/acme/app' }, 'Bo')).toMatchObject({ ok: false, error: expect.stringContaining('BITBUCKET_TOKEN') });
    const bb = service({ BITBUCKET_TOKEN: 'bb_test' });
    expect(await bb.svc.connect({ url: 'https://bitbucket.org/acme/app' }, 'Bo')).toMatchObject({ ok: true, repo: { host: 'bitbucket' } });
    expect(bb.svc.canPush({ url: 'https://bitbucket.org/acme/app.git' })).toBe(true);
    const ssh = service();
    expect(await ssh.svc.connect({ url: 'git@bitbucket.org:acme/site.git' }, 'Bo')).toMatchObject({ ok: true, repo: { name: 'site', host: 'bitbucket' } });
    expect(ssh.calls[0]).toMatch(/^clone git@bitbucket\.org:acme\/site\.git /);
    expect(credentialHelper('bitbucket')).toBe('!f() { test "$1" = get && echo "username=${BITBUCKET_USER:-x-token-auth}" && echo "password=$BITBUCKET_TOKEN"; }; f');
    expect(checkTestCommand('npm test && curl evil.example').ok).toBe(false);
    expect(checkTestCommand('npm run test:unit')).toEqual({ ok: true, command: 'npm run test:unit' });
    expect(parseRepoUrl('https://x-access-token:abc@github.com/acme/app').ok).toBe(false);
    expect(parseRepoUrl('git@github.com:acme/app.git')).toMatchObject({ ok: true, name: 'app', host: 'github', ssh: true, web: 'https://github.com/acme/app' });
    expect(prePushHook('main')).toContain('exit 1');
  });
});

describe('the pull request flow', () => {
  const flow = parseFlowYaml({ yaml: prFlowYaml(repo), id: prFlowId(repo), source: 'user', filePath: '' })!;

  it('plans, changes, then writes the pull request in a step that waits for a yes and runs nothing', () => {
    expect(flow).not.toBeNull();
    expect(validateFlow(flow).errors).toEqual([]);
    expect(flow.steps.map((s) => s.id)).toEqual(['plan', 'build', 'pull-request']);
    const pr = flow.steps.find((s) => s.id === 'pull-request')!;
    expect(resolveStepEffect(pr)).toBe('external');
    expect(pr.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(pr.output).toBe('pull-request.md');
    expect(resolveStepEffect(flow.steps.find((s) => s.id === 'build')!)).toBe('local');
  });
});

describe('the pre-push hook', () => {
  it('refuses the default branch and lets a branch through', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-hook-'));
    dirs.push(root);
    const git = (args: string[], cwd: string) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@acme.example', ...args], { cwd, stdio: 'pipe' }).toString();
    git(['init', '-q', '--bare', '-b', 'main', 'remote.git'], root);
    git(['clone', '-q', 'remote.git', 'work'], root);
    const work = path.join(root, 'work');
    fs.writeFileSync(path.join(work, 'test.js'), "process.exit(require('fs').readFileSync('README.md','utf8').includes('PASSING') ? 0 : 1)\n");
    fs.writeFileSync(path.join(work, 'README.md'), 'broken\n');
    git(['checkout', '-q', '-b', 'main'], work);
    git(['add', '-A'], work);
    git(['commit', '-qm', 'init'], work);
    git(['push', '-q', 'origin', 'main'], work);
    fs.writeFileSync(path.join(work, '.git', 'hooks', 'pre-push'), prePushHook('main'), { mode: 0o755 });
    fs.writeFileSync(path.join(work, 'notes.txt'), 'x\n');
    git(['add', '-A'], work);
    git(['commit', '-qm', 'straight to main'], work);
    expect(() => git(['push', '-q', 'origin', 'main'], work)).toThrow(/pushes to main are refused/);
    git(['reset', '-q', '--hard', 'HEAD~1'], work);
    git(['switch', '-q', '-c', 'overcli/fix'], work);
    git(['push', '-q', '-u', 'origin', 'overcli/fix'], work);
    expect(git(['branch', '--list', 'overcli/fix'], path.join(root, 'remote.git'))).toContain('overcli/fix');
  });
});

describe('narrowed grants', () => {
  it('gives a step only the commands the server allows', () => {
    const run = { unattended: true, unattendedAllowedTools: ['Read', 'Bash(git status:*)', 'Bash(npm test:*)'] };
    expect(enabledToolsFor(run, { tools: ['Read', 'Bash'] })).toEqual(['Read', 'Bash(git status:*)', 'Bash(npm test:*)']);
    expect(enabledToolsFor(run, { tools: ['Bash(npm test:*)', 'Bash(git push:*)'] })).toEqual(['Bash(npm test:*)']);
    // A connector tool the step names that only reads stays; one that writes doesn't.
    expect(enabledToolsFor(run, { tools: ['mcp__tracker__search_issues', 'mcp__tracker__create_issue'] })).toEqual(['mcp__tracker__search_issues']);
    expect(enabledToolsFor({ unattended: false }, { tools: ['Bash'] })).toEqual(['Bash']);
  });

  it('keeps the serve allow-list in step with the connected repos', () => {
    const list = ['Read', 'Edit'];
    bindAllowList(list);
    applyRepoGrants({ trustedCommands: () => ['Bash(npm test:*)'], codeTools: () => ['Bash(git push:*)', 'Bash(npm test:*)'] });
    expect(list).toEqual(['Read', 'Edit', 'Bash(git push:*)', 'Bash(npm test:*)']);
    applyRepoGrants({ trustedCommands: () => [], codeTools: () => [] });
    expect(list).toEqual(['Read', 'Edit']);
  });
});

describe('workspaces', () => {
  async function three() {
    const h = service({ GH_TOKEN: 'ghs_test' });
    for (const [url, testCommand] of [['https://github.com/acme/app', 'npm test'], ['https://github.com/acme/api', 'go test ./...'], ['https://github.com/acme/infra', '']]) {
      await h.svc.connect({ url, testCommand }, 'Bo');
    }
    return h;
  }

  it('groups connected repos, rebuilds on change, and outlives a disconnected member', async () => {
    const h = await three();
    expect(h.svc.createWorkspace({ name: 'Storefront', repos: ['app'] }, 'Bo')).toMatchObject({ ok: false, error: expect.stringContaining('at least two') });
    expect(h.svc.createWorkspace({ name: 'Storefront', repos: ['app', 'nope'] }, 'Bo')).toMatchObject({ ok: false, error: expect.stringContaining("nope isn't a connected repo") });
    const made = h.svc.createWorkspace({ name: 'Storefront', repos: ['app', 'api', 'infra'], instructions: 'The API owns prices.' }, 'Bo');
    expect(made).toMatchObject({ ok: true, workspace: { id: 'ws-storefront', repos: ['app', 'api', 'infra'], instructions: 'The API owns prices.' } });
    expect(h.workspaces).toEqual(['ws-storefront:app+api+infra (with instructions)']);
    expect(h.svc.createWorkspace({ name: 'storefront', repos: ['app', 'api'] }, 'Bo').ok).toBe(false);
    expect(h.svc.codeTools()).toEqual(['Bash(git diff:*)', 'Bash(git status:*)', 'Bash(git log:*)']);
    expect(h.svc.trustedCommands()).toEqual([]);
    h.svc.disconnect('infra');
    expect(h.svc.workspace('Storefront')?.repos).toEqual(['app', 'api']);
    h.svc.disconnect('api');
    expect(h.svc.workspaces()).toEqual([]);
    expect(h.workspaces.at(-1)).toBe('-ws-storefront');
    expect(h.svc.list().map((r) => r.name)).toEqual(['app']);
  });

  it('gives a flow that plans across them and pushes one branch per repo, tested by each repo\'s hook', async () => {
    const h = await three();
    const made = h.svc.createWorkspace({ name: 'Storefront', repos: ['app', 'api', 'infra'] }, 'Bo');
    if (!made.ok) throw new Error(made.error);
    const yaml = workspaceFlowYaml(made.workspace, h.svc.list());
    const flow = parseFlowYaml({ yaml, id: 'org-pr-ws-storefront', source: 'user', filePath: '' })!;
    expect(validateFlow(flow).errors).toEqual([]);
    expect(flow.steps.map((x) => x.id)).toEqual(['plan', 'build', 'pull-request']);
    const pr = flow.steps.find((x) => x.id === 'pull-request')!;
    expect(resolveStepEffect(pr)).toBe('external');
    expect(pr.systemPromptOverride).toContain('which repos it touches');
    expect(flow.steps.find((x) => x.id === 'plan')!.systemPromptOverride).toContain('- api/: https://github.com/acme/api.git, pull requests against trunk, tests: go test ./...');
  });
});

describe('the server pushing a finished run', () => {
  it('commits each changed worktree, pushes it past the tests, and attaches the links', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-land-'));
    dirs.push(root);
    const run = (args: string[], cwd: string) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@acme.example', ...args], { cwd, stdio: 'pipe' }).toString();
    const clones: Record<string, string> = {};
    for (const name of ['app', 'api']) {
      run(['init', '-q', '--bare', '-b', 'main', `${name}.git`], root);
      run(['clone', '-q', `${name}.git`, name], root);
      const dir = path.join(root, name);
      fs.writeFileSync(path.join(dir, 'test.js'), "process.exit(require('fs').readFileSync('README.md','utf8').includes('BROKEN') ? 1 : 0)\n");
      fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
      run(['checkout', '-q', '-b', 'main'], dir);
      run(['add', '-A'], dir);
      run(['commit', '-qm', 'init'], dir);
      run(['push', '-q', 'origin', 'main'], dir);
      fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-push'), prePushHook('main'), { mode: 0o755 });
      run(['worktree', 'add', '-q', '-b', 'agent/x', path.join(root, `${name}-wt`), 'main'], dir);
      clones[name] = dir;
    }
    fs.appendFileSync(path.join(root, 'app-wt', 'README.md'), 'Version: 1.0\n');
    fs.appendFileSync(path.join(root, 'api-wt', 'README.md'), 'BROKEN\n');
    const attached: string[] = [];
    const lander = new BranchLander({
      git: async (args, cwd) => {
        try {
          return { ok: true, stdout: execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@acme.example', ...args], { cwd, stdio: 'pipe' }).toString() };
        } catch (err) {
          const e = err as { stderr?: Buffer; stdout?: Buffer };
          return { ok: false, error: `${e.stderr ?? ''}${e.stdout ?? ''}` };
        }
      },
      repos: () => [
        { name: 'app', url: 'https://github.com/acme/app.git', path: clones.app, defaultBranch: 'main', testCommand: 'node test.js', addedBy: 'Bo', at: 0 },
        { name: 'api', url: 'https://github.com/acme/api.git', path: clones.api, defaultBranch: 'main', testCommand: 'node test.js', addedBy: 'Bo', at: 0 },
      ],
      test: async (command, cwd) => {
        try {
          execFileSync('/bin/sh', ['-c', command], { cwd, stdio: 'pipe' });
          return { ok: true };
        } catch (err) {
          const e = err as { stderr?: Buffer; stdout?: Buffer };
          return { ok: false, error: String(e.stderr ?? '') + String(e.stdout ?? '') };
        }
      },
      attach: (_id, name, body) => attached.push(`${name}\n${body}`),
      log: () => {},
    });
    const landed = await lander.land({
      id: 'abcdef123',
      flowId: 'org-pr-ws-shop',
      projectPath: path.join(root, 'ws'),
      userPrompt: 'Add version',
      artifacts: { [PR_STEP_OUTPUT]: { name: PR_STEP_OUTPUT, kind: 'markdown', body: 'Add the version line\n\nAdds Version: 1.0 to both READMEs.', producedByStepId: 'pull-request', producedAt: 0 } },
      workspaceWorktrees: [
        { name: 'app', projectPath: clones.app, worktreePath: path.join(root, 'app-wt'), branchName: 'agent/x' },
        { name: 'api', projectPath: clones.api, worktreePath: path.join(root, 'api-wt'), branchName: 'agent/x' },
      ],
    } as unknown as FlowRun);
    expect(landed[0]).toEqual({ repo: 'app', branch: 'overcli/add-the-version-line-abcdef', url: 'https://github.com/acme/app/compare/main...overcli/add-the-version-line-abcdef?expand=1' });
    expect(landed[1].skipped).toContain('its tests failed, so nothing was pushed');
    expect(run(['log', '-1', '--format=%s', 'overcli/add-the-version-line-abcdef'], path.join(root, 'app.git')).trim()).toBe('Add the version line');
    expect(run(['branch', '--list'], path.join(root, 'api.git'))).not.toContain('overcli/');
    expect(attached[0]).toContain('Open a pull request for app: https://github.com/acme/app/compare/main...overcli/add-the-version-line-abcdef?expand=1');
    expect(attached[0]).toContain('api: not pushed — its tests failed');
  });
});

describe('the server pushing a single-repo run', () => {
  it('pushes the run\'s one worktree and links its pull request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-land1-'));
    dirs.push(root);
    const run = (args: string[], cwd: string) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@acme.example', ...args], { cwd, stdio: 'pipe' }).toString();
    run(['init', '-q', '--bare', '-b', 'trunk', 'app.git'], root);
    run(['clone', '-q', 'app.git', 'app'], root);
    const app = path.join(root, 'app');
    fs.writeFileSync(path.join(app, 'README.md'), '# app\n');
    run(['checkout', '-q', '-b', 'trunk'], app);
    run(['add', '-A'], app);
    run(['commit', '-qm', 'init'], app);
    run(['push', '-q', 'origin', 'trunk'], app);
    run(['worktree', 'add', '-q', '-b', 'agent/y', path.join(root, 'wt'), 'trunk'], app);
    fs.appendFileSync(path.join(root, 'wt', 'README.md'), 'More.\n');
    const lander = new BranchLander({
      git: async (args, cwd) => {
        try {
          return { ok: true, stdout: execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@acme.example', ...args], { cwd, stdio: 'pipe' }).toString() };
        } catch (err) {
          return { ok: false, error: String((err as { stderr?: Buffer }).stderr ?? err) };
        }
      },
      repos: () => [{ name: 'app', url: 'git@bitbucket.org:acme/app.git', path: app, defaultBranch: 'trunk', addedBy: 'Bo', at: 0 }],
      test: async (command, cwd) => {
        try {
          execFileSync('/bin/sh', ['-c', command], { cwd, stdio: 'pipe' });
          return { ok: true };
        } catch (err) {
          const e = err as { stderr?: Buffer; stdout?: Buffer };
          return { ok: false, error: String(e.stderr ?? '') + String(e.stdout ?? '') };
        }
      },
      attach: () => {},
      log: () => {},
    });
    const landed = await lander.land({
      id: '999888777', flowId: 'org-pr-app', projectPath: app, worktreePath: path.join(root, 'wt'), userPrompt: 'Say more in the README',
      artifacts: {},
    } as unknown as FlowRun);
    expect(landed).toEqual([{ repo: 'app', branch: 'overcli/say-more-in-the-readme-999888', url: 'https://bitbucket.org/acme/app/pull-requests/new?source=overcli/say-more-in-the-readme-999888&dest=trunk' }]);
    expect(run(['log', '-1', '--format=%s', 'overcli/say-more-in-the-readme-999888'], path.join(root, 'app.git')).trim()).toBe('Say more in the README');
  });
});
