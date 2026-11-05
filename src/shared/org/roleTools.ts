// A worker's role (Worker.role, a role in the org's catalog) brings that
// role's tools with it. The worker's own list still decides the rest: its
// manager can turn a role tool off for it (roleToolsOff), or narrow one with
// a scope like any tool. Changing a role's tools in the catalog changes them
// for every worker with that role.

import type { OrgRole } from './policy';

export function roleNamed(roles: readonly OrgRole[], name: string | undefined): OrgRole | undefined {
  const key = (name ?? '').trim().toLowerCase();
  return key ? roles.find((r) => r.name.toLowerCase() === key) : undefined;
}

/// The tools a worker gets from its role: the role's, less those turned off for it.
export function roleToolsFor(w: { role?: string; roleToolsOff?: string[] }, roles: readonly OrgRole[]): string[] {
  const role = roleNamed(roles, w.role);
  if (!role) return [];
  const off = new Set(w.roleToolsOff ?? []);
  return role.tools.filter((t) => !off.has(t));
}

/// The server's own tool on every worker run (the tool gateway's built-in):
/// `notify`, a message to a person or channel through the server's Slack.
export const SERVER_TOOL = 'overgo';

const ABOUT: Record<string, string> = {
  'test-systems': 'open an app signed in on a ticket’s environment with open_system, then browse, check and take screenshots with its browser tools',
  overdb: 'query the connected databases, read-only',
  atlassian: 'read and comment on Jira tickets and Confluence pages',
  playwright: 'a plain headless browser, with no sign-in',
  zendesk: 'support tickets',
};

/// Told to each step of a worker's run: the tools its role gives it, and how
/// to reach people. Without it a flow written before the role (or the tool)
/// never thinks to use them.
export function roleRunNote(roleTools: readonly string[]): string {
  const lines: string[] = [];
  if (roleTools.length) {
    lines.push(
      `YOUR ROLE'S TOOLS. Your role gives you these in every step, whether or not the step lists them: ${roleTools
        .map((t) => (ABOUT[t] ? `${t} (${ABOUT[t]})` : t))
        .join('; ')}. Use them where this step's work needs them, rather than working around them in the shell.`,
    );
  }
  lines.push(
    `TELLING PEOPLE. To tell someone your work is done or needs them, use the ${SERVER_TOOL} tool's notify call if you have it. Never reach Slack or another service from the shell, and never look for a token: you won't have one.`,
  );
  return `${lines.join('\n\n')}\n\n`;
}
