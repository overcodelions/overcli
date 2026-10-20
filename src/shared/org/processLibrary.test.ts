import { describe, expect, it } from 'vitest';
import { validateProcess } from './process';
import { PROCESS_LIBRARY, libraryProcess, stagesFromLibrary, suggestTeamFor } from './processLibrary';

describe('the process library', () => {
  it('has distinct processes that each make a valid process once teams and deciders are picked', () => {
    expect(new Set(PROCESS_LIBRARY.map((p) => p.id)).size).toBe(PROCESS_LIBRARY.length);
    for (const p of PROCESS_LIBRARY) {
      expect(p.about.length, p.id).toBeGreaterThan(80);
      const stages = stagesFromLibrary(p, () => 'team-1').map((s) => (s.kind === 'people' ? { ...s, approvers: [{ name: 'Pat' }] } : s));
      expect(validateProcess({ name: p.name, owner: { name: 'Pat' }, stages }, new Set(['team-1'])), p.id).toBeNull();
      for (const s of p.stages) {
        expect(s.why, `${p.id}/${s.key}`).toBeTruthy();
        if (s.kind === 'team') expect(s.crew?.length, `${p.id}/${s.key}`).toBeGreaterThan(0);
      }
    }
  });

  it('suggests the team whose name, purpose or roles fit a stage, and none when nothing does', () => {
    const prfaq = libraryProcess('idea-to-launch')!.stages[0];
    const teams = [
      { id: 't-web', name: 'Web app builders', purpose: 'Ship features to the web app', members: [{ role: 'Developer' }] },
      { id: 't-council', name: 'Product council', purpose: 'Writes PR/FAQs and roadmap reports', members: [{ role: 'Market analyst' }, { role: 'Challenger' }] },
    ];
    expect(suggestTeamFor(prfaq, teams)?.team.id).toBe('t-council');
    expect(suggestTeamFor(libraryProcess('idea-to-launch')!.stages[3], teams)?.team.id).toBe('t-web');
    expect(suggestTeamFor(libraryProcess('security-vulnerability')!.stages[0], [{ id: 't-x', name: 'Bakery', purpose: 'Bread' }])).toBeNull();
    expect(suggestTeamFor(libraryProcess('idea-to-launch')!.stages[2], teams)).toBeNull();
    // Sharing generic role words ("analyst", "developer") is not a fit.
    const growth = [{ id: 't-g', name: 'Search Growth Desk', purpose: 'Grows search traffic', members: [{ role: 'SEO analyst' }, { role: 'Developer' }, { role: 'Challenger' }] }];
    expect(suggestTeamFor(libraryProcess('incident-postmortem')!.stages[1], growth)).toBeNull();
  });
});
