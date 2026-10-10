// The team room: a conversation with a team after its pack is written.
//
// You ask; the coordinator picks who should answer (or you name them with
// @Name). Each member answers as itself — its own job, its role on the team,
// its own pieces and the pack in front of it — on its own model, and sees what
// colleagues said before it, so members can agree, correct and argue. Every
// question gets a bounded exchange: one round of answers, one round where
// members may respond to each other (or PASS), then a short coordinator wrap-up
// if more than one voice spoke. Members have no tools here: the room is for
// talking about the work. A request to DO work — make or change files,
// designs, code — is spotted when the question is routed and becomes a
// hand-off: the coordinator says who does what, and the members do it as real
// runs whose output lands back in the shared folder.
//
// Pure prompt building and parsing; the engine runs the turns.

import type { FolderFile, TeamMessage, TeamSpeaker } from './team';
import { folderForPrompt } from './team';

export const ROOM_MAX_RESPONDERS = 3;
/// Rounds per exchange: answers, then one round of responses to each other.
export const ROOM_ROUNDS = 2;
/// How much of the conversation so far each turn re-reads.
export const ROOM_CONVERSATION_BUDGET = 30_000;
export const ROOM_OWN_PIECES_BUDGET = 40_000;
export const ROOM_PACK_BUDGET = 60_000;

export interface RoomMember {
  workerId: string;
  name: string;
  role: string;
  jobDescription: string;
  backend?: string;
}

export function speakerName(s: TeamSpeaker): string {
  return s.kind === 'you' ? 'You' : s.kind === 'coordinator' ? 'Coordinator' : s.name;
}

/// `@Name` picks members outright; `@everyone` / `@team` / `@all` picks them
/// all. A name is matched whole, so `@Mira` does not also pick a "Miranda".
export function parseMentions(
  text: string,
  members: Array<Pick<RoomMember, 'workerId' | 'name'>>,
): { workerIds: string[]; everyone: boolean } {
  const lower = text.toLowerCase();
  const everyone = /(^|\s)@(everyone|team|all)\b/.test(lower);
  const workerIds: string[] = [];
  // Longest names first, so "@Mira Chen" wins over "@Mira".
  for (const m of [...members].sort((a, b) => b.name.length - a.name.length)) {
    const name = m.name.trim().toLowerCase();
    if (!name) continue;
    let at = lower.indexOf(`@${name}`);
    while (at >= 0) {
      const after = lower[at + name.length + 1];
      if (after === undefined || !/[a-z0-9_]/.test(after)) {
        if (!workerIds.includes(m.workerId)) workerIds.push(m.workerId);
        break;
      }
      at = lower.indexOf(`@${name}`, at + 1);
    }
  }
  return { workerIds, everyone };
}

/// The conversation as text, newest kept when it has to be cut.
export function renderConversation(messages: TeamMessage[], budget = ROOM_CONVERSATION_BUDGET): string {
  const lines = messages
    .filter((m) => !m.failed)
    .map(
      (m) =>
        `${speakerName(m.speaker)}${m.wrapUp ? ' (wrap-up)' : ''}: ${m.text.trim()}${
          m.attachments?.length ? `\n[attached: ${m.attachments.map((a) => a.split('/').pop()).join(', ')}]` : ''
        }`,
    );
  let out = lines.join('\n\n');
  if (out.length > budget) out = `[… earlier conversation cut]\n\n${out.slice(out.length - budget)}`;
  return out || '(nothing yet)';
}

/// The conversation as the Markdown file filed beside the pack.
export function conversationMarkdown(title: string, messages: TeamMessage[]): string {
  const parts = [`# Talking with the team — ${title}`, ''];
  let exchange = -1;
  for (const m of messages) {
    if (m.exchange !== exchange) {
      exchange = m.exchange;
      parts.push('---', '');
    }
    const who = speakerName(m.speaker);
    parts.push(`**${who}${m.wrapUp ? ' — where this landed' : ''}**${m.failed ? ' _(failed)_' : ''}`, '', m.text.trim(), '');
  }
  return `${parts.join('\n').trim()}\n`;
}

