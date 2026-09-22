// A service's output, beside whatever you were doing.
//
// The Services pane is the place to configure a service; this is the place to
// watch one. Opened from the changes bar while nine services come up on a
// branch, switching detailMode instead would take the conversation away and
// close the popover the user is working through — so the log comes to them.
// "Open in Services ›" is still there for when the full pane is what's wanted.

import { useState } from 'react';
import { useStore } from '../store';
import { isServiceLive, logKey, useServicesStore } from '../servicesStore';
import { LogView } from './ServiceLogView';

export function ServiceLogDrawer() {
  const target = useServicesStore((s) => s.logDrawer);
  const close = useServicesStore((s) => s.closeLogDrawer);
  const stack = useServicesStore((s) => (target ? s.stacks[target.workspaceId] : undefined));
  const key = target ? logKey(target.workspaceId, target.serviceId) : '';
  const lines = useServicesStore((s) => s.logs[key]);
  const caught = useServicesStore((s) => s.exceptions[key]);
  const [restarting, setRestarting] = useState(false);

  if (!target) return null;
  const spec = stack?.services.find((s) => s.id === target.serviceId);
  const runtime = stack?.runtimes.find((r) => r.serviceId === target.serviceId);
  const binding = stack?.bindings.find((b) => b.serviceId === target.serviceId);
  const status = runtime?.status ?? 'stopped';
  const live = runtime ? isServiceLive(runtime.status) : false;

  return (
    <div data-service-log-drawer className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-card px-3 py-2">
        <span
          aria-hidden
          className={
            'h-2 w-2 flex-shrink-0 rounded-full ' +
            (status === 'failed'
              ? 'bg-red-500'
              : status === 'ready'
                ? 'bg-emerald-500'
                : live
                  ? 'animate-pulse bg-amber-500'
                  : 'bg-ink-faint')
          }
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-ink">
            {spec?.name ?? target.serviceId}
          </div>
          <div className="truncate font-mono text-[10.5px] text-ink-faint">
            {status}
            {binding?.ref ? ` · ⎇ ${binding.ref}` : ''}
          </div>
        </div>
        <button
          className="svc-btn"
          disabled={restarting}
          title={live ? 'Restart this service' : 'Start this service'}
          onClick={() => {
            setRestarting(true);
            const store = useServicesStore.getState();
            const done = () => setRestarting(false);
            void (live
              ? store.restart(target.workspaceId, target.serviceId)
              : store.start(target.workspaceId, target.serviceId)
            )
              .then(done, done);
          }}
        >
          {restarting ? 'Restarting…' : live ? '↻ Restart' : '▶ Start'}
        </button>
        <button
          className="svc-btn"
          title="Open this service in the Services pane"
          onClick={() => {
            void useServicesStore.getState().select(target.workspaceId, target.serviceId);
            useStore.getState().setDetailMode('services');
            close();
          }}
        >
          Open in Services ›
        </button>
        <button className="px-1 text-[13px] text-ink-muted hover:text-ink" title="Close" onClick={close}>
          ✕
        </button>
      </div>
      {/* Keyed per service: the search and level toggles belong to the log
          being read, not to the drawer. */}
      <LogView
        key={key}
        lines={lines ?? []}
        exceptions={caught}
        onClear={() => void useServicesStore.getState().clearLog(target.workspaceId, target.serviceId)}
        file={{
          reveal: () => void useServicesStore.getState().revealLogFile(target.workspaceId, target.serviceId),
          path: () => useServicesStore.getState().logFile(target.workspaceId, target.serviceId),
        }}
      />
    </div>
  );
}
