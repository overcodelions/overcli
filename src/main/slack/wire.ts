// Build the Slack bridge over the engines — shared by the app (index.ts) and
// `overcli serve` (cli/engines.ts), so the two hosts cannot drift on how an
// answer reaches a run or how a rejection settles its batch item.

import { adminReply, statusReply } from './statusReply';
import { initialsPicture } from '../../shared/flows/avatars';
import { log } from '../diagnostics';
import { collectKnownSecretValues, redactSecrets, setOutboundScrub } from '../secretScrub';
import type { FlowRuntimeImpl } from '../flows/runtime';
import type { OrchestratorImpl } from '../flows/orchestrator';
import type { WorkerEngine } from '../flows/workerEngine';
import { SlackBridge, type SlackBridgeStatus } from './slackBridge';
import { configuredSlackToken } from './slackSettings';
import { fileThreadStore } from './threadStore';
import { createOrgService, rejectWorkerRun, type OrgEngines } from '../org/wire';
import { reachesOutside, type OrgService } from '../org/orgService';
import { createToken, fileAccessStore, fileAuditStore, linkTokensToSlack, listTokens, loadOrgPolicy, revokeToken, revokeTokensFor, updateOrgFile } from '../org/orgStores';
import { AccessService } from '../org/accessService';
import { SlackCommands, type TeamCardRef } from './slackCommands';
import { SsoService, SSO_CLIENT_SECRET_ENV } from '../org/sso';
import { ConnectionsService } from '../org/connections';
import { ToolSignIn } from '../org/toolSignIn';
import { installTool, installedToolUrl } from '../org/tools';
import { downloadFile, fetchMessage, fetchRecent, openIm, fetchThread, lookupByEmail, permalink, postMessage, slackRead, updateMessage, uploadFile } from './slackApi';
import { FrontDoor, type FrontDoorState, type FrontDoorWorker } from './frontDoor';
import { answerGeneral, routeRequest } from './frontDoorRoute';
import { libraryCandidates, matchExisting, matchWork, whenText, type WorkCandidate } from './existingWork';
import { answerFromWork, type AnswerSource } from './existingAnswer';
import { drafterDepsFor } from '../org/hireDraft';
import { canManage, canSee, inAudience, isAdmin, type AudienceRole, type OrgCaller } from '../../shared/org/policy';
import { managerFor } from '../../shared/flows/org';
import type { ProcessPerson, ProcessState } from '../../shared/org/process';
import { ProcessService } from '../org/processes';
import { jsonOrgStore } from '../org/orgStores';
import fs from 'node:fs';
import { workerFilesDir } from '../flows/workerFiles';
import { teamTaskDir } from '../flows/teamsStore';
import path from 'node:path';
import { TriggerService, triggerFiles } from '../org/triggers';
import { callTool } from '../org/mcpDirect';
import { readClaudeMcpServers } from '../mcpConfig';
import { fileDigestState, orgDir } from '../org/orgStores';
import { digestDue } from '../org/orgService';
import { Store } from '../store';
import { setProviderModels } from '../backends/providerModels';
import { changesOfRun } from '../org/runChanges';

/// Whoever else is in a channel: someone with no access of their own. What
/// they can see is what a reply in the channel may draw on.
const EVERYONE: OrgCaller = { name: 'everyone in the channel', admin: false };
/// How long a question's candidates are reused, between answering it and
/// looking it up.
const CANDIDATES_TTL_MS = 60_000;

export function createSlackBridge(engines: {
  flowRuntime: Pick<FlowRuntimeImpl, 'getRun' | 'listRuns' | 'steerRun' | 'resumeRun' | 'abortRun'>;
  orchestrator: Pick<OrchestratorImpl, 'get' | 'rejectItem'>;
  workerEngine: Pick<WorkerEngine, 'roster'>;
  onStatus?: (status: SlackBridgeStatus) => void;
}): SlackBridge {
  const { flowRuntime, orchestrator, workerEngine } = engines;
  const tokens = () => ({ bot: configuredSlackToken('bot'), app: configuredSlackToken('app') });
  return new SlackBridge({
    tokens,
    expectedTeamId: () => loadOrgPolicy().policy.slackTeamId,
    workers: () => workerEngine.roster(),
    getRun: (id) => flowRuntime.getRun(id),
    listRuns: () => flowRuntime.listRuns(),
    steerRun: (args) => flowRuntime.steerRun(args),
    resumeRun: (args) => flowRuntime.resumeRun(args),
    rejectRun: (runId) => rejectWorkerRun({ flowRuntime, orchestrator }, runId),
    runChanges: async (runId, diff) => {
      const run = flowRuntime.getRun(runId);
      return run ? changesOfRun(run, { diff }) : null;
    },
    store: fileThreadStore,
    standIn: () => loadOrgPolicy().policy.admins[0],
    onStatus: engines.onStatus,
    log: (level, message) => {
      const t = tokens();
      const known = collectKnownSecretValues(process.env, [t.bot, t.app]);
      log(level, 'slack', redactSecrets(message, known).text);
    },
  });
}

