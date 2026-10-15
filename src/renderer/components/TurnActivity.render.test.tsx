// @vitest-environment jsdom
//
// The Summary chip names the files a turn changed, and each name opens that
// file's diff. While the turn runs it also shows the call in flight.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolUseBlock } from '@shared/types';

const openFile = vi.fn();
vi.mock('../openFile', () => ({ useOpenFile: () => openFile }));
vi.mock('./ToolUseCard', () => ({ ToolUseCard: ({ use }: { use: ToolUseBlock }) => <div>card:{use.name}</div> }));

import { TurnActivity } from './TurnActivity';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  openFile.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const use = (id: string, name: string, input: Record<string, unknown>): ToolUseBlock => ({
  id,
  name,
  inputJSON: JSON.stringify(input),
});

describe('TurnActivity chip', () => {
  it('names changed files and opens their diff', () => {
    act(() =>
      root.render(
        <TurnActivity
          conversationId="c1"
          toolResultIndex={new Map()}
          uses={[use('1', 'Read', { file_path: '/r/a.ts' }), use('2', 'Edit', { file_path: '/r/src/runner.ts', old_string: 'a', new_string: 'b' })]}
        />,
      ),
    );
    expect(host.textContent).toContain('Read 1 file');
    expect(host.textContent).toContain('changed');
    expect(host.textContent).toContain('+1');
    expect(host.textContent).toContain('−1');
    const file = [...host.querySelectorAll('button')].find((b) => b.textContent === 'runner.ts')!;
    act(() => file.click());
    expect(openFile).toHaveBeenCalledWith('/r/src/runner.ts', undefined, 'diff');
  });

  it('folds files past the fourth into a count', () => {
    const edits = ['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) => use(String(i), 'Edit', { file_path: `/r/${n}.ts` }));
    act(() => root.render(<TurnActivity conversationId="c1" toolResultIndex={new Map()} uses={edits} />));
    expect(host.textContent).toContain('+2 more');
    expect(host.textContent).not.toContain('e.ts');
  });

  it('leads with the call in flight and shows the elapsed time while the message is worked on', () => {
    act(() =>
      root.render(
        <TurnActivity
          conversationId="c1"
          toolResultIndex={new Map()}
          uses={[use('1', 'Read', { file_path: '/r/a.ts' })]}
          live="Running npm test…"
          startedAt={Date.now() - 42_000}
        />,
      ),
    );
    const text = host.textContent ?? '';
    expect(text.indexOf('Running npm test…')).toBeLessThan(text.indexOf('read 1 file'));
    expect(text).toMatch(/4[23]s/);
  });

  it('shows no clock once the message is done', () => {
    act(() =>
      root.render(<TurnActivity conversationId="c1" toolResultIndex={new Map()} uses={[use('1', 'Read', { file_path: '/r/a.ts' })]} />),
    );
    expect(host.textContent).not.toMatch(/\d+s$/);
  });

  it('expands to the calls the transcript hides, not the edits it already shows', () => {
    act(() =>
      root.render(
        <TurnActivity
          conversationId="c1"
          toolResultIndex={new Map()}
          uses={[use('1', 'Bash', { command: 'ls' }), use('2', 'Edit', { file_path: '/r/a.ts' })]}
        />,
      ),
    );
    const toggle = host.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(toggle.textContent).toBe('Show 1 step');
    act(() => toggle.click());
    expect(toggle.textContent).toBe('Hide steps');
    expect(host.textContent).toContain('card:Bash');
    expect(host.textContent).not.toContain('card:Edit');
  });

  it('follows the open state it is given, so steps stay open as events stream in', () => {
    const onToggle = vi.fn();
    const uses = [use('1', 'Bash', { command: 'ls' })];
    act(() =>
      root.render(<TurnActivity conversationId="c1" toolResultIndex={new Map()} uses={uses} live="Running ls…" open onToggle={onToggle} />),
    );
    expect(host.textContent).toContain('card:Bash');
    // A new call arrives: same open state, steps still shown.
    act(() =>
      root.render(
        <TurnActivity
          conversationId="c1"
          toolResultIndex={new Map()}
          uses={[...uses, use('2', 'Read', { file_path: '/r/a.ts' })]}
          live="Reading a.ts…"
          open
          onToggle={onToggle}
        />,
      ),
    );
    expect(host.textContent).toContain('card:Bash');
    expect(host.textContent).toContain('card:Read');
    act(() => (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
