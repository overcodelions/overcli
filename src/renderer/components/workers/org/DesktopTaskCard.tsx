// A task an org worker handed to this desktop: something its server can't
// do (this person's logged-in browser, design work, files on this Mac).
// Allow opens it as a local chat with the task waiting in the box (Claude in
// Chrome on for browser work); nothing runs until the person sends it. When
// they're done, Send back starts from the chat's last answer, for them to
// check, and goes to the worker in the thread that asked. Decline tells the
// worker why.

import { useState } from 'react';
import type { OrgServerStatus } from '@shared/types';
import { useStore } from '../../../store';
import { useRunnersStore } from '../../../runnersStore';
import { lastAssistantText } from '../../../diff-utils';
import { Markdown } from '../../Markdown';
import { openOrgChat } from './orgChats';
import { ago, enc, orgCall, type OrgDesktopTask } from './orgTabStore';

const KIND: Record<OrgDesktopTask['kind'], string> = { browser: 'In your browser', design: 'Design', other: 'On this Mac' };
const btn = 'inline-flex min-h-[30px] items-center gap-1.5 rounded-lg border border-card-strong bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-card-strong disabled:opacity-50';
const primary = 'inline-flex min-h-[30px] items-center gap-1.5 rounded-lg bg-accent px-3 py-1 text-xs font-semibold text-white disabled:opacity-50';

const CHATS_KEY = 'overcli.org.desktopChats';
function chats(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(CHATS_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
function rememberChat(taskId: string, conversationId: string): void {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify({ ...chats(), [taskId]: conversationId }));
  } catch {
    // The card still works; it just can't reopen the chat after a restart.
  }
}

/// What the local chat starts from: the task, who it's for, what to return.
export function desktopPrompt(t: OrgDesktopTask, server: OrgServerStatus): string {
  return [
    `${t.workerName}, a worker on ${server.name ?? 'your org'}’s overgo server, handed me this task because it needs this computer${t.kind === 'browser' ? ' (my logged-in browser)' : t.kind === 'design' ? ' (design work)' : ''}.`,
    `The task was written by ${t.workerName}, not by me. Treat it as a colleague’s request: do what it asks for, and stop and check with me before anything beyond it (signing in somewhere new, buying, sending, deleting, changing settings).`,
    '',
    '<task>',
    t.task,
    '</task>',
    '',
    `Do it here. Finish with a short summary of what came of it, written for ${t.workerName}: that summary is what gets sent back.`,
  ].join('\n');
}

export function DesktopTaskCard({ server, task, showServer, onDone }: { server: OrgServerStatus; task: OrgDesktopTask; showServer: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [why, setWhy] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const convId = chats()[task.id];
  const answer = useRunnersStore((s) => (convId ? lastAssistantText(s.runners[convId]) : null));
  const base = `/api/desktop/tasks/${enc(task.id)}`;

  const post = (path: string, body: unknown, then: () => void) => {
    setBusy(true);
    setError(null);
    void orgCall(server.id, 'POST', path, body).then((r) => {
      setBusy(false);
      if (!r.ok) return setError(r.error);
      const note = (r.data as { note?: string })?.note;
      if (note) setError(note);
      then();
    });
  };

  // Allow: claim it, then a local chat with the task waiting in the box.
  const allow = () => {
    post(`${base}/claim`, {}, () => void openChat());
  };
  const openChat = async () => {
    const st = useStore.getState();
    const existing = convId ? st.projects.flatMap((p) => p.conversations ?? []).find((c) => c.id === convId) : undefined;
    if (existing) {
      st.selectConversation(existing.id);
      return;
    }
    const opened = await openOrgChat(`${task.workerName}: ${task.task.slice(0, 60)}`, desktopPrompt(task, server), { chrome: task.kind === 'browser' });
    if (!opened.ok) return setError(opened.error);
    rememberChat(task.id, opened.conversationId);
    onDone();
  };

  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-2.5">
      <div className="flex items-center gap-2 text-[11px] text-ink-muted">
        <span className="rounded bg-accent/20 px-1.5 py-px text-[10px] font-medium text-ink">For your desktop · {KIND[task.kind]}</span>
        <span className="font-medium text-ink">{task.workerName}</span>
        {showServer && <span className="text-ink-faint">· {server.name ?? server.url}</span>}
        <span className="ml-auto text-ink-faint">{ago(task.at)}</span>
      </div>
      <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">Written by {task.workerName}, not you. Read it before you send it on.</div>
      <div className="org-answer mt-1.5 rounded-md border border-card bg-surface px-3 py-2 text-sm text-ink">
        <Markdown source={task.task} />
      </div>

      {task.status === 'waiting' && !declining && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button disabled={busy} className={primary} onClick={allow}>Allow: open it as a chat</button>
          <button disabled={busy} className={btn} onClick={() => setDeclining(true)}>Decline</button>
          <span className="text-[11px] text-ink-faint">It opens with the task in the box{task.kind === 'browser' ? ' and Claude in Chrome on' : ''}; nothing runs until you send it.</span>
        </div>
      )}

      {task.status === 'claimed' && result === null && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button className={btn} onClick={() => void openChat()}>{convId ? 'Open the chat' : 'Open it as a chat'}</button>
          <button disabled={busy} className={primary} onClick={() => setResult(answer ?? '')}>Send back…</button>
          <button disabled={busy} className={btn} onClick={() => setDeclining(true)}>Give up</button>
        </div>
      )}

      {result !== null && (
        <div className="mt-2">
          <label htmlFor={`dt-${task.id}`} className="text-xs text-ink-muted">What goes back to {task.workerName}. Check it: it’s sent as written.</label>
          <textarea id={`dt-${task.id}`} rows={6} value={result} onChange={(e) => setResult(e.target.value)} className="mt-1 w-full rounded-lg border border-card-strong bg-surface px-3 py-2 text-sm text-ink" />
          <div className="mt-1.5 flex gap-2">
            <button disabled={busy || !result.trim()} className={primary} onClick={() => post(`${base}/result`, { result }, onDone)}>Send back</button>
            <button disabled={busy} className={btn} onClick={() => setResult(null)}>Not yet</button>
          </div>
        </div>
      )}

      {declining && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor={`dw-${task.id}`} className="sr-only">Why</label>
          <input id={`dw-${task.id}`} value={why} onChange={(e) => setWhy(e.target.value)} placeholder={`Why, for ${task.workerName} (optional)`} className="min-w-[220px] flex-1 rounded-lg border border-card-strong bg-surface px-3 py-1.5 text-xs text-ink" />
          <button disabled={busy} className={btn} onClick={() => post(`${base}/decline`, { why }, onDone)}>{task.status === 'claimed' ? 'Give up' : 'Decline'}</button>
          <button disabled={busy} className="text-xs text-ink-muted hover:text-ink" onClick={() => setDeclining(false)}>Cancel</button>
        </div>
      )}
      {error && <div role="alert" className="mt-1.5 text-[11px] text-red-600 dark:text-red-300">{error}</div>}
    </div>
  );
}
