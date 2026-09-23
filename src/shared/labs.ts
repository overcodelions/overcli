/// Labs: the parts of Overcli that are wonderful once you know what you want
/// from it, and noise before then. Each is a whole surface, not a tweak, so a
/// newcomer's first screens stay about conversations and folders.
///
/// Stored so that nobody who already uses Overcli loses anything: a settings
/// file written before Labs existed has no `labs` key, and a missing key means
/// ON. Only a brand-new install starts with them off (see `NEWCOMER_LABS`,
/// applied by the main store when there is no settings file at all).
///
/// Usage is deliberately not a lab: "what is this costing me?" is a
/// newcomer's question as much as anyone's, so that tab is always there.

export type LabKey = 'orchestrator' | 'workers' | 'compare' | 'localModels';
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
    key: 'localModels',
    label: 'Local models',
    pitch: 'models running on this machine',
    help: 'A tab for the models running on this machine through Ollama.',
  },
];

export const NEWCOMER_LABS: Labs = {
  orchestrator: false,
  workers: false,
  compare: false,
  localModels: false,
};

export function labOn(labs: Labs | undefined, key: LabKey): boolean {
  return labs?.[key] ?? true;
}
