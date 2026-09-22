// The outbound banner is the sentence a user reads before letting something
// leave the machine, so it has to name the right effect — a delete shown as a
// publish is the one mistake that cannot be taken back — and it has to survive
// whatever `action` the model puts on the wire, because the Allow and Deny
// buttons render beside it.

import { describe, expect, it } from 'vitest';
import { outboundSummary } from './PermissionCard';

const artifact = (input: Record<string, unknown>) => outboundSummary('Artifact', JSON.stringify(input));

describe('outboundSummary for the Artifact tool', () => {
  it('names a delete as a delete rather than as a publish', () => {
    expect(artifact({ action: 'delete', url: 'https://claude.ai/artifact/abc' })?.headline).toContain('deletes');
    expect(artifact({ action: 'delete', url: 'https://claude.ai/artifact/abc' })?.headline).not.toContain('Publishes');
  });

  it('still reads as a publish when no action is given', () => {
    expect(artifact({ file_path: 'page.html' })?.headline).toContain('Publishes');
  });

  it('shows the artifact a destructive action names', () => {
    expect(artifact({ action: 'delete', url: 'https://claude.ai/artifact/abc' })?.rows).toContainEqual({
      label: 'Artifact',
      value: 'https://claude.ai/artifact/abc',
    });
  });

  it('describes an action it does not know rather than going blank', () => {
    expect(artifact({ action: 'teleport' })?.headline).toBe(
      'Runs the Artifact tool\'s "teleport" action against claude.ai.',
    );
  });

  it('keeps the headline a string for a name borrowed from the prototype chain', () => {
    // A bare `headlines[action]` hands React a function for `toString` and an
    // object for `__proto__`; the latter throws and takes the card's buttons
    // with it, so a model can blank the approval it was about to be refused.
    for (const action of ['__proto__', 'toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      const summary = artifact({ action });
      expect(typeof summary?.headline).toBe('string');
      expect(summary?.headline).toContain(action);
    }
  });
});
