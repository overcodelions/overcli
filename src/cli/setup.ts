// `overcli tokens` and `overcli projects` — setting up the org's box.
//
// `tokens`: who may call `overcli serve`'s control plane.
//
// Run where the daemon's state lives (in a container: `docker exec … overcli
// tokens create …`). A token is printed once and only its hash is kept, so the
// person it is for must copy it now; losing it means revoking and minting
// another, never reading it back.

import { setHost } from '../main/host';
import { nodeHost } from '../main/hostNode';
import { createToken, initOrgConfig, listTokens, loadOrgPolicy, revokeToken } from '../main/org/orgStores';
import fs from 'node:fs';
import path from 'node:path';
import { Store, flushStoreSync } from '../main/store';
import { ensureProject } from './engines';
import type { OrgOptions, ProjectsOptions, TokensOptions, WorkersPushOptions } from './args';
import { ORG_TOKEN_ENV, ORG_URL_ENV, normalizeOrgUrl, publishTeamToOrg, publishToOrg } from '../main/org/orgClient';
import { shareForOrg, teamForOrg } from '../main/org/orgShare';
import { loadAllTeams } from '../main/flows/teamsStore';
import { loadAllWorkers } from '../main/flows/workersStore';
import { EXIT } from './run';

export function tokensCommand(opts: TokensOptions, deps: { out: (line: string) => void; err: (line: string) => void }): number {
  setHost(nodeHost({ dataDir: opts.stateDir }));
  if (opts.action === 'create') {
    const { token, record } = createToken({ name: opts.name!, slackUserId: opts.slackUserId, admin: opts.admin });
    deps.out(token);
    deps.err(
      `Token ${record.id} for ${record.name}${record.slackUserId ? ` (${record.slackUserId})` : ''}${record.admin ? ', admin' : ''}. ` +
        'Shown once — copy it now. Use it as "Authorization: Bearer <token>" on /mcp, or paste it into the console.',
    );
    if (!record.slackUserId && !record.admin) {
      deps.err('No --slack id: this token manages nothing and sees only org-wide workers.');
    }
    return EXIT.OK;
  }
  if (opts.action === 'list') {
    const all = listTokens();
    if (all.length === 0) deps.out('No tokens yet. overcli tokens create --name "Pat Lee" --slack U012AB3CD');
    for (const t of all) {
      const used = t.lastUsedAt ? new Date(t.lastUsedAt).toISOString() : 'never';
      deps.out(`${t.id}  ${t.name}${t.slackUserId ? `  ${t.slackUserId}` : ''}${t.admin ? '  admin' : ''}  last used ${used}`);
    }
    return EXIT.OK;
  }
  if (!revokeToken(opts.target!)) {
    deps.err(`No token with id or name "${opts.target}".`);
    return EXIT.BAD_INPUT;
  }
  deps.out(`Revoked ${opts.target}.`);
  return EXIT.OK;
}

/// `overcli projects` — register the folders workers here may work in. On a
/// headless box nothing else does: the desktop app adds projects as you open
/// them, and a hire with no project to land in fails.
export function projectsCommand(opts: ProjectsOptions, deps: { out: (line: string) => void; err: (line: string) => void }): number {
  setHost(nodeHost({ dataDir: opts.stateDir }));
  if (opts.action === 'list') {
    const projects = Store.load().projects;
    if (projects.length === 0) deps.out('No projects yet. overcli projects add /data/repos/acme-app');
    for (const p of projects) deps.out(`${p.name}  ${p.path}`);
    return EXIT.OK;
  }
  const dir = path.resolve(opts.path!);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    deps.err(`${dir} is not a folder. Clone or create it first.`);
    return EXIT.BAD_INPUT;
  }
  ensureProject(dir, opts.name);
  // Store writes are debounced and this process exits right away.
  flushStoreSync();
  deps.out(`Added ${opts.name ?? path.basename(dir)} (${dir}).`);
  return EXIT.OK;
}