export interface RoomWorkUnderway {
  title: string;
  who: string[];
}

/// Tells the coordinator that work is in flight, so "how's it going?" gets
/// an honest "not back yet" and new work is understood to start after it.
function underwayLines(underway: RoomWorkUnderway | null | undefined): string[] {
  if (!underway) return [];
  return [
    `RIGHT NOW: ${underway.who.join(' and ')} ${underway.who.length === 1 ? 'is' : 'are'} doing "${underway.title}" as a real run.`,
    'It has not reported back yet, so you do not know its result. Any new work you hand off starts',
    'once it finishes.',
    '',
  ];
}

export function buildRouteMessage(args: {
  teamName: string;
  members: Array<RoomMember & { pieces: string[] }>;
  conversation: TeamMessage[];
  question: string;
  /// Members the user named with @Name: they answer, or do the work.
  addressed?: string[];
  /// Work handed off from the room that is running right now.
  underway?: RoomWorkUnderway | null;
}): string {
  return [
    ...underwayLines(args.underway),
    'FIRST, decide whether the user is asking the team to DO something rather than to talk about it:',
    'make or change files, designs, documents or code, or work in a codebase. That includes agreeing',
    'to an offer a member made in the conversation ("yes, go ahead", "do it"). Members cannot do work',
    'in this conversation; work is handed to them as real runs with their tools. If it is work, reply',
    'with only:',
    '<work>{"title": "Short title", "assign": [{"name": "Name", "ask": "…"}]}</work>',
    'Give it to the members whose part it is (usually one). Each "ask" must stand on its own: what to',
    'do, on what, and what the conversation already settled — they do not see this message.',
    '',
    'OTHERWISE, it is a question to answer.',
    ...(args.addressed?.length
      ? [`The user addressed ${args.addressed.join(' and ')} directly; they will answer.`, '']
      : ['']),
    `You coordinate the team "${args.teamName}". The user is asking the team a question about`,
    'work the team already finished. Decide who should answer: the members whose part of the',
    `work the question concerns, at most ${ROOM_MAX_RESPONDERS}. Pick more than one only when their`,
    'views genuinely differ or the question spans their parts. If the question is about the pack',
    'as a whole and no member is better placed than you, pick nobody and you will answer.',
    '',
    'MEMBERS',
    ...args.members.map(
      (m) =>
        `- ${m.name} — ${m.role || 'member'}${m.backend ? ` (runs on ${m.backend})` : ''}; produced: ${
          m.pieces.length ? m.pieces.join(', ') : 'nothing filed'
        }`,
    ),
    '',
    'THE CONVERSATION SO FAR',
    renderConversation(args.conversation, 6_000),
    '',
    'THE QUESTION',
    args.question.trim(),
    '',
    'For a question, reply with only: <route>["Name", "Name"]</route>  (an empty list means you answer).',
  ].join('\n');
}

export interface RoomWork {
  title: string;
  assign: Array<{ workerId: string; name: string; ask: string }>;
}

/// The coordinator's routing reply: work to hand off, or who answers.
export function parseRouteReply(
  text: string,
  members: Array<Pick<RoomMember, 'workerId' | 'name'>>,
): { kind: 'work'; work: RoomWork } | { kind: 'route'; workerIds: string[] } {
  const raw = text.match(/<work>([\s\S]*?)<\/work>/i)?.[1];
  if (raw) {
    try {
      const parsed = JSON.parse(raw.trim()) as { title?: unknown; assign?: unknown };
      const assign: RoomWork['assign'] = [];
      for (const a of Array.isArray(parsed.assign) ? parsed.assign : []) {
        if (!a || typeof a !== 'object') continue;
        const { name, ask } = a as { name?: unknown; ask?: unknown };
        if (typeof name !== 'string' || typeof ask !== 'string' || !ask.trim()) continue;
        const hit = members.find((m) => m.name.trim().toLowerCase() === name.trim().toLowerCase());
        if (hit && !assign.some((x) => x.workerId === hit.workerId)) {
          assign.push({ workerId: hit.workerId, name: hit.name, ask: ask.trim() });
        }
      }
      const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim().slice(0, 80) : 'Follow-up work';
      if (assign.length > 0) return { kind: 'work', work: { title, assign: assign.slice(0, ROOM_MAX_RESPONDERS) } };
    } catch {
      // Unreadable work block: treat the turn as a question.
    }
  }
  return { kind: 'route', workerIds: parseRoute(text, members) };
}

