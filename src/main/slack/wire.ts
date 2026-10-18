// Build the Slack bridge over the engines — shared by the app (index.ts) and
// `overcli serve` (cli/engines.ts), so the two hosts cannot drift on how an
// answer reaches a run or how a rejection settles its batch item.

import { log } from '../diagnostics';
import { collectKnownSecretValues, redactSecrets } from '../secretScrub';
import type { FlowRuntimeImpl } from '../flows/runtime';
import type { OrchestratorImpl } from '../flows/orchestrator';
import type { WorkerEngine } from '../flows/workerEngine';
import { SlackBridge, type SlackBridgeStatus } from './slackBridge';
import { configuredSlackToken } from './slackSettings';
import { fileThreadStore } from './threadStore';
import { createOrgService, rejectWorkerRun, type OrgEngines } from '../org/wire';
import type { OrgService } from '../org/orgService';
import { createToken, fileAccessStore, fileAuditStore, listTokens, loadOrgPolicy, revokeToken, revokeTokensFor, updateOrgFile } from '../org/orgStores';
import { AccessService } from '../org/accessService';
import { SlackCommands } from './slackCommands';
import { SsoService, SSO_CLIENT_SECRET_ENV } from '../org/sso';
import { fetchMessage, lookupByEmail, postMessage } from './slackApi';
import { TriggerService, triggerFiles } from '../org/triggers';
import { callTool } from '../org/mcpDirect';
import { readClaudeMcpServers } from '../mcpConfig';
import { orgDir } from '../org/orgStores';

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
    store: fileThreadStore,
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
): { org: OrgService; commands: SlackCommands; access: AccessService; sso: SsoService; triggers: TriggerService } {
  let commands: SlackCommands | null = null;
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
    },
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
    },
  });
  const org = createOrgService({
    ...engines,
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
    onAskDone: (ask) => commands?.askAnswered(ask),
  });
  commands = new SlackCommands({
    org,
    access,
    policy: () => loadOrgPolicy().policy,
    botToken: () => configuredSlackToken('bot'),
    teamId: () => slack.teamId(),
    log: (level, message) => log(level, 'slack', message),
  });
  slack.setCommands(commands);
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
  // Workers acting on business events: watches, webhooks, Slack channels.
  triggers = new TriggerService({
    ...triggerFiles(orgDir()),
    worker: (id) => {
      const w = engines.workerEngine.roster().find((x) => x.id === id);
      return w ? { id: w.id, name: w.name, enabled: w.enabled } : null;
    },
    ask: (workerId, triggerName, text) => {
      const started = org.startAsk({ name: triggerName, admin: true }, workerId, text, 'trigger');
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
    },
    log: (message) => log('info', 'org', message),
  });
  slack.setEventTap((ev) => triggers?.slackEvent(ev));
  return { org, commands, access, sso, triggers };
}
