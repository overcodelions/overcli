// @vitest-environment jsdom
//
// Ask the crew sends a clear match straight away and brings the answer back;
// an unsure match waits for you; nobody-fits offers to hire.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkersStore } from '../../workersStore';
import { AskCrew } from './AskCrew';

const invoke = vi.fn();
const runErrand = vi.fn(async (id: string) => {
  useWorkersStore.setState((s) => ({
    errandResult: {
      ...s.errandResult,
      [id]: { orchestrationId: 'o1', count: 0, queued: 0, launchedNothing: true, reply: 'The London hotel is still open.' },
    },
  }));
  return true;
});
let host: HTMLDivElement;
let root: Root;

const worker = (id: string, name: string, order: number) =>
  ({ id, name, enabled: true, trust: 'probation', rosterOrder: order, caps: {}, flowIds: ['f'], jobDescription: 'x' }) as never;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { overcli: { invoke: typeof invoke } }).overcli = { invoke };
  invoke.mockReset();
  runErrand.mockClear();
  useWorkersStore.setState({
    workers: { a: worker('a', 'Soraya', 0), b: worker('b', 'Triage', 1) },
    runErrand,
    errandResult: {},
    errandError: {},
  } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<AskCrew />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function ask(text: string) {
  const input = host.querySelector('input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('AskCrew', () => {
  it('sends a clear match straight away and shows the answer', async () => {
    invoke.mockResolvedValueOnce({ ok: true, workerId: 'a', why: 'travel', confident: true });
    await ask('Is the London hotel booked?');
    expect(runErrand).toHaveBeenCalledWith('a', 'Is the London hotel booked?');
    expect(host.textContent).toContain('The London hotel is still open.');
  });

  it('waits for you on an unsure match', async () => {
    invoke.mockResolvedValueOnce({ ok: true, workerId: 'b', why: 'maybe a ticket', confident: false });
    await ask('Look into the portal');
    expect(runErrand).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Triage');
    expect(host.textContent).toContain('maybe a ticket');
    expect(host.textContent).toContain('Send');
  });

  it('sends @Name straight to that worker without routing', async () => {
    await ask('@Triage check WOW-1');
    expect(invoke).not.toHaveBeenCalled();
    expect(runErrand).toHaveBeenCalledWith('b', 'check WOW-1');
  });

  it('offers to hire when nobody fits', async () => {
    invoke.mockResolvedValueOnce({ ok: true, workerId: null, why: 'no one does taxes', confident: false });
    await ask('Do my taxes');
    expect(host.textContent).toContain('Hire someone for this');
  });
});
