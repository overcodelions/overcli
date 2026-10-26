// Finished work, posted to Slack: what was done, the answer, and the files
// the work wrote. Shared by the front door (an ask made in a channel, answered
// in its thread) and the DM a manager gets when a scheduled shift finishes,
// so both deliver the same way.

import type { ErrandProgress } from '../org/orgService';
import { escapeMrkdwn } from './slackApi';

export const SLACK_TEXT_MAX = 2800;
/// Past this a reply is summarized in the thread and attached whole; up to
/// it, posted whole (Slack folds a long message behind "Show more").
export const SLACK_LONG_REPLY = 10_000;
const MAX_UPLOAD_BYTES = 10_000_000;
const MAX_UPLOADS = 5;
/// What Slack previews or people open: documents, pages, data and images.
const UPLOADABLE = /\.(md|markdown|txt|csv|json|html?|pdf|png|jpe?g|svg|docx|pptx|xlsx)$/i;

/// Who a message is posted as: a worker's own name and picture, rather than
/// the app's with the name written in front.
export interface PostAs {
  name: string;
  iconUrl?: string;
}

export interface DeliverIo {
  post(channel: string, text: string, threadTs: string, as?: PostAs): Promise<unknown>;
  upload(channel: string, threadTs: string, filename: string, bytes: Buffer): Promise<boolean>;
  readFile(path: string, maxBytes: number): Buffer | null;
  /// A file a worker's reply names, if it is inside that worker's own files
  /// (symlinks resolved): a reply is model text, and must not be able to send
  /// Slack whatever it names on the server. Absent: named files stay text.
  workerFile?(workerId: string, path: string, maxBytes: number): Buffer | null;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/// Markdown as the model writes it, in Slack's own markup: **bold** is
/// *bold* there, # headings have no equivalent, and links are <url|text>.
/// Code spans and fences pass through; Slack reads those the same.
export function toSlack(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part) =>
      part.startsWith('```')
        ? part
        : tables(part)
            .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
            .replace(/\*\*(.+?)\*\*/g, '*$1*')
            .replace(/__(.+?)__/g, '*$1*')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
            .replace(/^(\s*)[-*]\s+/gm, '$1• '),
    )
    .join('');
}

/// Slack has no tables: the header row in bold, each row after it a bullet
/// with its cells joined, and the |---| rule dropped. Empty and dash-only
/// cells are left out of a row.
function tables(text: string): string {
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const isRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
  const isRule = (line: string) => /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/.test(line);
  const lines = text.split('\n');
  return lines
    .map((line, i) => {
      if (!isRow(line)) return line;
      if (isRule(line)) return null;
      const kept = cells(line).filter((c) => c && !/^[-–—]+$/.test(c));
      return isRule(lines[i + 1] ?? '') ? `**${kept.join(' · ')}**` : `- ${kept.join(' — ')}`;
    })
    .filter((l): l is string => l !== null)
    .join('\n');
}

/// A worker's words for a Slack message: escaped (a stray `<` or `&` would
/// otherwise be read as Slack markup), then its Markdown in Slack's.
export function slackMarkup(text: string): string {
  return toSlack(escapeMrkdwn(text));
}

/// Files a reply names by absolute path, in the order named. Whether each
/// may be sent is the reader's call (`DeliverIo.workerFile`).
export function pathsInReply(text: string): string[] {
  const found = text.match(/\/(?:[\w.@%+~-]+\/)+[\w.@%+~-]+\.[A-Za-z0-9]{1,8}/g) ?? [];
  return [...new Set(found)].filter((p) => UPLOADABLE.test(p) && !p.split('/').includes('..'));
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'answer';
}

const prLinks = (p: ErrandProgress) => p.links.filter((l) => /\/pull\/\d+/.test(l));

