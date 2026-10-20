/// Labs: the parts of Overcli that are wonderful once you know what you want
/// from it, and noise before then. Each is a whole surface, not a tweak, so a
/// newcomer's first screens stay about conversations and folders.
///
/// Stored so that nobody who already uses Overcli loses anything: a settings
/// file written before Labs existed has no `labs` key, and a missing key means
/// ON. A brand-new install starts with the rest off (see `NEWCOMER_LABS`,
/// applied by the main store when there is no settings file at all). Workers
/// stays on even there: the tab is the feature people come for, and nothing
/// runs or spends until someone hires a worker, so showing it costs nothing.
///
/// Usage is deliberately not a lab: "what is this costing me?" is a
/// newcomer's question as much as anyone's, so that tab is always there.

export type LabKey = 'orchestrator' | 'workers' | 'compare' | 'localModels' | 'processes';
export type Labs = Partial<Record<LabKey, boolean>>;

/// `help` is the Settings description; `pitch` is the few words the start
/// page's one-time Labs card shows beside the name.
export const LABS: ReadonlyArray<{ key: LabKey; label: string; pitch: string; help: string }> = [
  {
    key: 'workers',
    label: 'Workers',
    pitch: 'agents that work on a schedule',
    help: 'Agents with a job description that run on a schedule, work through a queue and keep to a budget.',
  },
  {
    key: 'orchestrator',
    label: 'Orchestrator',
    pitch: 'one agent directing others',
    help: 'One agent that breaks a big piece of work into parts and directs other agents through them.',
  },
  {
    key: 'compare',
    label: 'Compare models',
    pitch: 'one task, several models, keep the best',
    help: 'Send the same task to several CLIs at once, each on its own branch, and keep the best answer. Shown on a project as "+ colosseum".',
  },
  {
    key: 'processes',
    label: 'Processes',
    pitch: 'work moving through teams, stage by stage',
    help: 'One piece of work moving through several teams, workers and your decisions, in order. Shown on the Workers rail.',
  },
  {
    key: 'localModels',
    label: 'Local models',
    pitch: 'models running on this machine',
    help: 'A tab for the models running on this machine through Ollama.',
  },
];

export const NEWCOMER_LABS: Labs = {
  orchestrator: false,
  workers: true,
  compare: false,
  localModels: false,
  processes: false,
};

/// Labs added after Labs existed, which nobody was using yet: absent means
/// OFF for these, so an older settings file doesn't switch them on.
const OFF_UNTIL_ASKED: ReadonlySet<LabKey> = new Set<LabKey>(['processes']);

export function labOn(labs: Labs | undefined, key: LabKey): boolean {
  return labs?.[key] ?? !OFF_UNTIL_ASKED.has(key);
}