/// The org control plane and its Slack commands, built together because each
/// needs the other: hires waiting on approval are announced in Slack, and the
/// Slack commands act through the control plane.
export function createOrgControl(
  engines: OrgEngines,
  slack: SlackBridge,
  /// Who the Slack front door takes requests from. The org's server: anyone
  /// in the workspace. The desktop: its owner only (`slackOwnerId`), since
  /// the work runs on their laptop and their model account.
  options: { frontDoorOwner?: () => string | undefined } = {},
): { org: OrgService; commands: SlackCommands; access: AccessService; sso: SsoService; triggers: TriggerService; frontDoor: FrontDoor; connections: ConnectionsService; processes: ProcessService } {
  let commands: SlackCommands | null = null;
  // What workers say to people is scrubbed of credentials, by the org's rule:
  // the patterns, the environment's secrets, and every stored one whatever
  // it is called.
  setOutboundScrub({
    enabled: () => loadOrgPolicy().policy.redactSecrets,
    known: () => [...(engines.secrets?.values() ?? []), configuredSlackToken('bot'), configuredSlackToken('app')],
  });
  // Model ids as the server's provider (Bedrock, Vertex) names them.
  setProviderModels(() => loadOrgPolicy().policy.providerModels);
  // Each person's own Google Drive. Its client comes from Setup → Secrets
  // (or the environment); its encryption key stays in the secrets store.
  const secrets = engines.secrets;
  const connections =
    engines.connections ??
    new ConnectionsService({
      dir: () => orgDir(),
      publicUrl: () => loadOrgPolicy().policy.publicUrl,
      ...(secrets ? { privateSecrets: { get: (name) => secrets.getPrivate(name), set: (name, value) => secrets.setPrivate(name, value) } } : {}),
      log: (message) => log('info', 'org', message),
    });
  // Remote tools an admin signs in to once for everyone, sealed with the
  // same key; renewed on a timer so the header workers read stays good.
  const toolSignIn =
    engines.toolSignIn ??
    new ToolSignIn({
      dir: () => orgDir(),
      publicUrl: () => loadOrgPolicy().policy.publicUrl,
      sealKey: () => connections.encryptionKey(),
      install: (name, url, token) => installTool({ name, kind: 'http', url, headers: { Authorization: `Bearer ${token}` } }),
      installedUrl: (name) => installedToolUrl(name),
      log: (message) => log('info', 'org', message),
    });
  toolSignIn.keepFresh();
  let triggers: TriggerService | null = null;
  const access = new AccessService({
    policy: () => loadOrgPolicy().policy,
    ssoRequired: () => !!loadOrgPolicy().policy.sso?.required && !!loadOrgPolicy().policy.publicUrl,
    store: fileAccessStore,
    tokens: {
      create: (args) => createToken(args),
      revokeFor: (id) => revokeTokensFor(id),
      revoke: (id) => revokeToken(id),
      list: () => listTokens(),
      link: (name, admin, id, slackName) => linkTokensToSlack(name, admin, id, slackName),
    },
    linkManagers: (name, id, slackName) => org.linkManagers(name, id, slackName),
    updateOrg: (mutate) => updateOrgFile(mutate),
    record: (caller, what) =>
      fileAuditStore.append({ at: Date.now(), by: caller.name, ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}), what }),
    slack: {
      // Slack is optional: without a connected bot the DM is simply not
      // sent, and the console shows the link to hand over instead.
      dmInvite: async (invite, link, orgName) => (slack.teamId() && commands ? commands.dmInvite(invite, link, orgName) : false),
      askAdmins: (request, admins, orgName) => {
        if (slack.teamId()) commands?.askAdmins(request, admins, orgName);
      },
      tellRequester: (id, text) => {
        if (slack.teamId()) commands?.tellRequester(id, text);
      },
      dmLinkSlack: async (id, linkId, signedInAs, orgName) => (slack.teamId() && commands ? commands.dmLinkSlack(id, linkId, signedInAs, orgName) : false),
    },
  });
  const org = createOrgService({
    ...engines,
    connections,
    toolSignIn,
    triggers: () => triggers,
    health: () => {
      const s = slack.getStatus();
      return [
        ...(engines.health?.() ?? []),
        {
          name: 'Slack',
          ok: s.enabled ? s.connected : null,
          detail: !s.enabled
            ? 'Off. Questions and approvals wait in the console.'
            : s.connected
              ? `Connected to ${s.team ?? 'Slack'}. ${s.openThreads} DM${s.openThreads === 1 ? '' : 's'} waiting on managers.`
              : `Not connected${s.error ? `: ${s.error}` : '.'}`,
        },
        ...(loadOrgPolicy().policy.sso
          ? (() => {
              const st = sso.status();
              return [{ name: 'Company sign-in', ok: st.enabled, detail: st.enabled ? `Through ${st.provider}${st.required ? ', for everyone' : ''}.` : st.problem ?? 'Not set up.' }];
            })()
          : []),
      ];
    },
  }, {
    onHireAwaitingApproval: (hire, approvers) => commands?.notifyApprovers(hire, approvers),
    onHireDecided: (hire, outcome) => commands?.notifyDecided(hire, outcome),
    onToolsWanted: (hire, tools, admins) => commands?.notifyToolsWanted(hire, tools, admins),
    onToolRequest: (r, admins) => commands?.notifyToolRequest(r, admins),
    onToolRequestDecided: (r) => commands?.notifyToolRequestDecided(r),
    onToolTrouble: (t, admins) => commands?.notifyToolTrouble(t, admins),
    onAskDone: (ask) => commands?.askAnswered(ask),
  });
  // The Monday digest: to everyone who manages a worker, and the admins.
  const digestTimer = setInterval(() => {
    const policy = loadOrgPolicy().policy;
    const week = digestDue(Date.now(), policy.timezone, fileDigestState.lastWeek());
    if (!week || !commands || !slack.getStatus().connected) return;
    fileDigestState.sent(week);
    const people = new Set([...policy.admins, ...engines.workerEngine.roster().filter((w) => w.enabled).map((w) => w.manager?.slackUserId).filter((id): id is string => !!id)]);
    for (const id of people) void commands.sendDigest(id).catch(() => false);
  }, 15 * 60_000);
  digestTimer.unref?.();
  slack.setAlwaysAllow((slackUserId, runId) => {
    const policy = loadOrgPolicy().policy;
    const name = (policy.people?.[slackUserId] as { name?: string } | undefined)?.name ?? slackUserId;
    return org.alwaysAllowStep({ slackUserId, name, admin: isAdmin(policy, { slackUserId, name, admin: false }) }, runId);
  });
  commands = new SlackCommands({
    // Replies under a worker's results go to it (the door is made below).
    adoptThread: (channel, threadTs, worker) => frontDoor.adopt(channel, threadTs, worker),
    // The pack's summary, read against the pack itself: what the team found,
    // said for whoever asked, with its labels named.
    plainPack: async (task) => {
      if (!task.pack) return null;
      const sources: AnswerSource[] = [
        { label: `${task.teamName}'s summary of what it found`, who: task.teamName, body: task.pack.summary },
        { label: `${task.teamName}'s pack, for what its labels mean`, who: task.teamName, body: packText(task.id) },
      ].filter((x) => x.body.trim());
      const got = await answerFromWork(drafterDepsFor(engines.runner), `What did ${task.teamName} find? The request was: ${task.title ?? task.brief}`, sources);
      return got?.text ?? null;
    },
    processes: () => processes,
    processDms: (() => {
      const store = jsonOrgStore<Record<string, Array<{ channel: string; ts: string }>>>('process-decision-dms.json', () => ({}));
      return { load: () => store.load(), save: (all) => store.save(all) };
    })(),
    org,
    access,
    policy: () => loadOrgPolicy().policy,
    botToken: () => configuredSlackToken('bot'),
    teamId: () => slack.teamId(),
    log: (level, message) => log(level, 'slack', message),
    readFile: (file, maxBytes) => {
      try {
        return fs.statSync(file).size <= maxBytes ? fs.readFileSync(file) : null;
      } catch {
        return null;
      }
    },
    libraryUrl: () => loadOrgPolicy().policy.publicUrl ?? null,
    places: () => {
      const store = Store.load();
      return [...store.workspaces.map((w) => ({ name: w.name, path: w.rootPath })), ...store.projects.map((x) => ({ name: x.name, path: x.path }))];
    },
    teamThreads: (() => {
      const store = jsonOrgStore<Record<string, string>>('team-question-threads.json', () => ({}));
      return { load: () => store.load(), save: (all) => store.save(all) };
    })(),
    teamCards: (() => {
      const store = jsonOrgStore<Record<string, TeamCardRef>>('team-cards.json', () => ({}));
      return { load: () => store.load(), save: (all) => store.save(all) };
    })(),
    pieceLook: (runId) => {
      const run = engines.flowRuntime.getRun(runId);
      if (!run) return null;
      const said = engines.runActivity?.list(runId).filter((x) => x.kind === 'tool' || x.kind === 'said').at(-1);
      const waitingOn = run.state.kind === 'paused' ? run.flowSnapshot.steps.find((s) => s.id === (run.state as { nextStepId?: string }).nextStepId) : undefined;
      return { ...(said ? { last: { text: said.text, at: said.at } } : {}), ...(waitingOn ? { reaches: reachesOutside(waitingOn) } : {}) };
    },
    // A file in the task's own folder, by a plain name, links resolved.
    teamFile: (taskId, name, maxBytes) => {
      // Folders allowed ("pack/report.html"); no hidden parts or `..`, and
      // links resolved below keep it inside the task's own folder.
      if (!/^[\w.-]{1,40}$/.test(taskId) || !/^[\w. ()/-]{1,300}$/.test(name) || name.split('/').some((p) => !p || p.startsWith('.'))) return null;
      try {
        const root = fs.realpathSync(teamTaskDir(taskId));
        const real = fs.realpathSync(path.join(root, name));
        if (!real.startsWith(root + path.sep)) return null;
        const st = fs.statSync(real);
        return st.isFile() && st.size <= maxBytes ? fs.readFileSync(real) : null;
      } catch {
        return null;
      }
    },
  });
  slack.setCommands(commands);
  slack.setThreadFor((runId) => org.slackThreadFor({ runId }));
  // Cards a restart left behind catch up once Slack has had a moment to connect.
  const catchUp = setTimeout(() => commands?.refreshTeamCards(engines.teams?.()?.list().tasks ?? []), 8000);
  catchUp.unref?.();
  const sso = new SsoService({
    sso: () => loadOrgPolicy().policy.sso,
    publicUrl: () => loadOrgPolicy().policy.publicUrl,
    clientSecret: () => process.env[SSO_CLIENT_SECRET_ENV]?.trim() || undefined,
    // org.json's people first; then Slack, which knows everyone's work email.
    resolvePerson: async (email) => {
      const listed = loadOrgPolicy().policy.people[email];
      if (listed) return { slackUserId: listed };
      const bot = configuredSlackToken('bot');
      if (!bot) return null;
      const found = await lookupByEmail(bot, email);
      if (!found.ok) {
        log('info', 'org', `Company sign-in: no Slack member for this email (${found.error}).`);
        return null;
      }
      return { slackUserId: found.data.id, name: found.data.name };
    },
    signIn: (person) => access.signInWithSso(person),
  });
  // Work moving between teams and people's decisions. A team stage briefs
  // its team as the stage's owner; a people stage DMs its deciders.
  const processes = new ProcessService({
    store: jsonOrgStore<ProcessState>('processes.json', () => ({ processes: [], items: [] })),
    teams: () => {
      const roster = engines.workerEngine.roster();
      return (engines.teams?.()?.list().teams ?? [])
        .filter((t) => !t.disbanded)
        .map((t) => {
          const lead = t.members.map((m) => managerFor(roster, m.workerId)).find(Boolean);
          return { id: t.id, name: t.name, ...(lead ? { owner: { name: lead.name, ...(lead.slackUserId ? { slackUserId: lead.slackUserId } : {}) } } : {}) };
        });
    },
    task: (taskId) => {
      const t = engines.teams?.()?.list().tasks.find((x) => x.id === taskId);
      if (!t) return null;
      return {
        status: t.status,
        ...(t.title ? { title: t.title } : {}),
        ...(t.pack ? { pack: { summary: t.pack.summary, files: t.pack.files } } : {}),
        ...(t.code?.branch ? { branch: t.code.branch } : {}),
        ...(t.error ? { error: t.error } : {}),
        ...(t.waiting ? { waiting: t.waiting.message } : {}),
      };
    },
    brief: (teamId, text, by, code) => {
      const teams = engines.teams?.();
      if (!teams) return { ok: false, error: 'Teams are not running here.' };
      const res = teams.brief(teamId, text, [], code?.projectPath, { requestedBy: by, ...(code?.startFrom ? { startFrom: code.startFrom } : {}) });
      return res.ok ? { ok: true, taskId: res.task.id } : res;
    },
    readFile: (taskId, name) => {
      const res = engines.teams?.()?.readFile(taskId, name);
      return res?.ok ? res.body : null;
    },
    cancelTask: (taskId) => void engines.teams?.()?.cancel(taskId),
    cancelAsk: (askId) => void org.cancelAsk(askId),
    workerAccess: (caller, workerId) => {
      const policy = loadOrgPolicy().policy;
      const roster = engines.workerEngine.roster();
      return canManage(policy, roster, workerId, caller) ? 'manage' : canSee(policy, roster, workerId, caller) ? 'see' : null;
    },
    workers: () => {
      const roster = engines.workerEngine.roster();
      return roster
        .filter((w) => w.enabled)
        .map((w) => {
          const lead = managerFor(roster, w.id);
          return { id: w.id, name: w.name, ...(lead ? { owner: { name: lead.name, ...(lead.slackUserId ? { slackUserId: lead.slackUserId } : {}) } } : {}) };
        });
    },
    // Whoever put the worker in the stage could see it then (the process
    // checks), so its visibility doesn't stop it now. It acts on the work as
    // from its manager only when its manager put it there; otherwise it
    // takes it as a proposal, as from anyone else.
    askWorker: (workerId, text, by, trusted) => {
      const started = org.startAsk({ name: by.name, ...(by.slackUserId ? { slackUserId: by.slackUserId } : {}), admin: true }, workerId, text, 'console', undefined, undefined, undefined, undefined, !trusted);
      if (!started.ok) return started;
      started.done.catch(() => {});
      return { ok: true, askId: started.askId };
    },
    workerTask: (askId) => {
      const found = org.askStatus({ name: 'overcli', admin: true }, askId);
      if (!found.ok) return null;
      const ask = found.ask;
      if (ask.status === 'working') return { status: 'running' };
      if (ask.status === 'failed') return { status: 'failed', ...(ask.error ? { error: ask.error } : {}) };
      // It answered by starting work: done when that work ends.
      const progress = ask.orchestrationId ? org.errandProgress(ask.orchestrationId) : null;
      if (progress && !progress.done) {
        if (progress.items.some((i) => i.status === 'proposed')) return { status: 'waiting', waiting: 'its plan waits for an OK' };
        const paused = progress.items.find((i) => i.paused);
        return paused ? { status: 'waiting', waiting: paused.paused } : { status: 'running' };
      }
      const links = progress?.links ?? [];
      return {
        status: 'done',
        title: ask.workerName,
        pack: { summary: [ask.reply ?? '', links.length ? `Links: ${links.join(' ')}` : ''].filter(Boolean).join('\n\n'), files: [] },
      };
    },
    isAdmin: (caller) => isAdmin(loadOrgPolicy().policy, caller),
    groupMembers: (groupId) => org.directory().groups.find((g) => g.id === groupId)?.members ?? [],
    hasRole: (person, roles) => inAudience(loadOrgPolicy().policy, { name: person.name, admin: false, ...(person.slackUserId ? { slackUserId: person.slackUserId } : {}) }, { roles: roles as AudienceRole[] }),
    notify: (to, text, decide) => void commands?.processNotify(to, text, decide),
    decided: (itemId, stageId, text, final) => void commands?.processDecided(itemId, stageId, text, final),
    log: (message) => log('info', 'org', message),
  });
  processes.start();
  // Workers acting on business events: watches, webhooks, Slack channels.
  triggers = new TriggerService({
    handTo: (hand, ev) => {
      const brief = ev.url ? `${ev.text}\n\nSource: ${ev.url}` : ev.text;
      if (hand.kind === 'process') {
        const res = processes.submit({ name: ev.triggerName }, hand.processId, { title: ev.title, brief, source: 'trigger', ...(ev.url ? { sourceUrl: ev.url } : {}) });
        return res.ok ? { ok: true, label: `${res.process.name} (${res.process.stages[0].name})` } : res;
      }
      const teams = engines.teams?.();
      const team = teams?.list().teams.find((t) => t.id === hand.teamId && !t.disbanded);
      if (!teams || !team) return { ok: false, error: 'That team is gone.' };
      const roster = engines.workerEngine.roster();
      const lead = team.members.map((m) => managerFor(roster, m.workerId)).find(Boolean);
      const res = teams.brief(team.id, brief, [], undefined, lead ? { requestedBy: { name: lead.name, ...(lead.slackUserId ? { slackUserId: lead.slackUserId } : {}) } } : {});
      return res.ok ? { ok: true, label: `${team.name} (a team task)` } : res;
    },
    ...triggerFiles(orgDir()),
    worker: (id) => {
      const w = engines.workerEngine.roster().find((x) => x.id === id);
      return w ? { id: w.id, name: w.name, enabled: w.enabled } : null;
    },
    ask: (workerId, triggerName, text, startsOnItsOwn) => {
      const started = org.startAsk({ name: triggerName, admin: true }, workerId, text, 'trigger', undefined, undefined, undefined, undefined, false, startsOnItsOwn);
      return started.ok
        ? { ok: true, askId: started.askId, done: started.done.then((r) => (r.ok ? { ok: true as const, reply: r.reply, launched: r.launched } : r)) }
        : started;
    },
    toolConfig: (name) => readClaudeMcpServers()[name] ?? null,
    callTool,
    slack: {
      post: async (channel, text, threadTs) => {
        const bot = configuredSlackToken('bot');
        if (!bot || !slack.teamId()) return false;
        const res = await postMessage(bot, { channel, text, ...(threadTs ? { threadTs } : {}) });
        if (!res.ok) log('warn', 'slack', `A trigger could not post to ${channel}: ${res.error}`);
        return res.ok;
      },
      message: async (channel, ts) => {
        const bot = configuredSlackToken('bot');
        if (!bot) return null;
        const res = await fetchMessage(bot, channel, ts);
        return res.ok ? res.data : null;
      },
      dm: async (slackUserId, text) => {
        const bot = configuredSlackToken('bot');
        if (!bot) return false;
        const im = await openIm(bot, slackUserId);
        if (!im.ok) return false;
        const res = await postMessage(bot, { channel: im.data, text });
        if (!res.ok) log('warn', 'slack', `A trigger could not DM ${slackUserId}: ${res.error}`);
        return res.ok;
      },
    },
    log: (message) => log('info', 'org', message),
  });
  slack.setEventTap((ev) => triggers?.slackEvent(ev) ?? false);
  // "@overgo …" and DMs: whichever worker fits takes the request.
  const names = new Map<string, string>();
  const bot = () => (slack.teamId() ? configuredSlackToken('bot') : undefined);
  const owner = options.frontDoorOwner;
  // A team task's pack, every file of it, as one text.
  const packText = (taskId: string): string => {
    const teams = engines.teams?.();
    const task = teams?.list().tasks.find((t) => t.id === taskId);
    return (task?.pack?.files ?? [])
      .map((f) => {
        const got = teams?.readFile?.(taskId, f);
        return got?.ok ? got.body : '';
      })
      .join('\n\n');
  };
  // What the caller can see in the Library, and finished process items: what
  // the front door looks through before handing a question to anyone. In a
  // channel (`shared`), only what everyone can see: what a person with no
  // access of their own would, and in the Library as open to everyone.
  const workCandidates = (caller: OrgCaller, shared: boolean): WorkCandidate[] => {
    const consoleUrl = loadOrgPolicy().policy.publicUrl;
    const tasks = new Map((engines.teams?.()?.list().tasks ?? []).map((t) => [t.id, t]));
    const viewer = shared ? EVERYONE : caller;
    const items = org.library(viewer, { limit: 300 }).filter((i) => !shared || i.visibility === 'org');
    const candidates: WorkCandidate[] = libraryCandidates(items, {
      ...(consoleUrl ? { consoleUrl } : {}),
      taskStatus: (taskId) => {
        const t = tasks.get(taskId);
        if (t?.status !== 'review') return undefined;
        return t.requestedBy?.slackUserId && t.requestedBy.slackUserId === caller.slackUserId ? 'waiting on your review' : 'waiting on review';
      },
      room: (taskId) => tasks.get(taskId)?.room?.messages,
    });
    for (const p of processes.list(viewer)) {
      const got = processes.get(viewer, p.id);
      if (!got.ok) continue;
      for (const i of got.items) {
        if (i.status !== 'done') continue;
        const last = i.artifacts.at(-1);
        candidates.push({
          hit: { kind: 'process', title: i.title, who: p.name, at: i.finishedAt ?? i.updatedAt, ...(consoleUrl ? { url: `${consoleUrl.replace(/\/+$/, '')}/#process/${encodeURIComponent(p.id)}/${encodeURIComponent(i.id)}` } : {}) },
          body: last ? `${last.summary}\n${i.brief}` : i.brief,
          ...(last?.taskId ? { group: `task:${last.taskId}` } : {}),
        });
      }
    }
    // The room's Ask is only for whoever asked for the task: not offered to anyone else.
    for (const c of candidates) if (c.hit.teamTaskId && !org.mayTalkToRoom(caller, c.hit.teamTaskId)) c.hit.canAsk = false;
    return candidates;
  };
  // The answer and the lookup after it read the same candidates: built once
  // for a question, not again when the answer comes back empty.
  let lastCandidates: { key: string; at: number; list: WorkCandidate[] } | null = null;
  const candidatesFor = (caller: OrgCaller, shared: boolean): WorkCandidate[] => {
    const key = `${caller.slackUserId ?? caller.name}:${shared}`;
    const now = Date.now();
    if (lastCandidates?.key === key && now - lastCandidates.at < CANDIDATES_TTL_MS) return lastCandidates.list;
    const list = workCandidates(caller, shared);
    lastCandidates = { key, at: now, list };
    return list;
  };
  // A team's knowledge goes into a channel's answer only when the team is
  // open to everyone: one of its members is (as the Library has it).
  const openToEveryone = (team: { members: Array<{ workerId: string }> }): boolean => {
    const roster = engines.workerEngine.roster();
    return team.members.some((m) => roster.find((w) => w.id === m.workerId)?.visibility === 'org');
  };
  const frontDoor = new FrontDoor({
    // Only those the person may start: the router never offers one they can't.
    processes: (caller) =>
      processes.list(caller).filter((p) => p.stages.length && p.canStart).map((p) => ({ id: p.id, name: p.name, ...(p.purpose ? { purpose: p.purpose } : {}), firstStage: p.stages[0].name })),
    submitProcess: (caller, processId, brief) => {
      const res = processes.submit({ name: caller.name, ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}) }, processId, { brief, source: 'slack' });
      return res.ok ? { ok: true, title: res.item.title, process: res.process.name, stage: res.process.stages[0].name } : res;
    },
    status: (caller) => statusReply(org.today(caller), loadOrgPolicy().policy.publicUrl, processes.waitingOn(caller)),
    admin: (caller, text) =>
      adminReply(text, {
        today: () => org.today(caller),
        work: () => {
          const res = org.report(caller, 30);
          return res.ok ? res.report.byWorker.map((r) => ({ name: r.name, itemsDone: r.itemsDone, runs: r.runs, workedMs: r.workedMs })) : null;
        },
      }, loadOrgPolicy().policy.publicUrl),
    // What the caller can see in the Library, and finished process items,
    // matched against the question: what already answers it is offered first.
    findExisting: (caller, text, { shared }) => matchExisting(text, candidatesFor(caller, shared), Date.now()),
    // What the room said, with the task's pack beside it to name what its
    // labels stand for: the question answered from those, for Slack.
    plain: async (question, answer, taskId) => {
      const task = engines.teams?.()?.list().tasks.find((t) => t.id === taskId);
      const pack = packText(taskId);
      const sources: AnswerSource[] = [
        { label: `What ${task?.teamName ?? 'the team'} said just now`, who: task?.teamName ?? 'the team', body: answer },
        ...(pack.trim() ? [{ label: `${task?.teamName ?? 'The team'}'s pack, for what its labels mean`, who: task?.teamName ?? 'the team', body: pack }] : []),
      ];
      return (await answerFromWork(drafterDepsFor(engines.runner), question, sources))?.text ?? null;
    },
    // The finished work that matches, and what each team the caller can see
    // knows: read, and the question answered from them.
    answer: async (caller, text, { shared }) => {
      const now = Date.now();
      const work = matchWork(text, candidatesFor(caller, shared), now).filter((m) => !m.weak).slice(0, 3);
      const seen = new Set(org.teams(shared ? EVERYONE : caller).map((t) => t.id));
      const sources: AnswerSource[] = [
        ...work.map(({ candidate: c }): AnswerSource => ({
          label: `${c.hit.who}'s ${c.hit.kind === 'team' ? 'task' : 'work'} "${c.hit.title}" (${whenText(c.hit.at, now)})`,
          who: c.hit.who,
          body: c.body ?? '',
          hit: { ...c.hit, summary: '' },
        })),
        ...(engines.teams?.()?.list().teams ?? [])
          .filter((t) => seen.has(t.id) && (!shared || openToEveryone(t)) && t.knowledge?.status === 'ready' && t.knowledge.body?.trim())
          .map((t): AnswerSource => ({ label: `What ${t.name} knows${t.knowledge!.updatedAt ? ` (as of ${whenText(t.knowledge!.updatedAt, now)})` : ''}`, who: t.name, body: t.knowledge!.body! })),
      ].filter((s) => s.body.trim());
      const got = await answerFromWork(drafterDepsFor(engines.runner), text, sources);
      if (!got) return null;
      return { text: got.text, who: got.used[0].who, hits: got.used.flatMap((s) => (s.hit ? [s.hit] : [])), from: got.used.map((s) => s.label) };
    },
    askTeam: (caller, taskId, text) => {
      const res = org.teamRoom(caller, taskId, { kind: 'ask', text });
      return res.ok ? { ok: true, ...(res.queued ? { queued: true } : {}) } : res;
    },
    // Only to see when it has answered: the ask itself went through teamRoom's checks.
    teamRoom: (taskId) => engines.teams?.()?.list().tasks.find((t) => t.id === taskId)?.room,
    ...(owner
      ? {
          mayAsk: (slackUserId: string) => {
            const id = owner();
            if (!id) return "This is someone's own overcli, and it isn't taking requests from Slack. Its owner can turn that on under Settings → Your org → Slack.";
            return id === slackUserId ? true : "This is someone's own overcli, so it only takes requests from them. Ask your org's workers instead.";
          },
        }
      : {}),
    caller: async (slackUserId) => {
      let name = names.get(slackUserId);
      const token = bot();
      if (!name && token) {
        const res = await slackRead<{ user?: { real_name?: string; profile?: { display_name?: string; real_name?: string } } }>('users.info', token, { user: slackUserId });
        name = res.ok ? res.data.user?.profile?.display_name || res.data.user?.profile?.real_name || res.data.user?.real_name : undefined;
        if (name) {
          names.set(slackUserId, name);
          org.learnName(slackUserId, name);
        }
      }
      const display = name ?? `<@${slackUserId}>`;
      // On the desktop its owner is the only one through, and every worker
      // there is theirs, managed or not.
      const isOwner = !!owner && owner() === slackUserId;
      return { slackUserId, name: display, admin: isOwner || isAdmin(loadOrgPolicy().policy, { slackUserId, name: display, admin: false }) };
    },
    workers: (caller) => {
      const roster = new Map(engines.workerEngine.roster().map((w) => [w.id, w]));
      return org
        .listWorkers(caller)
        .filter((w) => w.enabled)
        .map((w): FrontDoorWorker => ({
          id: w.id,
          name: w.name,
          ...(w.tagline ? { tagline: w.tagline } : {}),
          ...(roster.get(w.id)?.jobDescription ? { job: roster.get(w.id)!.jobDescription } : {}),
          ...(w.manager ? { manager: w.manager } : {}),
          ...(w.tools.length ? { tools: w.tools.filter((t) => t.ok).map((t) => t.name) } : {}),
          ...(w.place && w.place.kind !== 'folder' ? { code: w.place.kind === 'workspace' ? `${w.place.name} (${(w.place.repos ?? []).join(', ')})` : w.place.name } : {}),
          avatarUrl: roster.get(w.id)?.avatarUrl ?? initialsPicture(w.id, w.name),
        }));
    },
    teams: (caller) =>
      org
        .teams(caller)
        .filter((t) => t.canBrief)
        .map((t) => ({ id: t.id, name: t.name, ...(t.purpose ? { purpose: t.purpose } : {}), members: t.members.map((m) => m.name) })),
    following: (caller) => {
      const res = org.watching(caller, { limit: 0 });
      return res.ok ? res.mine.map((r) => ({ item: r.item, ...(r.status ? { status: r.status } : {}), worker: r.worker })) : [];
    },
    follow: async (caller, itemId, on, opts) => {
      const res = await org.followOrSetUp(caller, itemId, on, opts);
      return res.ok ? { worker: res.worker, trigger: res.trigger, everyMinutes: res.everyMinutes, ...(res.status ? { status: res.status } : {}), ...(res.setUp ? { setUp: true } : {}) } : res.error;
    },
    track: (caller, workerId, itemId, on) => {
      const res = org.trackItem(caller, workerId, itemId, on);
      return res.ok ? { worker: res.worker, tracked: res.tracked } : res.error;
    },
    briefTeam: (caller, teamId, brief) => {
      const res = org.briefTeam(caller, teamId, brief);
      return res.ok ? { ok: true, queued: res.task.status === 'queued' } : res;
    },
    ask: (caller, workerId, text, attachments, conversation, said) => {
      const started = org.startAsk(caller, workerId, text, 'slack', attachments, undefined, conversation, said);
      return started.ok ? { ok: true, done: started.done } : started;
    },
    handBack: (askId) => org.handBack(askId),
    continueRun: (caller, orchestrationId, text, attachments, conversation, said) => {
      const went = org.continueRun(caller, orchestrationId, text, { via: 'slack', attachments, conversation, said });
      return went ? { ok: true, done: went.done } : null;
    },
    progress: (id) => org.errandProgress(id),
    route: (text, workers, related) => routeRequest(drafterDepsFor(engines.runner), text, workers, related),
    general: (_caller, text, context, workers) => answerGeneral(drafterDepsFor(engines.runner), text, context, workers),
    slack: {
      post: async (channel, text, threadTs, as) => {
        const token = bot();
        if (!token) return false;
        let res = await postMessage(token, { channel, text, threadTs, ...(as ? { username: as.name, ...(as.iconUrl ? { iconUrl: as.iconUrl } : {}) } : {}) });
        // An app installed before it could post under another name: as
        // itself, the worker's name written in front instead.
        if (!res.ok && as && res.error === 'missing_scope') res = await postMessage(token, { channel, text: `*${as.name}:* ${text}`, threadTs });
        if (!res.ok) log('warn', 'slack', `The front door could not post to ${channel}: ${res.error}`);
        return res.ok;
      },
      thread: async (channel, threadTs) => {
        const token = bot();
        if (!token) return [];
        const res = await fetchThread(token, channel, threadTs);
        return res.ok ? res.data : [];
      },
      recent: async (channel, beforeTs, limit) => {
        const token = bot();
        if (!token) return [];
        const res = await fetchRecent(token, channel, beforeTs, limit);
        return res.ok ? res.data : [];
      },
      download: async (url, maxBytes) => {
        const token = bot();
        if (!token) return null;
        const res = await downloadFile(token, url, maxBytes);
        return res.ok ? res.data : null;
      },
      postBlocks: async (channel, text, blocks, threadTs) => {
        const token = bot();
        if (!token) return false;
        const res = await postMessage(token, { channel, text, blocks, threadTs });
        return res.ok;
      },
      update: async (channel, ts, text) => {
        const token = bot();
        if (!token) return false;
        const res = await updateMessage(token, { channel, ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
        return res.ok;
      },
      postTs: async (channel, text, threadTs, as) => {
        const token = bot();
        if (!token) return null;
        const who = as ? { username: as.name, ...(as.iconUrl ? { iconUrl: as.iconUrl } : {}) } : {};
        let res = await postMessage(token, { channel, text, threadTs, ...who });
        if (!res.ok && as && res.error === 'missing_scope') res = await postMessage(token, { channel, text, threadTs });
        return res.ok ? res.data.ts : null;
      },
      upload: async (channel, threadTs, filename, bytes) => {
        const token = bot();
        if (!token) return false;
        const res = await uploadFile(token, { channel, threadTs, filename, bytes });
        if (!res.ok) log('warn', 'slack', `The front door could not attach ${filename}: ${res.error}`);
        return res.ok;
      },
      dm: async (user, text) => {
        const token = bot();
        if (!token) return false;
        const im = await openIm(token, user);
        if (!im.ok) return false;
        const res = await postMessage(token, { channel: im.data, text });
        if (!res.ok) log('warn', 'slack', `The front door could not DM ${user}: ${res.error}`);
        return res.ok;
      },
      permalink: async (channel, ts) => {
        const token = bot();
        if (!token) return null;
        const res = await permalink(token, channel, ts);
        return res.ok ? res.data : null;
      },
    },
    libraryUrl: () => loadOrgPolicy().policy.publicUrl ?? null,
    readFile: (file, maxBytes) => {
      try {
        return fs.statSync(file).size <= maxBytes ? fs.readFileSync(file) : null;
      } catch {
        return null;
      }
    },
    // Only inside the worker's own files, with links resolved first: a reply
    // naming `/etc/passwd`, or a link it planted pointing out, sends nothing.
    workerFile: (workerId, file, maxBytes) => {
      try {
        const root = fs.realpathSync(workerFilesDir(workerId));
        const real = fs.realpathSync(file);
        if (!real.startsWith(root + path.sep)) return null;
        const st = fs.statSync(real);
        return st.isFile() && st.size <= maxBytes ? fs.readFileSync(real) : null;
      } catch {
        return null;
      }
    },
    store: jsonOrgStore<FrontDoorState>('front-door.json', () => ({ threads: [], follows: [] })),
    log: (message) => log('info', 'slack', message),
  });
  slack.setFrontDoor(frontDoor);
  frontDoor.start();
  return { org, commands, access, sso, triggers, frontDoor, connections, processes };
}
