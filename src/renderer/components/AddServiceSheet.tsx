// Adding a service by hand.
//
// Scanning and importing cover the cases where a file already describes what
// runs. This is the rest of the world: a docker container, a script, a thing
// with no build file at all, or anything overcli guessed wrong about. It is
// deliberately the same shape as what a scan produces — everything after the
// start command behaves identically either way, which is the promise the empty
// state has been making.

import { useMemo, useState } from 'react';

import type { ReadinessProbe, ServiceSpec } from '@shared/services';
import { describeShellNeed, parseCommandLine } from '../commandLine';
import { parseOptionText } from './optionText';
import { useServicesStore } from '../servicesStore';

type ReadyKind = 'none' | 'tcp' | 'http' | 'log';

export interface AddTarget {
  /// The stack this lands in — a workspace id, or a lone project's id.
  stackId: string;
  /// Projects it could run in. One means no picker.
  projects: { id: string; name: string; path: string }[];
}

export function AddServiceSheet({ target, onClose }: { target: AddTarget; onClose: () => void }) {
  const load = useServicesStore((s) => s.load);
  const select = useServicesStore((s) => s.select);

  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState(target.projects[0]?.id ?? '');
  const [subpath, setSubpath] = useState('');
  const [command, setCommand] = useState('');
  const [group, setGroup] = useState('');
  const [port, setPort] = useState('');
  const [readyKind, setReadyKind] = useState<ReadyKind>('none');
  const [readyPath, setReadyPath] = useState('/health');
  const [readyPattern, setReadyPattern] = useState('');
  const [options, setOptions] = useState('');
  const [selfReloads, setSelfReloads] = useState(false);
  const [busy, setBusy] = useState(false);

  const project = target.projects.find((p) => p.id === projectId);
  const parsed = useMemo(() => parseCommandLine(command), [command]);
  const portNumber = port.trim() === '' ? undefined : Number.parseInt(port, 10);
  const portValid = portNumber === undefined || (portNumber > 0 && portNumber < 65_536);
  const canSave =
    name.trim() !== '' && parsed.argv.length > 0 && !parsed.needsShell && !!project && portValid;

  async function save() {
    if (!project) return;
    setBusy(true);
    try {
      const id = `${project.id}-${slug(name)}`;
      const spec: ServiceSpec = {
        id,
        name: name.trim(),
        projectId: project.id,
        subpath: subpath.trim() || undefined,
        runner: 'command',
        command: parsed.argv,
        port: portNumber,
        ready: buildProbe(readyKind, portNumber, readyPath, readyPattern),
        selfReloads,
        group: group.trim() || undefined,
        options: parseOptionText(options),
        config: {},
      };
      await window.overcli.invoke('services:add', {
        workspaceId: target.stackId,
        spec,
        binding: { ref: 'HEAD', path: project.path },
      });
      await load(target.stackId);
      await select(target.stackId, id);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="flex max-h-[86vh] w-[560px] flex-col overflow-hidden rounded-lg border border-card-strong bg-surface-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-card px-4 py-3">
          <div className="text-sm font-semibold">Add a service</div>
          <div className="mt-0.5 text-[11px] text-ink-muted">
            Anything that starts from a command — a container, a script, a server overcli did not
            recognise.
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3.5">
          <Field label="Name">
            <input
              className="field w-full px-2 py-1.5 text-xs"
              placeholder="mysql"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <Field label="Command">
            <input
              className="field w-full px-2 py-1.5 font-mono text-[11px]"
              placeholder="docker compose up db"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
            {parsed.needsShell ? (
              <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
                {describeShellNeed(parsed.needsShell)}
              </p>
            ) : parsed.argv.length > 0 ? (
              <p className="mt-1 font-mono text-[10px] text-ink-faint">
                runs {parsed.argv.map((a) => JSON.stringify(a)).join(' ')}
              </p>
            ) : (
              <p className="mt-1 text-[10px] text-ink-faint">
                Run directly, not through a shell — so no pipes or redirects.
              </p>
            )}
          </Field>

          <div className="flex gap-3">
            <Field label="In this project" className="flex-1">
              {target.projects.length > 1 ? (
                <select
                  className="field w-full px-2 py-1.5 text-xs"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  {target.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="truncate px-2 py-1.5 font-mono text-[11px] text-ink-muted">
                  {project?.name ?? '—'}
                </div>
              )}
            </Field>
            <Field label="Subfolder" className="w-[180px]">
              <input
                className="field w-full px-2 py-1.5 font-mono text-[11px]"
                placeholder="optional"
                value={subpath}
                onChange={(e) => setSubpath(e.target.value)}
              />
            </Field>
          </div>

          <div className="flex gap-3">
            <Field label="Group" className="flex-1">
              <input
                className="field w-full px-2 py-1.5 text-xs"
                placeholder="Infrastructure"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
              />
            </Field>
            <Field label="Port" className="w-[120px]">
              <input
                className="field w-full px-2 py-1.5 font-mono text-[11px]"
                placeholder="3306"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
              {!portValid && (
                <p className="mt-1 text-[10px] text-red-700 dark:text-red-300">Not a port.</p>
              )}
            </Field>
          </div>

          <Field label="Ready when">
            <div className="flex flex-wrap items-center gap-1.5">
              <Choice on={readyKind === 'none'} onClick={() => setReadyKind('none')}>
                it starts
              </Choice>
              <Choice
                on={readyKind === 'tcp'}
                onClick={() => setReadyKind('tcp')}
                disabled={portNumber === undefined}
              >
                its port opens
              </Choice>
              <Choice
                on={readyKind === 'http'}
                onClick={() => setReadyKind('http')}
                disabled={portNumber === undefined}
              >
                a URL answers
              </Choice>
              <Choice on={readyKind === 'log'} onClick={() => setReadyKind('log')}>
                it prints something
              </Choice>
            </div>
            {readyKind === 'http' && (
              <input
                className="field mt-1.5 w-full px-2 py-1.5 font-mono text-[11px]"
                value={readyPath}
                onChange={(e) => setReadyPath(e.target.value)}
              />
            )}
            {readyKind === 'log' && (
              <input
                className="field mt-1.5 w-full px-2 py-1.5 font-mono text-[11px]"
                placeholder="ready in"
                value={readyPattern}
                onChange={(e) => setReadyPattern(e.target.value)}
              />
            )}
            {portNumber === undefined && (
              <p className="mt-1 text-[10px] text-ink-faint">
                Set a port to wait on one. Without a check, it counts as running the moment it
                starts.
              </p>
            )}
          </Field>

          <Field label="Startup options">
            <textarea
              className="field h-[70px] w-full px-2 py-1.5 font-mono text-[11px]"
              placeholder="--profile local"
              value={options}
              onChange={(e) => setOptions(e.target.value)}
            />
          </Field>

          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-ink-muted">
            <input
              type="checkbox"
              checked={selfReloads}
              onChange={(e) => setSelfReloads(e.target.checked)}
            />
            It reloads itself when files change
            <span className="text-ink-faint">— overcli will leave it alone</span>
          </label>
        </div>

        <div className="flex items-center gap-2 border-t border-card px-4 py-3">
          <span className="flex-1 text-[10.5px] text-ink-faint">
            Everything after the command works the same as a service overcli found itself.
          </span>
          <button className="review-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="review-btn-primary" disabled={!canSave || busy} onClick={() => void save()}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

function buildProbe(
  kind: ReadyKind,
  port: number | undefined,
  path: string,
  pattern: string,
): ReadinessProbe {
  if (kind === 'tcp' && port !== undefined) return { kind: 'tcp', port };
  if (kind === 'http' && port !== undefined) return { kind: 'http', path: path || '/', port };
  if (kind === 'log' && pattern.trim()) return { kind: 'log', pattern: pattern.trim() };
  return { kind: 'none' };
}

function slug(text: string): string {
  return (
    text
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'service'
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={'flex flex-col gap-1 ' + (className ?? '')}>
      <span className="text-[11px] text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

function Choice({
  on,
  onClick,
  disabled,
  children,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={on ? 'svc-btn-primary' : 'svc-btn'}
      style={disabled ? { opacity: 0.4 } : undefined}
    >
      {children}
    </button>
  );
}
