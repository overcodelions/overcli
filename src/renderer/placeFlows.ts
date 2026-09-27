// Which starred flows a place's "New in …" menu offers.
//
// Only starred ones: the library is mostly flows you ran once, and a three-
// item menu that grew every flow would stop being a menu. Only ones that can
// run there: a project flow lives in one repo's folder and means nothing in
// another, and a documents folder skips the code flows for the same reason
// its welcome screen does.

import { flowStarKey, type Flow } from '@shared/flows/schema';

export const PLACE_FLOW_LIMIT = 3;

/// Tags a library flow can carry to be offered on a documents folder.
/// Mirrors the welcome screen's EverydayFlowPill.
const EVERYDAY_FLOW_TAGS = new Set(['documents', 'everyday']);

export function starredFlowsForPlace(
  flows: readonly Flow[],
  starred: readonly string[],
  place: { folders: readonly string[]; everyday: boolean },
  limit = PLACE_FLOW_LIMIT,
): Flow[] {
  const stars = new Set(starred);
  const folders = place.folders.filter(Boolean).map((f) => (f.endsWith('/') ? f : `${f}/`));
  const inPlace = (f: Flow) => folders.some((dir) => f.filePath.startsWith(dir));
  return flows
    .filter((f) => stars.has(flowStarKey(f)) && !f.archived && f.source !== 'generated')
    .filter((f) => {
      if (f.source === 'project') return inPlace(f);
      if (!place.everyday) return true;
      return (f.tags ?? []).some((t) => EVERYDAY_FLOW_TAGS.has(t.toLowerCase()));
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}