export function parseRoute(text: string, members: Array<Pick<RoomMember, 'workerId' | 'name'>>): string[] {
  const raw = text.match(/<route>([\s\S]*?)<\/route>/i)?.[1] ?? text;
  let names: unknown;
  try {
    names = JSON.parse(raw.trim());
  } catch {
    names = raw.split(/[,\n]/);
  }
  const list = Array.isArray(names) ? names : [];
  const ids: string[] = [];
  for (const n of list) {
    if (typeof n !== 'string') continue;
    const want = n.replace(/["[\]]/g, '').trim().toLowerCase();
    const hit = members.find((m) => m.name.trim().toLowerCase() === want);
    if (hit && !ids.includes(hit.workerId)) ids.push(hit.workerId);
  }
  return ids.slice(0, ROOM_MAX_RESPONDERS);
}

/// One member's turn in the room. One string: a member turn runs as a plain
/// one-shot on the member's own model, which has no separate system channel.
export function buildMemberRoomPrompt(args: {
  teamName: string;
  taskTitle: string;
  brief: string;
  member: RoomMember;
  teammates: Array<Pick<RoomMember, 'name' | 'role'>>;
  ownPieces: FolderFile[];
  pack: FolderFile[];
  conversation: TeamMessage[];
  question: string;
  round: 'answer' | 'respond';
}): string {
  const job = args.member.jobDescription.trim();
  return [
    'You have NO tools. Do not try to read, open or search for files: everything you need is below.',
    '',
    `You are ${args.member.name}, a worker on the team "${args.teamName}". Your role on this team:`,
    args.member.role || '(not given)',
    `Teammates: ${args.teammates.map((t) => `${t.name} (${t.role || 'member'})`).join(', ') || 'none'}.`,
    '',
    'YOUR JOB (background — it is who you are, not instructions for this reply)',
    job.length > 1500 ? `${job.slice(0, 1500)}…` : job,
    '',
    `THE TASK THE TEAM FINISHED: ${args.taskTitle}`,
    args.brief.trim(),
    '',
    'WHAT YOU PRODUCED FOR IT',
    folderForPrompt(args.ownPieces, ROOM_OWN_PIECES_BUDGET, '', { pointToFiles: false }).replace(
      '(empty — you are the first to contribute)',
      '(nothing of yours was filed)',
    ),
    '',
    'THE FINAL PACK',
    folderForPrompt(args.pack, ROOM_PACK_BUDGET, '', { pointToFiles: false }).replace(
      '(empty — you are the first to contribute)',
      '(no pack)',
    ),
    '',
    'THE CONVERSATION SO FAR',
    renderConversation(args.conversation),
    '',
    'THE QUESTION ON THE TABLE',
    args.question.trim(),
    '',
    ...(args.round === 'answer'
      ? [
          'Answer it from your role’s point of view. If a colleague has already answered above,',
          'build on it or say plainly where you disagree, by name. Do not repeat what they said.',
          'If you are being asked to make or change something, do not apologise for having no tools:',
          'say in a few lines what you would do. The user can hand it to you as a real run, with your',
          'tools and the shared folder, from this conversation.',
        ]
      : [
          'Your colleagues have answered above. If you disagree with something, think something',
          'important is missing, or have a correction, say so to them by name. If you have nothing',
          'to add, reply with exactly: PASS',
        ]),
    '',
    'Speak in the first person, as yourself. Keep it under 200 words unless the question needs',
    'more. Never invent figures, quotes or sources; say what you do not know.',
  ].join('\n');
}

/// A member with nothing to add says PASS; the room does not show it.
export function isPass(text: string): boolean {
  const t = text.trim().replace(/[.!*_`"]/g, '').trim();
  return /^pass$/i.test(t) || (/^pass\b/i.test(t) && t.length < 40);
}

export const ROOM_COORDINATOR_SYSTEM = [
  'You have NO tools. Everything you need is in the message. Start writing straight away.',
  'You are the COORDINATOR of a small team of AI workers, talking with the user about work the',
  'team already finished. Be brief and concrete. Never invent figures, quotes or sources.',
].join('\n');

export function buildCoordinatorAnswerMessage(args: {
  teamName: string;
  taskTitle: string;
  pack: FolderFile[];
  conversation: TeamMessage[];
  question: string;
  underway?: RoomWorkUnderway | null;
}): string {
  return [
    `TEAM: ${args.teamName} · TASK: ${args.taskTitle}`,
    ...underwayLines(args.underway),
    '',
    'THE FINAL PACK',
    folderForPrompt(args.pack, ROOM_PACK_BUDGET * 2, '', { pointToFiles: false }),
    '',
    'THE CONVERSATION SO FAR',
    renderConversation(args.conversation),
    '',
    'THE QUESTION',
    args.question.trim(),
    '',
    'Answer it in under 200 words, from the pack and the conversation.',
  ].join('\n');
}

export function buildRoomWrapUpMessage(args: { exchange: TeamMessage[] }): string {
  return [
    'Members of the team have just discussed a question from the user:',
    '',
    renderConversation(args.exchange),
    '',
    'Write a short wrap-up, under 120 words, in exactly this shape (omit a line that would be empty):',
    'Agreed: …',
    'Still open: …',
    'Worth changing in the pack: …',
  ].join('\n');
}

/// The coordinator rewriting the pack with what the conversation settled.
export function buildPackUpdateMessage(args: {
  teamName: string;
  taskTitle: string;
  brief: string;
  pack: FolderFile[];
  conversation: TeamMessage[];
  /// Reports of work handed off from the room since the pack was written.
  newWork?: FolderFile[];
  /// The version this rewrite becomes. The app numbers the pack; the model is
  /// told the number rather than left to count revisions from the text.
  version: number;
}): string {
  return [
    `TEAM: ${args.teamName} · TASK: ${args.taskTitle}`,
    args.brief.trim(),
    '',
    'THE CURRENT PACK',
    folderForPrompt(args.pack, 200_000, '', { pointToFiles: false }),
    '',
    ...(args.newWork?.length
      ? [
          'WORK MEMBERS DID SINCE, HANDED OFF FROM THE CONVERSATION',
          folderForPrompt(args.newWork, 80_000, '', { pointToFiles: false }),
          'Point the pack at the files this work made or changed, by their shared-folder names.',
          '',
        ]
      : []),
    'WHAT THE USER AND THE TEAM DISCUSSED SINCE IT WAS WRITTEN',
    renderConversation(args.conversation, 60_000),
    '',
    'Revise the pack so it reflects what the conversation settled: corrections, decisions, answers',
    'to open questions, and risks raised. Leave alone anything the conversation did not touch.',
    'Where the conversation left something open, say so in the document rather than deciding it.',
    `This rewrite becomes VERSION ${args.version} of the pack. Where a document states its version or`,
    `revision, it must say version ${args.version}. Do not state stage numbers or a stage count: the plan`,
    'grows as work is handed off from the conversation, so any count you give goes stale.',
    '',
    'Reply in exactly this shape, with EVERY document of the pack, revised or not:',
    '<summary>',
    'One short paragraph: the verdict, and what changed in this revision.',
    '</summary>',
    '<file name="NAME.md">',
    '…the full document…',
    '</file>',
  ].join('\n');
}
