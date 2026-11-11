// APIs published from overapi — Setup → APIs.
//
// The same road as overdb's databases (overdb.ts). A project someone
// published from overapi waits here until an admin finishes it: chooses
// read-only or writes, and types each secret its environment names.
// Finishing writes the project to `org/overapi/<name>.json` and (re)installs
// a tool of its own, `overapi-<name>` — overapi's CLI serving that file —
// with the secrets in the tool's env. That env is the only place a secret
// lives: the file, the offer and the audit log carry its variable's NAME.
//
// One tool per API rather than one for all (as overdb has): each API is a
// separate MCP server in overapi, and an admin gives a worker this API and
// not that one the way they give any tool.

import { randomUUID } from 'node:crypto';

import { canHire, isAdmin, type OrgCaller, type OrgPolicy } from '../../shared/org/policy';
import { API_PUSH_MAX_BYTES, overapiToolName, parseApiPush, pushEnv, type ApiPush, type OverapiEnv, type OverapiProject, type OverapiSafety } from '../../shared/overapiProject';
import type { ToolInput } from './tools';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/// An API published from overapi, waiting for an admin to finish it.
/// See src/shared/overapiProject.ts.
export interface OverapiOffer {
  id: string;
  by: string;
  slackUserId?: string;
  at: number;
  push: ApiPush;
}

/// A finished API: the project as written for the tool, and who sent it.
export interface OverapiLive {
  name: string;
  by: string;
  at: number;
  env: string;
  /// What the admin chose, never more than the publisher allowed.
  allowWrites: boolean;
  /// The variables its tool's env holds, by name.
  secrets: string[];
  /// Exactly what `org/overapi/<name>.json` holds: the one environment served.
  project: OverapiProject;
}

/// What the console shows of an API's tools.
export interface OverapiToolSummary {
  name: string;
  method: string;
  path: string;
  safety: OverapiSafety;
}

export const OVERAPI_DIR = 'overapi';

/// What an API's secrets are sent with. A project published again with any
/// of these changed must not take the kept secrets there unasked.
export function overapiChanges(live: OverapiEnv, next: OverapiEnv): string[] {
  const out: string[] = [];
  if (live.baseUrl !== next.baseUrl) out.push('base URL');
  if (JSON.stringify(live.auth) !== JSON.stringify(next.auth)) out.push('sign-in');
  return out;
}

const summary = (p: OverapiProject): OverapiToolSummary[] => p.tools.filter((t) => t.enabled !== false).map((t) => ({ name: t.name, method: t.method.toUpperCase(), path: t.path, safety: t.safety }));

/// What the org service passes in: its stores, and the overapi install.
export interface OverapiDeps {
  /// APIs published from overapi, waiting for an admin.
  overapiOffers?: { load(): { offers: OverapiOffer[] }; save(value: { offers: OverapiOffer[] }): void };
  /// The finished ones.
  overapiApis?: { load(): { apis: OverapiLive[] }; save(value: { apis: OverapiLive[] }): void };
  /// Where overapi's CLI is here (null: not installed), the project files
  /// its tools serve, and each tool's env as installed — the secrets, which
  /// only the tool's own config holds.
  overapi?: {
    cliPath(): string | null;
    projectFile(name: string): string;
    writeProject(name: string, project: OverapiProject): void;
    removeProject(name: string): void;
    toolEnv(toolName: string): Record<string, string>;
  };
  tools?: {
    install(input: ToolInput): { ok: true } | { ok: false; error: string };
    uninstall(name: string): { ok: true } | { ok: false; error: string };
  };
}

/// What it borrows from the org service: who may do what, the audit log, the clock.
export interface OverapiHost {
  policy(): OrgPolicy;
  record(caller: OrgCaller, what: string): void;
  now(): number;
}

export class OverapiOrg {
  constructor(
    private readonly deps: OverapiDeps,
    private readonly host: OverapiHost,
  ) {}

  private memoryOffers: OverapiOffer[] = [];
  private memoryApis: OverapiLive[] = [];
  private loadOffers(): OverapiOffer[] {
    return this.deps.overapiOffers ? this.deps.overapiOffers.load().offers : this.memoryOffers;
  }
  private saveOffers(offers: OverapiOffer[]): void {
    if (this.deps.overapiOffers) this.deps.overapiOffers.save({ offers });
    else this.memoryOffers = offers;
  }
  private loadApis(): OverapiLive[] {
    return this.deps.overapiApis ? this.deps.overapiApis.load().apis : this.memoryApis;
  }
  private saveApis(apis: OverapiLive[]): void {
    if (this.deps.overapiApis) this.deps.overapiApis.save({ apis });
    else this.memoryApis = apis;
  }

