// @vitest-environment jsdom
//
// The machine values sheet is where a credential decides whether it lands in
// the keychain or in a plain-text file (and in every unmasked log line). These
// render the real sheet against the real services store, with only the IPC
// bridge stubbed, and read it the way a user would: by the lock button's
// tooltip, the banner's text, and what Save actually sends to the engine.

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineEntry, MachineValuesView } from '@shared/services';
import { useServicesStore } from '../servicesStore';
import { MachineValuesSheet } from './ServicesPane';

const LOCKED = 'Secret — click to store as plain text';
const UNLOCKED = 'Plain text — click to encrypt with the Keychain';

let invoke: ReturnType<typeof vi.fn>;
let reloadView: MachineValuesView;

function setMachine(state: {
  machine?: MachineEntry[];
  secureStorage?: boolean;
  migrationError?: string;
  backupPaths?: string[];
}) {
  useServicesStore.setState({
    machine: [],
    secureStorage: true,
    migrationError: undefined,
    backupPaths: undefined,
    ...state,
  });
}

function renderSheet() {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<MachineValuesSheet onClose={onClose} />);
  return { user, onClose };
}

/// Each row is one NAME input plus its value field and buttons; scope queries
/// to the row that holds a given name.
function rowFor(name: string): HTMLElement {
  const input = screen.getAllByPlaceholderText('NAME').find((el) => (el as HTMLInputElement).value === name);
  if (!input) throw new Error(`no row named ${name}`);
  return input.parentElement!;
}

function savedEntries(): MachineEntry[] {
  const call = invoke.mock.calls.find(([channel]) => channel === 'services:saveMachineValues');
  if (!call) throw new Error('Save did not reach the engine');
  return call[1] as MachineEntry[];
}

beforeEach(() => {
  reloadView = { entries: [], secureStorage: true };
  invoke = vi.fn(async (channel: string) => (channel === 'services:machineValues' ? reloadView : undefined));
  (window as unknown as { overcli: { invoke: typeof invoke } }).overcli = { invoke };
  setMachine({});
});

afterEach(() => {
  cleanup();
});

describe('MachineValuesSheet — secret defaults for a new name', () => {
  it.each(['STRIPE_KEY', 'JWT_SIGNING_KEY'])('locks %s as a secret', async (name) => {
    const { user } = renderSheet();
    await user.type(screen.getByPlaceholderText('NAME'), name);

    expect(within(rowFor(name)).getByTitle(LOCKED)).toBeTruthy();
    expect(within(rowFor(name)).queryByTitle(UNLOCKED)).toBeNull();

    await user.type(within(rowFor(name)).getByPlaceholderText('value'), 'sk_test_acme');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(savedEntries()).toEqual([{ name, secret: true, value: 'sk_test_acme' }]);
  });

  it.each(['SORT_KEY', 'PUBLIC_KEY'])('leaves %s plain', async (name) => {
    const { user } = renderSheet();
    await user.type(screen.getByPlaceholderText('NAME'), name);

    expect(within(rowFor(name)).getByTitle(UNLOCKED)).toBeTruthy();
    expect(within(rowFor(name)).queryByTitle(LOCKED)).toBeNull();

    await user.type(within(rowFor(name)).getByPlaceholderText('value'), 'acme-sort');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(savedEntries()).toEqual([{ name, secret: false, value: 'acme-sort' }]);
  });

  it('does not offer a lock at all when the machine has no keychain', async () => {
    setMachine({ secureStorage: false });
    const { user } = renderSheet();
    await user.type(screen.getByPlaceholderText('NAME'), 'STRIPE_KEY');

    const toggle = within(rowFor('STRIPE_KEY')).getByTitle(
      'No keychain on this machine — secrets cannot be stored safely',
    );
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('MachineValuesSheet — cleartext backup banner', () => {
  it('offers to delete a single retained backup, and calls the engine when clicked', async () => {
    setMachine({ backupPaths: ['/Users/acme/.overcli/machine.json.bak'] });
    const { user } = renderSheet();

    expect(screen.getByText('Cleartext backup retained:')).toBeTruthy();
    expect(screen.getByText('/Users/acme/.overcli/machine.json.bak')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete backups' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Delete backup' }));
    expect(invoke).toHaveBeenCalledWith('services:deleteMachineBackup');
  });

  it('pluralises for several backups', async () => {
    setMachine({
      backupPaths: ['/Users/acme/.overcli/machine.json.bak.1', '/Users/acme/.overcli/machine.json.bak.2'],
    });
    const { user } = renderSheet();

    expect(screen.getByText('2 cleartext backups retained:')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete backup' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Delete backups' }));
    expect(invoke).toHaveBeenCalledWith('services:deleteMachineBackup');
  });

  it('drops the banner once the reloaded view reports no backups', async () => {
    setMachine({ backupPaths: ['/Users/acme/.overcli/machine.json.bak'] });
    reloadView = { entries: [], secureStorage: true, backupPaths: [] };
    const { user } = renderSheet();

    await user.click(screen.getByRole('button', { name: 'Delete backup' }));
    expect(screen.queryByText(/cleartext backup/i)).toBeNull();
  });

  it.each([
    ['undefined', undefined],
    ['empty', []],
  ])('is absent when backupPaths is %s', (_label, backupPaths) => {
    setMachine({ backupPaths });
    renderSheet();

    expect(screen.queryByText(/cleartext backup/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete backup/ })).toBeNull();
  });
});

