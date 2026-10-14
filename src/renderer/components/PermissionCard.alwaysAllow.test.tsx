// @vitest-environment jsdom
//
// "Always allow" used to remember the tool name, so allowing `npm test` once
// allowed `git push` forever. The card now offers the rule main computed —
// a command prefix — and no remember button at all for a risky command.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const respondPermission = vi.fn();
vi.mock('../store', () => ({
  useStore: (select: (s: { respondPermission: typeof respondPermission }) => unknown) =>
    select({ respondPermission }),
}));

import { PermissionCard } from './PermissionCard';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  respondPermission.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function buttons(): string[] {
  return [...host.querySelectorAll('button')].map((b) => b.textContent ?? '');
}

describe('PermissionCard always-allow scope', () => {
  it('offers and sends the scoped rule', () => {
    act(() =>
      root.render(
        <PermissionCard
          conversationId="c1"
          info={{
            requestId: 'r1',
            toolName: 'Bash',
            description: '',
            toolInput: JSON.stringify({ command: 'npm test' }),
            alwaysAllowRule: 'Bash(npm test:*)',
          }}
        />,
      ),
    );
    expect(buttons()).toContain('Always allow npm test');
    expect(host.textContent).toContain('Runs');
    const always = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Always allow npm test')!;
    act(() => always.click());
    expect(respondPermission).toHaveBeenCalledWith('c1', 'r1', true, undefined, 'always', 'Bash(npm test:*)');
  });

  it('offers Allow only, with the reason, for a risky command', () => {
    act(() =>
      root.render(
        <PermissionCard
          conversationId="c1"
          info={{
            requestId: 'r2',
            toolName: 'Bash',
            description: '',
            toolInput: JSON.stringify({ command: 'git push origin main' }),
            alwaysAllowRule: null,
            riskNote: 'This is hard to undo.',
          }}
        />,
      ),
    );
    expect(buttons().some((b) => b.startsWith('Always allow'))).toBe(false);
    expect(buttons()).toContain('Allow');
    expect(host.textContent).toContain('This is hard to undo.');
  });

  it('falls back to the tool name for requests without a rule', () => {
    act(() =>
      root.render(
        <PermissionCard
          conversationId="c1"
          info={{ requestId: 'r3', toolName: 'Edit', description: '', toolInput: '{}' }}
        />,
      ),
    );
    expect(buttons()).toContain('Always allow Edit');
  });
});
