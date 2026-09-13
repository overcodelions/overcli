// The daemons a project's services lean on but no checkout owns — mariadb,
// memcached, redis — installed through brew, systemd or Windows services.
//
// They sit under the project services rather than among them: switching a
// branch means nothing to a database, and a row that offered to would lie.
// What they need is the three verbs you would otherwise type into a terminal,
// and for a cache, the fourth one — clearing it — that is otherwise a telnet
// session nobody remembers the syntax for.

import { useCallback, useEffect, useState } from 'react';

import type { MachineServiceView } from '@shared/types';

const MANAGER_LABEL: Record<MachineServiceView['manager'], string> = {
  brew: 'brew',
  systemd: 'systemd',
  'systemd-user': 'systemd --user',
  windows: 'service',
};

/// Often enough that a daemon started from a terminal shows up without a
/// click; rarely enough that `brew services list` is not running constantly.
const POLL_MS = 15_000;

export function MachineServicesSection({ filter }: { filter: string }) {
  const [services, setServices] = useState<MachineServiceView[] | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setServices(await window.overcli.invoke('machine:list'));
    } catch {
      setServices([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  const needle = filter.trim().toLowerCase();
  const shown = (services ?? []).filter((s) => !needle || s.name.toLowerCase().includes(needle));
  if (shown.length === 0) return null;
  const running = shown.filter((s) => s.status === 'running').length;

  return (
    <div className="mt-2">
      <div className="flex h-[30px] items-center gap-2 pl-3.5 pr-2">
        <span className="truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
          This machine
        </span>
        <span className={'font-mono text-[10px] ' + (running > 0 ? 'text-green-600 dark:text-green-400' : 'text-ink-faint')}>
          {running}/{shown.length}
        </span>
        <span className="flex-1" />
        <button
          className="rounded px-1.5 text-[10.5px] text-ink-faint hover:bg-card-strong hover:text-ink"
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? 'show' : 'hide'}
        </button>
      </div>
      {!collapsed && shown.map((service) => <MachineRow key={service.id} service={service} onChanged={refresh} />)}
    </div>
  );
}

function MachineRow({ service, onChanged }: { service: MachineServiceView; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const live = service.status === 'running';

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    if (!confirmClear) return;
    const timer = window.setTimeout(() => setConfirmClear(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [confirmClear]);

  async function control(action: 'start' | 'stop' | 'restart') {
    setBusy(action);
    setMessage(null);
    try {
      const outcome = await window.overcli.invoke('machine:control', {
        name: service.name,
        manager: service.manager,
        action,
      });
      if (!outcome.ok) setMessage({ text: outcome.reason, bad: true });
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function clear() {
    if (!service.cache || service.port === undefined) return;
    // Two clicks. Flushing a cache is instant and there is no undo, and the
    // button sits right next to Restart.
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    setBusy('clear');
    try {
      const outcome = await window.overcli.invoke('machine:clearCache', { kind: service.cache, port: service.port });
      setMessage(outcome.ok ? { text: 'Cleared', bad: false } : { text: outcome.reason, bad: true });
    } finally {
      setBusy(null);
    }
  }

  const dot =
    service.status === 'running'
      ? 'bg-green-500 dark:bg-green-400'
      : service.status === 'error'
        ? 'bg-red-500 dark:bg-red-400'
        : 'bg-ink-faint/40';

  return (
    <div className="group pl-3.5 pr-2">
      <div className="flex h-[28px] items-center gap-2">
        <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
          <span className={`h-[7px] w-[7px] rounded-full ${dot}`} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px]" title={service.user ? `runs as ${service.user}` : undefined}>
          {service.name}
        </span>
        <span
          className="flex-shrink-0 text-[10px] text-ink-faint"
          title={service.needsAdmin ? 'Starting and stopping this needs administrator rights' : undefined}
        >
          {MANAGER_LABEL[service.manager]}
          {service.needsAdmin ? ' · admin' : ''}
        </span>
        {service.port !== undefined && (
          <span className="flex-shrink-0 font-mono text-[10.5px] text-ink-muted">:{service.port}</span>
        )}
        <span className="flex flex-shrink-0 items-center gap-0.5">
          {live && service.cache && service.port !== undefined && (
            <RowButton
              onClick={() => void clear()}
              disabled={busy !== null}
              tone={confirmClear ? 'danger' : undefined}
              title={`Flush every key in ${service.name}`}
            >
              {busy === 'clear' ? 'Clearing…' : confirmClear ? 'Clear all?' : 'Clear'}
            </RowButton>
          )}
          {live ? (
            <>
              <RowButton onClick={() => void control('restart')} disabled={busy !== null} title={`Restart ${service.name}`}>
                {busy === 'restart' ? 'Restarting…' : 'Restart'}
              </RowButton>
              <RowButton onClick={() => void control('stop')} disabled={busy !== null} title={`Stop ${service.name}`}>
                {busy === 'stop' ? 'Stopping…' : 'Stop'}
              </RowButton>
            </>
          ) : (
            <RowButton onClick={() => void control('start')} disabled={busy !== null} title={`Start ${service.name}`}>
              {busy === 'start' ? 'Starting…' : 'Start'}
            </RowButton>
          )}
        </span>
      </div>
      {message && (
        <div
          className={
            'truncate pb-1 pl-[22px] text-[10.5px] ' +
            (message.bad ? 'text-amber-700 dark:text-amber-300' : 'text-green-600 dark:text-green-400')
          }
          title={message.text}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}

function RowButton({
  children,
  onClick,
  disabled,
  title,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title: string;
  tone?: 'danger';
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={
        'h-[20px] rounded px-1.5 text-[10.5px] disabled:opacity-50 ' +
        (tone === 'danger'
          ? 'bg-red-500/15 text-red-700 dark:text-red-300'
          : 'text-ink-muted hover:bg-card-strong hover:text-ink')
      }
    >
      {children}
    </button>
  );
}
