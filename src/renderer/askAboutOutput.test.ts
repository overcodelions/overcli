import { describe, expect, it } from 'vitest';
import { MAX_SELECTION, chatTargetFor, flowTargetFor, outputPrompt } from './askAboutOutput';

const projects = [
  { id: 'p-admin', path: '/code/acme-admin-console' },
  { id: 'p-loose', path: '/code/loose' },
];
const workspaces = [{ id: 'w-acme', rootPath: '/ws/acme' }];

describe('chatTargetFor', () => {
  it('opens in the worktree a service is running from', () => {
    const target = chatTargetFor({
      workspaceId: 'w-acme',
      projectId: 'p-admin',
      binding: { ref: 'bugfix/ABC-5185', path: '/wt/admin-ABC-5185' },
      projects,
      workspaces,
    });
    expect(target).toEqual({
      kind: 'worktree',
      projectId: 'p-admin',
      projectPath: '/code/acme-admin-console',
      worktreePath: '/wt/admin-ABC-5185',
      branch: 'bugfix/ABC-5185',
    });
    expect(flowTargetFor(target!)).toBe('project:/code/acme-admin-console');
  });

  it('opens in the project when the service runs from its main checkout', () => {
    const target = chatTargetFor({
      workspaceId: 'w-acme',
      projectId: 'p-admin',
      binding: { ref: 'master', path: '/code/acme-admin-console/' },
      projects,
      workspaces,
    });
    expect(target).toEqual({ kind: 'project', projectId: 'p-admin', projectPath: '/code/acme-admin-console' });
  });

  it('treats a loose project’s stack id as the project', () => {
    const target = chatTargetFor({ workspaceId: 'p-loose', projects, workspaces });
    expect(target).toEqual({ kind: 'project', projectId: 'p-loose', projectPath: '/code/loose' });
  });

  it('falls back to the workspace when the service names no known project', () => {
    const target = chatTargetFor({ workspaceId: 'w-acme', projectId: 'gone', projects, workspaces });
    expect(target).toEqual({ kind: 'workspace', workspaceId: 'w-acme', rootPath: '/ws/acme' });
    expect(flowTargetFor(target!)).toBe('workspace:/ws/acme');
  });

  it('has nowhere to go for an unknown stack', () => {
    expect(chatTargetFor({ workspaceId: 'nope', projects, workspaces })).toBeNull();
  });
});

describe('outputPrompt', () => {
  it('fences the lines under the name, branch and command', () => {
    const prompt = outputPrompt({
      name: 'admin-console',
      ref: 'main',
      command: ['npm', 'run', 'start'],
      text: '\n[HPM] Proxy created\nERROR boom\n\n',
    });
    expect(prompt).toBe(
      'About this output from **admin-console** (branch `main`, `npm run start`):\n\n```text\n[HPM] Proxy created\nERROR boom\n```\n\n',
    );
  });

  it('leaves out what it does not know', () => {
    expect(outputPrompt({ name: 'svc', text: 'x' })).toMatch(/^About this output from \*\*svc\*\*:\n/);
  });

  it('uses a fence the output cannot close', () => {
    const prompt = outputPrompt({ name: 'svc', text: 'before\n````\nafter' });
    expect(prompt).toContain('`````text\nbefore\n````\nafter\n`````');
  });

  it('cuts a huge selection and says so', () => {
    const prompt = outputPrompt({ name: 'svc', text: 'a'.repeat(MAX_SELECTION + 10) });
    expect(prompt).toContain('a'.repeat(MAX_SELECTION) + '\n```');
    expect(prompt).not.toContain('a'.repeat(MAX_SELECTION + 1));
    expect(prompt).toContain('(Cut to the first 20,000 characters.)');
  });
});
