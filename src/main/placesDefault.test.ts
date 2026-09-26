import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/types';
import { applyPlacesDefault } from './store';

describe('applyPlacesDefault', () => {
  it('moves an install still on Recent to Places, once', () => {
    const out = applyPlacesDefault({ ...DEFAULT_SETTINGS, sidebarLayout: 'stream' });
    expect(out.sidebarLayout).toBe('projects');
    expect(out.placesDefaultApplied).toBe(true);
  });

  it('keeps Recent when it was chosen after the move', () => {
    const out = applyPlacesDefault({ ...DEFAULT_SETTINGS, sidebarLayout: 'stream', placesDefaultApplied: true });
    expect(out.sidebarLayout).toBe('stream');
  });

  it('leaves Places alone and marks it done', () => {
    const out = applyPlacesDefault({ ...DEFAULT_SETTINGS, sidebarLayout: 'projects' });
    expect(out).toMatchObject({ sidebarLayout: 'projects', placesDefaultApplied: true });
  });

  it('defaults new installs to Places', () => {
    expect(DEFAULT_SETTINGS.sidebarLayout).toBe('projects');
  });
});
