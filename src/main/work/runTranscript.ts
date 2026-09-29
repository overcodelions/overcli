// What a flow run actually did, read back from its transcripts.
//
// A run's JSON is evicted after a while, and its participant chats go with it
// — but the CLI's session files don't. Every step's agent wrote one under the
// cwd it worked in (a worktree or coordinator dir, unique to the run), so the
// Work view can still show a finished run step by step long after the run
// itself is gone.
//
// Claude transcripts only, like the prompt index.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claudeProjectSlug, parseClaudeHistoryLine } from '../history';
import type { RunTranscript, RunTranscriptStep } from '../../shared/workRecords';

const MESSAGE_CAP = 20_000;
const MESSAGES_PER_STEP = 200;

function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/// The Claude project dirs a run's agents wrote to: the slug of its cwd when
/// we know it, else any dir named for the run (coordinator dirs are).
function runDirs(runId: string, cwd?: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(projectsRoot());
  } catch {
    return [];
  }
  const want = new Set<string>();
  if (cwd) want.add(claudeProjectSlug(cwd).toLowerCase());
  return names
    .filter((n) => want.has(n.toLowerCase()) || n.toLowerCase().endsWith(runId.toLowerCase()))
    .map((n) => path.join(projectsRoot(), n));
}

/// `Overcli · <flow> · <step> (<participant>) — …` → "<step> (<participant>)".
export function stepLabelFromPrompt(text: string): string | null {
  const m = text.replace(/^\[Attached file:[^\]]*\]\s*/, '').match(/^Overcli · [^·\n]+ · ([^—\n]+?)\s+—/);
  return m ? m[1].trim() : null;
}

export async function loadRunTranscript(args: { runId: string; cwd?: string }): Promise<RunTranscript> {
  const files: Array<{ file: string; mtime: number }> = [];
  for (const dir of runDirs(args.runId, args.cwd)) {
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      try {
        files.push({ file, mtime: (await fs.promises.stat(file)).mtimeMs });
      } catch {
        // Vanished between listing and stat.
      }
    }
  }
  files.sort((a, b) => a.mtime - b.mtime);

  const steps: RunTranscriptStep[] = [];
  for (const { file } of files) {
    let text: string;
    try {
      text = await fs.promises.readFile(file, 'utf-8');
    } catch {
      continue;
    }
    // One agent keeps ONE session across every step it plays — a planner
    // that also reviews writes both steps into the same file, and anything
    // you typed after the last step lands there too. So a session is split
    // at each step banner; what comes before the first one stays together.
    const sessionId = path.basename(file, '.jsonl');
    let current: RunTranscriptStep | null = null;
    const flush = () => {
      if (current && current.messages.length) {
        current.truncated = current.messages.length > MESSAGES_PER_STEP;
        current.messages = current.messages.slice(-MESSAGES_PER_STEP);
        steps.push(current);
      }
    };
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      for (const ev of parseClaudeHistoryLine(line)) {
        const kind = ev.kind;
        if (kind.type === 'localUser') {
          const label = stepLabelFromPrompt(kind.text);
          if (label || !current) {
            flush();
            current = { sessionId, label: label ?? 'Session', messages: [], truncated: false };
          }
          current!.messages.push({ role: 'user', text: kind.text.slice(0, MESSAGE_CAP), at: ev.timestamp ?? 0 });
        } else if (kind.type === 'assistant' && !kind.info.isPartial && kind.info.text.trim()) {
          current ??= { sessionId, label: 'Session', messages: [], truncated: false };
          current.messages.push({ role: 'assistant', text: kind.info.text.slice(0, MESSAGE_CAP), at: ev.timestamp ?? 0 });
        }
      }
    }
    flush();
  }
  // In the order the steps ran. A file's mtime is when it was last written,
  // and a planner that answers a later question outlives the implementer.
  const startedAt = (s: RunTranscriptStep) => s.messages.find((m) => m.at)?.at ?? 0;
  steps.sort((a, b) => startedAt(a) - startedAt(b));
  return { steps };
}