/// `overcli org` — name the org this box serves, and see its rules.
export function orgCommand(opts: OrgOptions, deps: { out: (line: string) => void; err: (line: string) => void }): number {
  setHost(nodeHost({ dataDir: opts.stateDir }));
  if (opts.action === 'init') {
    const res = initOrgConfig({
      name: opts.name!,
      admins: opts.admins,
      slackTeamId: opts.slackTeamId,
      timezone: opts.timezone,
      publicUrl: opts.publicUrl,
      force: opts.force,
    });
    deps.out(`${res.created ? 'Created' : 'Updated'} ${res.file} for ${opts.name}.`);
    if (!opts.admins.length) deps.err('No --admin yet: add your Slack member id so someone can run the org from Slack.');
    if (!opts.slackTeamId) deps.err('No --slack-team: the Slack bridge will accept any workspace its token belongs to.');
    return EXIT.OK;
  }
  const { policy, warnings, fromFile } = loadOrgPolicy();
  if (!fromFile) {
    deps.out('No org.json yet. overcli org init --name "Acme" --admin U012AB3CD');
    return EXIT.OK;
  }
  deps.out(JSON.stringify(policy, null, 2));
  for (const w of warnings) deps.err(`! ${w}`);
  return EXIT.OK;
}

/// Where to publish, from flags or the environment.
function orgTarget(opts: WorkersPushOptions, err: (line: string) => void): { url: string; token: string } | null {
  const rawUrl = opts.to ?? process.env[ORG_URL_ENV];
  if (!rawUrl) {
    err(`Say where: --to https://overcli.acme.internal:7420, or set $${ORG_URL_ENV}.`);
    return null;
  }
  const url = normalizeOrgUrl(rawUrl);
  if (!url.ok) {
    err(url.error);
    return null;
  }
  const token = opts.token ?? process.env[ORG_TOKEN_ENV]?.trim();
  if (!token) {
    err(`Add your org token: --token, or $${ORG_TOKEN_ENV}. An admin makes one with overcli tokens create.`);
    return null;
  }
  return { url: url.url, token };
}

/// `overcli workers push` — hand a worker you built to your org's server.
export async function workersPushCommand(
  opts: WorkersPushOptions,
  deps: { out: (line: string) => void; err: (line: string) => void },
): Promise<number> {
  const target = orgTarget(opts, deps.err);
  if (!target) return EXIT.BAD_INPUT;
  let yaml: string;
  let localId: string | undefined;
  let tools: ReturnType<typeof shareForOrg>['tools'] = [];
  if (/\.ya?ml$/i.test(opts.target) && fs.existsSync(opts.target)) {
    yaml = fs.readFileSync(opts.target, 'utf8');
  } else {
    setHost(nodeHost({ dataDir: opts.stateDir }));
    const key = opts.target.trim().toLowerCase();
    const worker = loadAllWorkers().find((w) => w.name.trim().toLowerCase() === key || w.id === opts.target);
    if (!worker) {
      deps.err(`No worker called "${opts.target}" in this state directory, and no such .yaml file.`);
      return EXIT.BAD_INPUT;
    }
    const share = shareForOrg(worker);
    if (share.missingFlowIds.length) deps.err(`! ${worker.name}'s flows not found here, so not sent: ${share.missingFlowIds.join(', ')}`);
    yaml = share.yaml;
    tools = share.tools;
    localId = worker.id;
  }
  const res = await publishToOrg(target.url, target.token, yaml, opts.visibility ? { visibility: opts.visibility } : {}, tools, localId);
  if (!res.ok) {
    deps.err(res.error);
    return EXIT.RUN_FAILED;
  }
  deps.out(res.message);
  return EXIT.OK;
}

/// `overcli teams push` — a team you built, members and all, to your org's
/// server. Members it already has are reused; published again, the team is
/// updated there.
export async function teamsPushCommand(
  opts: WorkersPushOptions,
  deps: { out: (line: string) => void; err: (line: string) => void },
): Promise<number> {
  const target = orgTarget(opts, deps.err);
  if (!target) return EXIT.BAD_INPUT;
  setHost(nodeHost({ dataDir: opts.stateDir }));
  const key = opts.target.trim().toLowerCase();
  const team = loadAllTeams().find((t) => t.name.trim().toLowerCase() === key || t.id === opts.target);
  if (!team) {
    deps.err(`No team called "${opts.target}" in this state directory.`);
    return EXIT.BAD_INPUT;
  }
  const built = teamForOrg(team, loadAllWorkers());
  if (!built.ok) {
    deps.err(built.error);
    return EXIT.BAD_INPUT;
  }
  const res = await publishTeamToOrg(target.url, target.token, built.payload);
  if (!res.ok) {
    deps.err(res.error);
    return EXIT.RUN_FAILED;
  }
  deps.out(res.message);
  return EXIT.OK;
}
