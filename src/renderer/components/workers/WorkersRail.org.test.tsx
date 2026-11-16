// @vitest-environment jsdom
//
// The Org rail: one server's workers, yours first, then those shared with
// you under a heading that folds, and starts folded when there are many.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgServerStatus } from '@shared/types';
import { OrgRailServer } from './WorkersRail';
import type { OrgWorker } from './org/orgTabStore';

let host: HTMLDivElement;
let root: Root;

const server = { id: 'primary', url: 'https://overgo.acme.example', name: 'Acme', isDefault: true, tokenConfigured: true, fromEnv: false } as OrgServerStatus;
const worker = (id: string, over: Partial<OrgWorker> = {}): OrgWorker => ({
  id, name: id, tagline: '', enabled: true, trust: 'trusted', visibility: 'org', budgetUSDPerMonth: 20, spentThisMonthUSD: 0,
  month: { runs: 0, failed: 0, pullRequests: 0 }, last30: { jobs: 0, failed: 0, prior: 0 }, waiting: 0, youManage: true, yours: true, state: 'idle', schedule: 'When asked', ...over,
});
const shared = (n: number, over: Partial<OrgWorker> = {}) => Array.from({ length: n }, (_, i) => worker(`Shared${i}`, { youManage: false, yours: false, ...over }));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { overcli: { invoke: () => Promise<null> } }).overcli = { invoke: vi.fn(async () => null) };
  try {
    localStorage.clear();
  } catch {
    /* none */
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (list: OrgWorker[], expanded = true) =>
  act(() => root.render(<OrgRailServer server={server} list={list} many={false} expanded={expanded} selected={null} select={() => {}} />));
const fold = () => host.querySelector('button[aria-expanded]') as HTMLButtonElement | null;

describe('OrgRailServer', () => {
  it('lists yours under its own heading, and folds many shared workers, saying how many wait', () => {
    render([worker('Mario'), ...shared(9), worker('Busy', { youManage: false, yours: false, waiting: 2 })]);
    expect(host.textContent).toContain('Yours');
    expect(host.textContent).toContain('Mario');
    expect(fold()!.getAttribute('aria-expanded')).toBe('false');
    expect(fold()!.textContent).toContain('Shared with you');
    expect(fold()!.textContent).toContain('2 waiting · 10');
    expect(host.textContent).not.toContain('Shared0');
    act(() => fold()!.click());
    expect(host.textContent).toContain('Shared0');
  });

  it('keeps a few shared workers open, and names them everyone else’s for an admin', () => {
    render([worker('Mario'), ...shared(2, { youManage: true })]);
    expect(fold()!.getAttribute('aria-expanded')).toBe('true');
    expect(fold()!.textContent).toContain('Everyone else’s');
  });

  it('shows no "Yours" heading when nothing is shared, and everything open when nothing is yours', () => {
    render([worker('Mario')]);
    expect(host.textContent).not.toContain('Yours');
    render(shared(12));
    expect(fold()!.getAttribute('aria-expanded')).toBe('true');
  });

  it('falls back to youManage on a server that does not say yours', () => {
    render([worker('Old', { yours: undefined }), ...shared(1)]);
    expect(host.textContent).toContain('Yours');
  });

  it('shows every worker in the narrow rail, with a line between yours and shared', () => {
    render([worker('Mario'), ...shared(9)], false);
    expect(fold()).toBeNull();
    expect(host.querySelectorAll('button')).toHaveLength(10);
    expect(host.querySelector('[title="Shared with you"]')).toBeTruthy();
  });
});
