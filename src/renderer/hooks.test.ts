import { describe, it, expect } from 'vitest';
import { pickLiveSlashNames } from './hooks';
import { SystemInitInfo } from '@shared/types';

function init(model: string, slashCommands: string[]): SystemInitInfo {
  return { sessionId: 's', model, cwd: '/repo', apiKeySource: 'login', tools: [], slashCommands, mcpServers: [] };
}

describe('pickLiveSlashNames', () => {
  it('prefers the conversation’s own init over the global one', () => {
    const out = pickLiveSlashNames(['design'], init('claude-opus-5', ['help']), 'claude');
    expect(out).toEqual(['design']);
  });

  // The case that made bundled commands invisible: a conversation with no
  // turn yet has no init of its own, so the menu fell back to nothing.
  it('inherits the global init when the conversation has none', () => {
    const out = pickLiveSlashNames([], init('claude-opus-5', ['design', 'design-sync']), 'claude');
    expect(out).toEqual(['design', 'design-sync']);
  });

  it('refuses a global init from a different backend', () => {
    expect(pickLiveSlashNames([], init('gpt-5.6-terra', ['design']), 'claude')).toEqual([]);
    expect(pickLiveSlashNames([], init('claude-opus-5', ['design']), 'codex')).toEqual([]);
  });

  it('inherits regardless of backend when the caller names none', () => {
    expect(pickLiveSlashNames([], init('gpt-5.6-terra', ['review']), undefined)).toEqual(['review']);
  });

  it('is empty when there is no init at all', () => {
    expect(pickLiveSlashNames([], undefined, 'claude')).toEqual([]);
  });
});
