// Your desktop's setup, as it goes to the org: each MCP server as a template
// (where it runs and the NAMES of the keys it needs — never their values),
// and each project's git remote, so the server can connect the same repos.
//
// A key's value only goes when the person ticks that one tool, and then only
// over a channel the org client already insists on (https, or this machine).
// See publishSetup in orgService for the server's half.

import { execFile } from 'node:child_process';
import path from 'node:path';
import type { McpServerConfig } from '../mcpConfig';
import { templateFrom, type ToolTemplate } from './tools';

export interface SetupTool {
  name: string;
  kind: 'command' | 'http';
  /// The command and its arguments, or the URL: what the person sees.
  target: string;
  /// Names of the env vars or headers it needs, values never.
  keys: string[];
  template: ToolTemplate;
}

export interface SetupRepo {
  projectId: string;
  name: string;
  /// https, with any credentials taken out; absent for a project with no remote.
  url?: string;
  /// The project on this machine: a server on the same machine may clone it.
  localPath: string;
}

export interface SetupPreview {
  tools: SetupTool[];
  repos: SetupRepo[];
}

/// A git remote as an https address the server can clone with a token:
/// credentials out, `git@host:org/repo` turned into `https://host/org/repo`.
/// Null when it isn't a hosted repo address.
export function repoUrlFromRemote(remote: string): string | null {
  const raw = remote.trim();
  const ssh = /^(?:ssh:\/\/)?git@([\w.-]+)[:/]([\w./-]+?)(?:\.git)?\/?$/.exec(raw);
  if (ssh) return `https://${ssh[1]}/${ssh[2].replace(/^\/+/, '')}`;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return `https://${u.host}/${parts.join('/')}`;
  } catch {
    return null;
  }
}

function gitRemote(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 5000 }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
}

export async function gatherSetup(
  servers: Record<string, McpServerConfig>,
  projects: Array<{ id: string; name: string; path: string }>,
  remoteOf: (dir: string) => Promise<string | null> = gitRemote,
): Promise<SetupPreview> {
  const tools = Object.entries(servers).flatMap(([name, config]): SetupTool[] => {
    const template = templateFrom(name, config);
    if (!template) return [];
    const target = template.kind === 'http' ? template.url ?? '' : [template.command, ...(template.args ?? [])].join(' ');
    return [{ name, kind: template.kind, target, keys: [...template.envKeys, ...template.headerKeys], template }];
  });
  const repos: SetupRepo[] = [];
  for (const p of projects) {
    const remote = await remoteOf(p.path);
    const url = remote ? repoUrlFromRemote(remote) ?? undefined : undefined;
    // Named as the server will name it when it connects: the repo's own name.
    repos.push({ projectId: p.id, name: url ? url.split('/').pop()! : path.basename(p.path) || p.name, ...(url ? { url } : {}), localPath: p.path });
  }
  return { tools: tools.sort((a, b) => a.name.localeCompare(b.name)), repos };
}

/// The values for one tool's keys, read from its config: only the names the
/// template lists, so nothing else in the config rides along.
export function keyValuesFor(config: McpServerConfig, template: ToolTemplate): { env?: Record<string, string>; headers?: Record<string, string> } {
  const pick = (from: unknown, names: string[]) => {
    if (!from || typeof from !== 'object') return undefined;
    const out: Record<string, string> = {};
    for (const n of names) {
      const v = (from as Record<string, unknown>)[n];
      if (typeof v === 'string' && v) out[n] = v;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const env = pick(config.env, template.envKeys);
  const headers = pick(config.headers, template.headerKeys);
  return { ...(env ? { env } : {}), ...(headers ? { headers } : {}) };
}