/// The message that says it finished: each piece with a mark, pull requests,
/// branches to open one from, other links, and where the Library is.
export function finishedText(workerName: string, p: ErrandProgress, library: string | null): string {
  const mark = (s: string) => (s === 'done' ? '✓' : s === 'failed' ? '✗' : '–');
  const lines = p.items.map((i) => `${mark(i.status)} ${i.title}${i.status === 'failed' && i.note ? ` — ${clip(i.note, 200)}` : ''}`);
  const prs = prLinks(p);
  const toOpen = p.links.filter((l) => /\/compare\/|\/pull-requests\/new|\/pull-requests\?create/.test(l));
  const docs = p.links.filter((l) => !prs.includes(l) && !toOpen.includes(l));
  const ok = p.items.some((i) => i.status === 'done');
  return [
    `*${workerName}* ${ok ? 'finished' : 'could not finish'}:`,
    ...lines,
    ...prs.map((l) => `Pull request: ${l}`),
    ...toOpen.map((l) => `Branch pushed. Open a pull request: ${l}`),
    ...docs.map((l) => `Link: ${l}`),
    library ? `Everything it delivered is in the Library: ${library}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/// A reply in the thread: posted whole, unless it is very long, then the
/// start of it with the whole attached.
///
/// A file the reply names in the worker's own files (a report it built while
/// answering, with no run to collect it) goes up too, and the reply names it
/// rather than a path on the server nobody in Slack can open. With a file of
/// its own the reply isn't attached as well: that file is the full version,
/// and a copy of the reply beside it is the same thing twice.
///
/// `as`: post it as the worker itself, under its name and picture.
export async function deliverText(io: DeliverIo, channel: string, threadTs: string, workerName: string, text: string, filename: string, workerId?: string, as?: PostAs): Promise<void> {
  const files = workerId && io.workerFile
    ? pathsInReply(text).slice(0, MAX_UPLOADS).flatMap((p) => {
        const bytes = io.workerFile!(workerId, p, MAX_UPLOAD_BYTES);
        return bytes ? [{ path: p, name: p.split('/').pop() ?? 'file', bytes }] : [];
      })
    : [];
  let body = text.trim() || 'Done.';
  for (const f of files) body = body.split(f.path).join(`${f.name} (attached)`);
  const lead = as ? '' : `*${workerName}:* `;
  if (body.length <= SLACK_LONG_REPLY) await io.post(channel, `${lead}${slackMarkup(body)}`, threadTs, as);
  else if (files.length) await io.post(channel, `${lead}${slackMarkup(clip(body, SLACK_LONG_REPLY))}\n\n_More in ${files.map((f) => f.name).join(', ')}._`, threadTs, as);
  else {
    await io.post(channel, `${lead}${slackMarkup(clip(body, 1200))}\n\n_The full answer is attached._`, threadTs, as);
    await io.upload(channel, threadTs, filename, Buffer.from(body, 'utf8'));
  }
  for (const f of files) await io.upload(channel, threadTs, f.name, f.bytes);
}

/// Into the thread under the finished message: the answer itself (the last
/// artifact), then the files the work wrote — a rendered report, its data.
/// A change's answer is its summary and test results; a merged PR speaks for
/// itself. Returns how many files went up.
export async function deliverResults(io: DeliverIo, channel: string, threadTs: string, workerName: string, p: ErrandProgress): Promise<number> {
  const answer = [...p.files].reverse().find((x) => x.body && !x.sourcePath);
  if (answer?.body && !prLinks(p).length) await deliverText(io, channel, threadTs, workerName, answer.body, `${slug(answer.name)}.md`);
  let sent = 0;
  for (const file of p.files) {
    if (sent >= MAX_UPLOADS || !file.sourcePath || !UPLOADABLE.test(file.sourcePath)) continue;
    const bytes = io.readFile(file.sourcePath, MAX_UPLOAD_BYTES);
    if (!bytes) continue;
    if (await io.upload(channel, threadTs, file.name.split('/').pop() ?? file.name, bytes)) sent++;
  }
  return sent;
}
