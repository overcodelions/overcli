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
import { createToken, fileAccessStore, listTokens, loadOrgPolicy, revokeToken, revokeTokensFor, updateOrgFile } from '../org/orgStores';
import { AccessService } from '../org/accessService';
import { SlackCommands } from './slackCommands';

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
): { org: OrgService; commands: SlackCommands; access: AccessService } {
  let commands: SlackCommands | null = null;
  const access = new AccessService({
    policy: () => loadOrgPolicy().policy,
    store: fileAccessStore,
    tokens: {
      create: (args) => createToken(args),
      revokeFor: (id) => revokeTokensFor(id),
      revoke: (id) => revokeToken(id),
      list: () => listTokens(),
    },
    updateOrg: (mutate) => updateOrgFile(mutate),
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
      ];
    },
  }, {
    onHireAwaitingApproval: (hire, approvers) => commands?.notifyApprovers(hire, approvers),
    onHireDecided: (hire, outcome) => commands?.notifyDecided(hire, outcome),
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
  return { org, commands, access };
}