  publish(caller: OrgCaller, input: { push: unknown }): Result<{ waiting: true }> {
    if (!canHire(this.host.policy(), caller) && !isAdmin(this.host.policy(), caller)) return { ok: false, error: 'Only people who may hire workers can publish an API.' };
    const parsed = parseApiPush(input.push);
    if (!parsed.ok) return { ok: false, error: parsed.reason };
    const push = parsed.push;
    // The inbox checked the file; this is the same cap for a push that came another way.
    if (JSON.stringify(push).length > API_PUSH_MAX_BYTES) return { ok: false, error: `${push.project.name} is larger than ${API_PUSH_MAX_BYTES} bytes.` };
    const offer: OverapiOffer = { id: randomUUID(), by: caller.name, ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}), at: this.host.now(), push };
    // The same person publishing the same API again replaces what they sent.
    const same = (o: OverapiOffer) => o.push.project.name === push.project.name && (caller.slackUserId ? o.slackUserId === caller.slackUserId : !o.slackUserId && o.by === caller.name);
    this.saveOffers([...this.loadOffers().filter((o) => !same(o)), offer].slice(-50));
    const env = pushEnv(push);
    this.host.record(caller, `Published the API ${push.project.name} (${push.env}, ${env.baseUrl}) from overapi, for an admin to finish.`);
    return { ok: true, waiting: true };
  }

  list(caller: OrgCaller): Result<{
    cli: string | null;
    offers: Array<OverapiOffer & { baseUrl: string; allowWrites: boolean; tools: OverapiToolSummary[]; replaces: boolean; moved: string[]; kept: string[] }>;
    apis: Array<{ name: string; title: string; by: string; at: number; env: string; baseUrl: string; allowWrites: boolean; secrets: string[]; missing: string[]; tools: OverapiToolSummary[] }>;
  }> {
    if (!isAdmin(this.host.policy(), caller)) return { ok: false, error: 'Only an admin can set up the server.' };
    const live = this.loadApis();
    const toolEnv = (name: string) => this.deps.overapi?.toolEnv(overapiToolName(name)) ?? {};
    return {
      ok: true,
      cli: this.deps.overapi?.cliPath() ?? null,
      offers: this.loadOffers()
        .slice()
        .reverse()
        .map((o) => {
          const env = pushEnv(o.push);
          const was = live.find((a) => a.name === o.push.project.name);
          const moved = was ? overapiChanges(was.project.envs[0], env) : [];
          const have = moved.length ? {} : toolEnv(o.push.project.name);
          return {
            ...o,
            baseUrl: env.baseUrl,
            allowWrites: env.allowWrites,
            tools: summary(o.push.project),
            replaces: Boolean(was),
            moved,
            kept: o.push.secrets.filter((s) => Boolean(have[s])),
          };
        }),
      apis: live.map((a) => {
        const env = toolEnv(a.name);
        return {
          name: a.name,
          title: a.project.title || a.name,
          by: a.by,
          at: a.at,
          env: a.env,
          baseUrl: a.project.envs[0].baseUrl,
          allowWrites: a.allowWrites,
          secrets: a.secrets,
          missing: a.secrets.filter((s) => !env[s]),
          tools: summary(a.project),
        };
      }),
    };
  }

  /// Finish a published API. Secrets only travel like a tool's keys do
  /// (`secure`: TLS, a trusted proxy that saw https, or this machine), and
  /// go straight into the tool's env. An update that points somewhere new,
  /// or signs in differently, needs its secrets typed again: kept ones are
  /// never sent to an address the admin didn't give them to. Writes are on
  /// only when both the publisher and the admin say so.
  approve(caller: OrgCaller, offerId: string, input: { allowWrites: boolean; secrets: Record<string, string> }, secure: boolean): Result {
    if (!isAdmin(this.host.policy(), caller)) return { ok: false, error: 'Only an admin can set up the server.' };
    const offer = this.loadOffers().find((o) => o.id === offerId);
    if (!offer) return { ok: false, error: 'No such API.' };
    const push = offer.push;
    const name = push.project.name;
    const published = pushEnv(push);
    const live = this.loadApis();
    const was = live.find((a) => a.name === name);
    const moved = was ? overapiChanges(was.project.envs[0], published) : [];
    const kept = moved.length ? {} : (this.deps.overapi?.toolEnv(overapiToolName(name)) ?? {});

    const env: Record<string, string> = {};
    const typed: string[] = [];
    const missing: string[] = [];
    for (const key of push.secrets) {
      const value = input.secrets[key];
      if (typeof value === 'string' && value) {
        env[key] = value;
        typed.push(key);
      } else if (kept[key]) env[key] = kept[key];
      else missing.push(key);
    }
    if (typed.length && !secure) return { ok: false, error: 'Secrets only travel over https, or to a server on this same machine.' };
    if (missing.length) {
      return moved.length
        ? { ok: false, error: `${name} changed its ${moved.join(' and ')}. Type ${missing.join(', ')} again to send ${missing.length === 1 ? 'it' : 'them'} there.` }
        : { ok: false, error: `${name} needs ${missing.join(', ')}.` };
    }

    const overapi = this.deps.overapi;
    const tools = this.deps.tools;
    if (!overapi || !tools) return { ok: false, error: 'APIs cannot be managed on this server.' };
    const cli = overapi.cliPath();
    if (!cli) return { ok: false, error: "overapi isn't installed on this server. Set OVERAPI_CLI to the path of overapi's dist/cli/index.js." };

    const allowWrites = published.allowWrites && input.allowWrites === true;
    // Only the served environment is written: it is all the tool reads.
    const project: OverapiProject = { ...push.project, envs: [{ ...published, allowWrites }] };
    try {
      overapi.writeProject(name, project);
    } catch (e) {
      return { ok: false, error: `Could not write ${name}'s project file: ${e instanceof Error ? e.message : String(e)}` };
    }
    const installed = tools.install({
      name: overapiToolName(name),
      kind: 'command',
      command: 'node',
      args: [cli, 'serve', overapi.projectFile(name), '--env', published.name],
      env,
    });
    if (!installed.ok) {
      // Put the file back as the tool still serves it.
      try {
        if (was) overapi.writeProject(name, was.project);
        else overapi.removeProject(name);
      } catch {
        // The install error is the one to report.
      }
      return installed;
    }
    this.saveApis([...live.filter((a) => a.name !== name), { name, by: offer.by, at: this.host.now(), env: published.name, allowWrites, secrets: push.secrets, project }]);
    this.saveOffers(this.loadOffers().filter((o) => o.id !== offerId));
    this.host.record(
      caller,
      `Set up the API ${name} (${published.name}, ${published.baseUrl}) from ${offer.by}'s overapi as the ${overapiToolName(name)} tool, ${allowWrites ? 'with writes allowed' : 'read-only'}${typed.length ? `, with ${typed.join(', ')} typed in` : ''}.`,
    );
    return { ok: true };
  }

  dismissOffer(caller: OrgCaller, offerId: string): Result {
    if (!isAdmin(this.host.policy(), caller)) return { ok: false, error: 'Only an admin can set up the server.' };
    const all = this.loadOffers();
    if (!all.some((o) => o.id === offerId)) return { ok: false, error: 'No such API.' };
    this.saveOffers(all.filter((o) => o.id !== offerId));
    return { ok: true };
  }

  /// Take a finished API away from workers: its tool, the secrets in the
  /// tool's env, and its project file.
  remove(caller: OrgCaller, name: string): Result {
    if (!isAdmin(this.host.policy(), caller)) return { ok: false, error: 'Only an admin can set up the server.' };
    const live = this.loadApis();
    const gone = live.find((a) => a.name === name);
    if (!gone) return { ok: false, error: 'No such API.' };
    const tools = this.deps.tools;
    if (!this.deps.overapi || !tools) return { ok: false, error: 'APIs cannot be managed on this server.' };
    const res = tools.uninstall(overapiToolName(name));
    if (!res.ok) return res;
    try {
      this.deps.overapi.removeProject(name);
    } catch {
      // The tool is gone, which is what workers see; a stray file serves nothing.
    }
    this.saveApis(live.filter((a) => a.name !== name));
    this.host.record(caller, `Removed the API ${name} and its ${overapiToolName(name)} tool.`);
    return { ok: true };
  }
}
