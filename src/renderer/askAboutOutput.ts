// Turning a piece of a service's output into the start of a conversation.
//
// Two decisions live here, both pure so they can be tested without a pane:
// WHERE the conversation opens, and WHAT it is handed. Where: the checkout the
// service is actually running from — a feature branch's worktree when it is on
// one, since that is the code that printed the line — then its project, then
// the workspace that owns the stack. What: the lines, fenced, with the name,
// branch and command that produced them. Seeded as a draft, never sent: the
// user still says what they want to know.

import type { Project, Workspace } from '@shared/types';
import { isSamePath } from '@shared/pathScope';

/// A selection is a question about some lines, not a place to paste a whole
/// log. Past this it is cut, and the prompt says so.
export const MAX_SELECTION = 20_000;

const MAX_COMMAND = 200;

export type OutputChatTarget =
  | {
      kind: 'worktree';
      projectId: string;
      projectPath: string;
      worktreePath: string;
      branch: string;
    }
  | { kind: 'project'; projectId: string; projectPath: string }
  | { kind: 'workspace'; workspaceId: string; rootPath: string };

export function chatTargetFor(args: {
  workspaceId: string;
  projectId?: string;
  binding?: { ref: string; path: string };
  projects: readonly Pick<Project, 'id' | 'path'>[];
  workspaces: readonly Pick<Workspace, 'id' | 'rootPath'>[];
}): OutputChatTarget | null {
  const { workspaceId, projectId, binding, projects, workspaces } = args;
  // A loose project's stack is stored under the project's own id.
  const project =
    projects.find((p) => p.id === projectId) ?? projects.find((p) => p.id === workspaceId);
  if (project) {
    if (binding && !isSamePath(binding.path, project.path)) {
      return {
        kind: 'worktree',
        projectId: project.id,
        projectPath: project.path,
        worktreePath: binding.path,
        branch: binding.ref,
      };
    }
    return { kind: 'project', projectId: project.id, projectPath: project.path };
  }
  const workspace = workspaces.find((w) => w.id === workspaceId);
  return workspace ? { kind: 'workspace', workspaceId: workspace.id, rootPath: workspace.rootPath } : null;
}

/// The flow launcher's target value for the same place. A flow runs against a
/// project or a workspace, and offers its own worktree, so a branch checkout
/// launches against the project it belongs to.
export function flowTargetFor(target: OutputChatTarget): string {
  return target.kind === 'workspace' ? `workspace:${target.rootPath}` : `project:${target.projectPath}`;
}

export function outputPrompt(args: {
  name: string;
  ref?: string;
  command?: readonly string[];
  text: string;
}): string {
  let body = args.text.replace(/^\n+/, '').replace(/\s+$/, '');
  const cut = body.length > MAX_SELECTION;
  if (cut) body = body.slice(0, MAX_SELECTION);

  // A fence longer than any run of backticks in the output, so a log that
  // prints markdown cannot close it early.
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));

  let command = (args.command ?? []).join(' ').replace(/`/g, '');
  if (command.length > MAX_COMMAND) command = `${command.slice(0, MAX_COMMAND)}…`;

  const facts = [args.ref && `branch \`${args.ref}\``, command && `\`${command}\``].filter(Boolean);
  const head = `About this output from **${args.name}**${facts.length > 0 ? ` (${facts.join(', ')})` : ''}:`;
  const note = cut ? `\n(Cut to the first ${MAX_SELECTION.toLocaleString('en-US')} characters.)\n` : '';

  return `${head}\n\n${fence}text\n${body}\n${fence}\n${note}\n`;
}