describe('MachineValuesSheet — keepPlain', () => {
  it('sends keepPlain when a new secret-looking value is unlocked before saving', async () => {
    const { user } = renderSheet();
    await user.type(screen.getByPlaceholderText('NAME'), 'STRIPE_KEY');
    await user.type(within(rowFor('STRIPE_KEY')).getByPlaceholderText('value'), 'sk_test_acme');
    await user.click(within(rowFor('STRIPE_KEY')).getByTitle(LOCKED));

    expect(within(rowFor('STRIPE_KEY')).getByTitle(UNLOCKED)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(savedEntries()).toEqual([
      { name: 'STRIPE_KEY', secret: false, keepPlain: true, value: 'sk_test_acme' },
    ]);
  });

  it('sends keepPlain for a stored secret made plain, without inventing a value', async () => {
    setMachine({ machine: [{ name: 'ACME_API_TOKEN', secret: true, stored: true }] });
    const { user } = renderSheet();
    await user.click(within(rowFor('ACME_API_TOKEN')).getByTitle(
      'Secret. To make it plain, replace the value — the stored one is never shown.',
    ));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(savedEntries()).toEqual([
      { name: 'ACME_API_TOKEN', secret: false, keepPlain: true, value: undefined },
    ]);
  });

  it('forgets keepPlain when the value is locked again before saving', async () => {
    const { user } = renderSheet();
    await user.type(screen.getByPlaceholderText('NAME'), 'STRIPE_KEY');
    await user.type(within(rowFor('STRIPE_KEY')).getByPlaceholderText('value'), 'sk_test_acme');
    await user.click(within(rowFor('STRIPE_KEY')).getByTitle(LOCKED));
    await user.click(within(rowFor('STRIPE_KEY')).getByTitle(UNLOCKED));

    expect(within(rowFor('STRIPE_KEY')).getByTitle(LOCKED)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const [entry] = savedEntries();
    expect(entry).toEqual({ name: 'STRIPE_KEY', secret: true, value: 'sk_test_acme' });
    expect('keepPlain' in entry).toBe(false);
  });

  it('keeps an earlier keepPlain choice on a re-save', async () => {
    setMachine({ machine: [{ name: 'STRIPE_KEY', secret: false, value: 'sk_test_acme', keepPlain: true }] });
    const { user } = renderSheet();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(savedEntries()).toEqual([
      { name: 'STRIPE_KEY', secret: false, keepPlain: true, value: 'sk_test_acme' },
    ]);
  });
});

describe('MachineValuesSheet — migration error', () => {
  it('shows the migration error when the view carries one', () => {
    setMachine({ migrationError: 'Could not move 2 secrets into the Keychain: acme keychain locked' });
    renderSheet();

    expect(screen.getByText('Could not move 2 secrets into the Keychain: acme keychain locked')).toBeTruthy();
  });

  it('shows nothing of the sort when there is none', () => {
    renderSheet();

    expect(screen.queryByText(/Keychain:/)).toBeNull();
  });
});
