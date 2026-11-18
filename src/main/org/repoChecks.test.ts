import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseFlowYaml } from '../../shared/flows/yaml';
import { validateFlow } from '../../shared/flows/validation';
import { enabledToolsFor } from '../flows/runtime';
import { RepoService, checkGrantWarning, checkRepoChecks, prFlowId, prFlowYaml, repoChecksNote, workspaceFlowYaml, type ConnectedRepo, type OrgWorkspace } from './repos';
import { RepoSetup, type SetupExec } from './repoSetup';

const app: ConnectedRepo = { name: 'app', url: 'https://github.com/acme/app.git', path: '/data/repos/app', defaultBranch: 'main', setup: 'npm ci', checks: ['npm run lint-changed', 'npm test'], addedBy: 'Bo', at: 0 };
const api: ConnectedRepo = { name: 'api', url: 'https://github.com/acme/api.git', path: '/data/repos/api', defaultBranch: 'main', addedBy: 'Bo', at: 0 };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function service(repos: ConnectedRepo[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-checks-'));
  dirs.push(root);
  let state: { repos: ConnectedRepo[]; workspaces?: OrgWorkspace[] } = { repos };
  const svc = new RepoService({
    store: { load: () => structuredClone(state), save: (s) => (state = structuredClone(s)) },
    reposDir: root,
    git: async () => ({ ok: true, stdout: '' }),
    registerProject: () => undefined,
    registerWorkspace: () => ({ ok: true, rootPath: root }),
    env: () => undefined,
  });
  return { svc, state: () => state };
}

describe('a repo’s setup and checks', () => {
  it('takes plain commands, drops blanks and repeats, and refuses plumbing, quotes and version managers', () => {
    expect(checkRepoChecks({ setup: ' npm ci ', checks: ['npm test', '', 'npm test', 'npm run lint'] })).toEqual({ ok: true, setup: 'npm ci', checks: ['npm test', 'npm run lint'] });
    expect(checkRepoChecks({ checks: ['npm ci && npm test'] }).ok).toBe(false);
    expect(checkRepoChecks({ checks: ['npm run "lint"'] }).ok).toBe(false);
    expect(checkRepoChecks({ setup: 'nvm use' })).toMatchObject({ ok: false, error: expect.stringContaining('Toolchains') });
    expect(checkRepoChecks({ checks: Array.from({ length: 7 }, (_, i) => `npm run c${i}`) }).ok).toBe(false);
  });

  it('saves them on the repo, clears them when empty, and grants each check', () => {
    const h = service([api]);
    expect(h.svc.setChecks('api', { setup: 'npm ci', checks: ['npm run lint-changed'] })).toMatchObject({ ok: true, repo: { setup: 'npm ci', checks: ['npm run lint-changed'] } });
    expect(h.svc.codeTools()).toContain('Bash(npm run lint-changed:*)');
    expect(h.svc.codeTools()).not.toContain('Bash(npm ci:*)');
    h.svc.setChecks('api', {});
    expect(h.state().repos[0]).not.toHaveProperty('setup');
    expect(h.state().repos[0]).not.toHaveProperty('checks');
    expect(h.svc.setChecks('nope', {}).ok).toBe(false);
  });

  it('lets the build step run the checks and nothing else, and leaves planning read-only', () => {
    const flow = parseFlowYaml({ yaml: prFlowYaml(app), id: prFlowId(app), source: 'user', filePath: '' })!;
    expect(validateFlow(flow).errors).toEqual([]);
    const build = flow.steps.find((s) => s.id === 'build')!;
    expect(build.tools).toEqual(expect.arrayContaining(['Bash(npm run lint-changed:*)', 'Bash(npm test:*)']));
    expect(build.tools).not.toContain('Bash(npm ci:*)');
    expect(build.systemPromptOverride).toContain('run npm run lint-changed, npm test');
    expect(flow.steps.find((s) => s.id === 'plan')!.tools.some((t) => t.includes('npm'))).toBe(false);
    // An unattended run gets them through the org's allow-list, narrowed.
    const run = { unattended: true, unattendedAllowedTools: ['Read', 'Edit', 'Bash(npm run lint-changed:*)'] };
    expect(enabledToolsFor(run, build)).toEqual(['Read', 'Edit', 'Bash(npm run lint-changed:*)']);
  });

  it('tells a workspace’s build step to run each repo’s checks from inside it', () => {
    const ws: OrgWorkspace = { id: 'ws-shop', name: 'shop', repos: ['app', 'api'], rootPath: '/w', addedBy: 'Bo', at: 0 };
    const flow = parseFlowYaml({ yaml: workspaceFlowYaml(ws, [app, api]), id: 'org-pr-ws-shop', source: 'user', filePath: '' })!;
    expect(validateFlow(flow).errors).toEqual([]);
    const build = flow.steps.find((s) => s.id === 'build')!;
    expect(build.tools).toContain('Bash(npm test:*)');
    expect(build.systemPromptOverride).toContain('cd app && npm run lint-changed');
  });

  it('tells the run there is no nvm, what setup did, and which checks it may run', () => {
    const ok = repoChecksNote([app], [{ repo: 'app', command: 'npm ci', ok: true }]);
    expect(ok).toContain('no nvm');
    expect(ok).toContain('overcli ran npm ci, so dependencies are installed');
    expect(ok).toContain('you may run npm run lint-changed, npm test');
    const failed = repoChecksNote([app, api], [{ repo: 'app', command: 'npm ci', ok: false, tail: 'ERESOLVE' }]);
    expect(failed).toContain('npm ci in app and it failed');
    expect(failed).toContain('ERESOLVE');
    expect(failed).toContain('cd app && npm test');
  });
});

describe('checks on a server whose workers aren’t a user of their own', () => {
  it('warns only when there are checks and workers run as the server', () => {
    expect(checkGrantWarning([app], false)).toMatch(/run npm run lint-changed, npm test can change what that command runs.*OVERCLI_WORKER_UID/);
    expect(checkGrantWarning([app], true)).toBeUndefined();
    expect(checkGrantWarning([api], false)).toBeUndefined();
    expect(checkGrantWarning([app, { ...api, checks: ['npm test'] }], false)).toContain('run npm run lint-changed, npm test can');
  });

  it('says so when checks are saved, and still saves them', () => {
    const h = service([api]);
    const res = h.svc.setChecks('api', { checks: ['npm test'] });
    expect(res).toMatchObject({ ok: true, repo: { checks: ['npm test'] }, warning: expect.stringContaining('OVERCLI_WORKER_UID') });
    expect(h.svc.setChecks('api', {})).not.toHaveProperty('warning');
    expect(h.svc.setChecks('api', { setup: 'npm ci' })).not.toHaveProperty('warning');
  });

  it('puts the warning in the generated flow as a comment above the build step, and the flow still parses', () => {
    const yaml = prFlowYaml(app, { isolated: false });
    expect(yaml).toMatch(/ {2}# Warning: Workers run as the server's own user[\s\S]*OVERCLI_WORKER_UID[\s\S]*\n {2}- id: build/);
    expect(yaml.split('\n').filter((l) => l.startsWith('  #')).every((l) => l.length <= 110)).toBe(true);
    const flow = parseFlowYaml({ yaml, id: prFlowId(app), source: 'user', filePath: '' })!;
    expect(validateFlow(flow).errors).toEqual([]);
    expect(flow.steps.find((s) => s.id === 'build')!.tools).toContain('Bash(npm test:*)');
    expect(prFlowYaml(app, { isolated: true })).not.toContain('# Warning');
    expect(prFlowYaml(api, { isolated: false })).not.toContain('# Warning');
    const ws: OrgWorkspace = { id: 'ws-shop', name: 'shop', repos: ['app', 'api'], rootPath: '/w', addedBy: 'Bo', at: 0 };
    const wsYaml = workspaceFlowYaml(ws, [app, api], { isolated: false });
    expect(wsYaml).toContain('# Warning: Workers run as the server');
    expect(validateFlow(parseFlowYaml({ yaml: wsYaml, id: 'org-pr-ws-shop', source: 'user', filePath: '' })!).errors).toEqual([]);
  });

  it('runs a trial’s checks without the server’s secrets in their environment', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const exec: SetupExec = (_f, _a, options, cb) => {
      envs.push(options.env);
      cb(null, '', '');
      return undefined;
    };
    const fork = async () => ({ ok: true as const, worktreePath: '/wt/trial', remove: async () => undefined });
    const trial = new RepoSetup({ repos: () => [app], exec, fork, env: { PATH: '/bin', GH_TOKEN: 'x', BITBUCKET_TOKEN: 'y' } }).startTrial('app');
    if (!trial.ok) throw new Error(trial.error);
    await trial.done;
    expect(envs).toHaveLength(3);
    for (const env of envs) {
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.BITBUCKET_TOKEN).toBeUndefined();
    }
  });
});

