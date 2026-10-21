// What goes to the org's server when someone publishes from their own
// install, the app and `overcli … push` alike.

import type { Team } from '../../shared/flows/team';
import type { Worker } from '../../shared/flows/worker';
import { loadAllFlows } from '../flows/storage';
import { buildWorkerShare } from '../flows/workerShare';
import { readMcpServer } from '../mcpConfig';
import { Store } from '../store';
import type { TeamPublishPayload } from './orgClient';
import { templateFrom, type ToolTemplate } from './tools';

/// A worker as it goes to the org: its share file, and its tools' setup
/// without a single secret, so the server's admin can install them
/// pre-filled.
export function shareForOrg(worker: Worker): { yaml: string; tools: ToolTemplate[]; missingFlowIds: string[] } {
  const share = buildWorkerShare({ worker, library: loadAllFlows({ projectPaths: Store.load().projects.map((p) => p.path) }) });
  const tools = (worker.mcpServers ?? []).flatMap((name) => {
    const config = readMcpServer('claude', name);
    const t = config ? templateFrom(name, config) : null;
    return t ? [t] : [];
  });
  return { yaml: share.yaml, tools, missingFlowIds: share.missingFlowIds };
}

/// A team as it goes to the org, each member's share file inside.
export function teamForOrg(team: Team, workers: readonly Worker[]): { ok: true; payload: TeamPublishPayload } | { ok: false; error: string } {
  const byId = new Map(workers.map((w) => [w.id, w]));
  const members: TeamPublishPayload['members'] = [];
  for (const m of team.members) {
    const worker = byId.get(m.workerId);
    if (!worker) return { ok: false, error: 'A member of this team is no longer on your crew.' };
    const { yaml, tools } = shareForOrg(worker);
    members.push({ localId: worker.id, role: m.role, yaml, tools });
  }
  return {
    ok: true,
    payload: {
      localId: team.id,
      name: team.name,
      ...(team.purpose ? { purpose: team.purpose } : {}),
      budgetUSDPerTask: team.budgetUSDPerTask,
      checkpoints: { ...team.checkpoints },
      ...(team.piecesAskFirst === false ? { piecesAskFirst: false } : {}),
      members,
    },
  };
}
