// @vitest-environment jsdom
//
// The empty Today reader is the one screen a new crew sees before anything
// has happened, so both of its ways to make something happen must work: the
// job box hands the chosen worker an errand, and Work now starts its shift.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkersStore } from '../../workersStore';
import { TodayEmpty } from './TodayEmpty';

const runErrand = vi.fn(async () => true);
const workShiftNow = vi.fn(async () => {});
let host: HTMLDivElement;
let root: Root;

const worker = (id: string, name: string, order: number) =>
  ({ id, name, enabled: true, trust: 'probation', rosterOrder: order, caps: {}, flowIds: ['f'] }) as never;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  runErrand.mockClear();
  workShiftNow.mockClear();
  useWorkersStore.setState({
    workers: { a: worker('a', 'Mender', 0), b: worker('b', 'Soraya', 1) },
    runErrand,
    workShiftNow,
  } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const NOW = Date.now();
const upcoming = [{ workerId: 'a', workerName: 'Mender', at: NOW + 3_600_000, cadence: 'Weekdays at 01:00', imminent: false, overdue: false }] as never;

describe('TodayEmpty', () => {
  it('hands the chosen worker a job', async () => {
    act(() => root.render(<TodayEmpty upcoming={upcoming} now={NOW} />));
    const select = host.querySelector('select')!;
    act(() => {
      select.value = 'b';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const input = host.querySelector('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Check my trips');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(runErrand).toHaveBeenCalledWith('b', 'Check my trips');
    expect(host.textContent).toContain('while Soraya is on it');
  });

  it('lists the next shifts and starts one now', () => {
    act(() => root.render(<TodayEmpty upcoming={upcoming} now={NOW} />));
    expect(host.textContent).toContain('Weekdays at 01:00');
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Work now')!;
    act(() => button.click());
    expect(workShiftNow).toHaveBeenCalledWith('a');
    expect(button.textContent).toBe('Started');
  });

  it('says when nothing is scheduled', () => {
    act(() => root.render(<TodayEmpty upcoming={[]} now={NOW} />));
    expect(host.textContent).toContain('No shifts are scheduled');
  });
});