describe('running setup in a fresh checkout', () => {
  it('runs each repo’s setup in its checkout, says so, and remembers how it went', async () => {
    const ran: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    const exec: SetupExec = (_file, args, options, cb) => {
      ran.push({ args, cwd: options.cwd, env: options.env });
      if (options.cwd === '/wt/bad') cb(new Error('exit 1'), 'npm ERR! ERESOLVE', '');
      else cb(null, '', '');
      return undefined;
    };
    const setup = new RepoSetup({ repos: () => [app, { ...api, setup: 'npm ci' }], exec, env: { PATH: '/bin', GH_TOKEN: 'x' } });
    const said: string[] = [];
    await setup.prepare([{ projectPath: app.path, worktreePath: '/wt/good' }, { projectPath: api.path, worktreePath: '/wt/bad' }, { projectPath: '/elsewhere', worktreePath: '/wt/other' }], (m) => said.push(m));
    expect(said).toEqual(['Running npm ci…']);
    expect(ran.map((r) => r.cwd).sort()).toEqual(['/wt/bad', '/wt/good']);
    expect(ran[0].args).toContain('npm ci');
    expect(ran[0].env.GH_TOKEN).toBeUndefined();
    expect(setup.outcomesFor(['/wt/good', '/wt/bad', '/wt/other'])).toEqual([
      { repo: 'app', command: 'npm ci', ok: true },
      { repo: 'api', command: 'npm ci', ok: false, tail: 'npm ERR! ERESOLVE' },
    ]);
  });

  it('tries setup then each check in a throwaway checkout, skips checks past a failed setup, and drops the checkout', async () => {
    const forked: string[] = [];
    const removed: string[] = [];
    const ran: string[] = [];
    const fork = async () => {
      forked.push('/wt/trial');
      return { ok: true as const, worktreePath: '/wt/trial', remove: async () => { removed.push('/wt/trial'); } };
    };
    const exec = (fail: string): SetupExec => (_f, args, _o, cb) => {
      const cmd = args[args.length - 1];
      ran.push(cmd);
      if (cmd === fail) cb(new Error('exit 1'), '', `${cmd} broke`);
      else cb(null, 'ok', '');
      return undefined;
    };
    const lintFails = new RepoSetup({ repos: () => [app], exec: exec('npm run lint-changed'), fork });
    const res = lintFails.startTrial('app');
    if (!res.ok) throw new Error(res.error);
    expect(lintFails.startTrial('app')).toMatchObject({ ok: false, error: expect.stringContaining('already running') });
    await res.done;
    expect(ran).toEqual(['npm ci', 'npm run lint-changed', 'npm test']);
    expect(lintFails.trial('app')).toMatchObject({ ok: false, steps: [{ state: 'passed' }, { state: 'failed', tail: 'npm run lint-changed broke' }, { state: 'passed' }] });
    expect(removed).toEqual(['/wt/trial']);

    ran.length = 0;
    const setupFails = new RepoSetup({ repos: () => [app], exec: exec('npm ci'), fork });
    const again = setupFails.startTrial('app');
    if (!again.ok) throw new Error(again.error);
    await again.done;
    expect(ran).toEqual(['npm ci']);
    expect(setupFails.trial('app')!.steps.map((s) => s.state)).toEqual(['failed', 'skipped', 'skipped']);

    expect(new RepoSetup({ repos: () => [api], fork }).startTrial('api')).toMatchObject({ ok: false, error: expect.stringContaining('no setup or checks') });
  });

  it('runs nothing and says nothing when no repo has a setup', async () => {
    const said: string[] = [];
    let calls = 0;
    await new RepoSetup({ repos: () => [api], exec: () => { calls++; return undefined; } }).prepare([{ projectPath: api.path, worktreePath: '/wt' }], (m) => said.push(m));
    expect(calls).toBe(0);
    expect(said).toEqual([]);
  });
});
