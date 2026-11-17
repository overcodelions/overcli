// Process stages and people as a form, a published process or an org file
// sends them: every field checked and capped, anything unknown dropped.

import type { ProcessField, ProcessPerson, ProcessStage } from '../../shared/org/process';

export function personInput(raw: unknown): ProcessPerson | undefined {
  const p = raw as { name?: unknown; slackUserId?: unknown } | null;
  const name = typeof p?.name === 'string' ? p.name.trim().slice(0, 120) : '';
  if (!name) return undefined;
  const id = typeof p?.slackUserId === 'string' && /^[UW][A-Z0-9]{6,}$/.test(p.slackUserId) ? p.slackUserId : undefined;
  return { name, ...(id ? { slackUserId: id } : {}) };
}

/// What a people stage asks for, as a form sends it.
export function fieldsInput(raw: unknown): ProcessField[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 12).map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    const kind = r.kind === 'longText' || r.kind === 'choice' ? r.kind : 'text';
    const options = kind === 'choice' && Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === 'string' && !!o.trim()).slice(0, 20).map((o) => o.trim().slice(0, 80)) : [];
    return {
      id: typeof r.id === 'string' ? r.id.trim().slice(0, 40) : '',
      label: typeof r.label === 'string' ? r.label.trim().slice(0, 120) : '',
      kind,
      ...(options.length ? { options } : {}),
      ...(r.required === true ? { required: true } : {}),
    };
  });
}

export function stagesInput(raw: unknown): ProcessStage[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const kind = r.kind === 'people' ? 'people' : r.kind === 'worker' ? 'worker' : 'team';
    const owner = personInput(r.owner);
    const approvers = Array.isArray(r.approvers) ? r.approvers.map(personInput).filter((p): p is ProcessPerson => !!p).slice(0, 20) : [];
    const groups = Array.isArray(r.approverGroups)
      ? (r.approverGroups as Array<{ id?: unknown; name?: unknown }>)
          .filter((g) => typeof g?.id === 'string' && typeof g.name === 'string')
          .slice(0, 10)
          .map((g) => ({ id: (g.id as string).slice(0, 120), name: (g.name as string).slice(0, 120) }))
      : [];
    const fields = fieldsInput(r.fields);
    return {
      id: str(r.id, 40),
      name: str(r.name, 80),
      kind,
      ...(kind === 'team' && str(r.teamId, 80) ? { teamId: str(r.teamId, 80) } : {}),
      ...(kind === 'worker' && str(r.workerId, 80) ? { workerId: str(r.workerId, 80) } : {}),
      ...(owner ? { owner } : {}),
      ...(kind === 'people' ? { approvers, ...(groups.length ? { approverGroups: groups } : {}) } : {}),
      ...(kind === 'people' && r.mode === 'input' ? { mode: 'input' } : {}),
      ...(kind === 'people' && fields.length ? { fields } : {}),
      ...(kind === 'people' && (r.needs === 'all' || (typeof r.needs === 'number' && Number.isInteger(r.needs) && r.needs > 1)) ? { needs: r.needs } : {}),
      ...(str(r.ask, 2000) ? { ask: str(r.ask, 2000) } : {}),
      ...(str(r.sendBackTo, 40) ? { sendBackTo: str(r.sendBackTo, 40) } : {}),
      ...(str(r.why, 600) ? { why: str(r.why, 600) } : {}),
      ...(kind !== 'people' && typeof r.delayDays === 'number' && r.delayDays > 0 ? { delayDays: Math.round(r.delayDays) } : {}),
      ...(kind !== 'people' && r.repeat && typeof r.repeat === 'object' && Number((r.repeat as { times?: unknown }).times) > 1
        ? { repeat: { everyDays: Math.round(Number((r.repeat as { everyDays?: unknown }).everyDays)), times: Math.round(Number((r.repeat as { times?: unknown }).times)) } }
        : {}),
    } as ProcessStage;
  });
}
