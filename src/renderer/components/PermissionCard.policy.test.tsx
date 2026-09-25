// @vitest-environment jsdom
//
// A request the app answered by itself (an unattended worker's policy) must
// read as answered. The card used to keep offering Allow for a call main had
// already refused, and clicking it marked the card "allowed" while the model
// was told no.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../store', () => ({
  useStore: (select: (s: { respondPermission: () => void }) => unknown) =>
    select({ respondPermission: () => {} }),
}));

import { PermissionCard } from './PermissionCard';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('PermissionCard answered by policy', () => {
  it('shows the decision and why, with no buttons', () => {
    act(() =>
      root.render(
        <PermissionCard
          conversationId="c1"
          info={{
            requestId: 'r1',
            toolName: 'mcp__claude_ai_Gmail__search_threads',
            description: '',
            toolInput: '',
            decided: 'deny',
            decidedBy: 'policy',
            decisionNote: 'Denied automatically: this worker has no grant for external actions.',
          }}
        />,
      ),
    );
    expect(host.textContent).toContain('✗ auto-denied');
    expect(host.textContent).toContain('no grant for external actions');
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('still offers the buttons for a request nobody has answered', () => {
    act(() =>
      root.render(
        <PermissionCard
          conversationId="c1"
          info={{ requestId: 'r1', toolName: 'Bash', description: '', toolInput: '' }}
        />,
      ),
    );
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toContain('Allow');
  });
});
