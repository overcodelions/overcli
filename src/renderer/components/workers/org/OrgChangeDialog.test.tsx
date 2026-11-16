// @vitest-environment jsdom
//
// A chat's change on an org server, put to the person in the app's window:
// said in words, laid out field by field, refused by default.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeTitle, OrgChangeDialog } from './OrgChangeDialog';

const invoke = vi.fn();
let emit: (e: unknown) => void = () => {};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { overcli: unknown }).overcli = { invoke, onMainEvent: (fn: (e: unknown) => void) => ((emit = fn), () => {}) };
  invoke.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('changeTitle', () => {
  it('says what the call does', () => {
    expect(changeTitle('update_worker', { worker: 'Oscar', jobDescription: 'x' })).toBe('Change Oscar’s job');
    expect(changeTitle('update_worker', { worker: 'Oscar', jobDescription: 'x', tagline: 'y' })).toBe('Change Oscar’s settings');
    expect(changeTitle('add_worker_note', { worker: 'Pip', note: 'x' })).toBe('Add a note for Pip');
    expect(changeTitle('retire_worker', { worker: 'Remy' })).toBe('Let Remy go, for good');
    expect(changeTitle('some_new_tool', {})).toBe('Some new tool');
  });
});

describe('OrgChangeDialog', () => {
  it('lays the change out, focuses Don’t allow, and answers once', async () => {
    act(() => root.render(<OrgChangeDialog />));
    act(() => emit({ type: 'orgChangeRequest', id: 'q1', chat: 'Improve Oscar', org: 'Acme', name: 'update_worker', args: { worker: 'Oscar', jobDescription: 'Each weekday morning, rank the top 30 tickets.\n\nScope: RED and WOW.', budgetUSDPerMonth: 80 } }));
    const text = host.textContent ?? '';
    expect(text).toContain('Change Oscar’s settings?');
    expect(text).toContain('“Improve Oscar”');
    expect(text).toContain('Its job');
    expect(text).toContain('Monthly budget');
    expect(text).toContain('$80');
    expect(document.activeElement?.textContent).toBe('Don’t allow');
    await act(async () => ([...host.querySelectorAll('button')].find((b) => b.textContent === 'Allow') as HTMLButtonElement).click());
    expect(invoke).toHaveBeenCalledWith('org:answerChange', { id: 'q1', allow: true });
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('refuses on Escape, and closes one that timed out', async () => {
    act(() => root.render(<OrgChangeDialog />));
    act(() => emit({ type: 'orgChangeRequest', id: 'q2', org: 'Acme', name: 'retire_worker', args: { worker: 'Remy' } }));
    act(() => host.querySelector('[role="presentation"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(invoke).toHaveBeenCalledWith('org:answerChange', { id: 'q2', allow: false });
    act(() => emit({ type: 'orgChangeRequest', id: 'q3', org: 'Acme', name: 'run_worker_now', args: { worker: 'Pip' } }));
    expect(host.textContent).toContain('Start a run of Pip now?');
    act(() => emit({ type: 'orgChangeRequest', id: 'q3', done: true }));
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
