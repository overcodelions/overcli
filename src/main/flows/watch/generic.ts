// AI-defined watch source — the DEFAULT, and the answer to "what if the user
// doesn't have Jira / has some other use case entirely". The watcher is just
// an LLM with whatever tools that particular user has connected (MCP servers,
// web fetch, gh, email, Slack, …). So a watch doesn't need us to ship a
// bespoke integration per system: it needs the user's natural-language
// `instructions` describing what to watch + how to respond, and the model
// figures out which of ITS tools can reach the target each tick.

import {
  answerContract,
  detectContract,
  registerWatchSource,
  type WatchSource,
} from './source';

const aiSource: WatchSource = {
  id: 'ai',
  displayName: 'AI-defined watch (describe it in plain language)',
  buildDetectPrompt: (ctx) =>
    [
      'Detect tick for a user-defined watch on already-completed work. The user',
      'described what to watch in the instructions below.',
      ctx.binding ? `Watch target / reference: ${ctx.binding}` : '',
      'Use the tools you actually have (MCP servers, web fetch, gh, email, chat,',
      '…) to check the target for responses newer than the cursor. If you have no',
      "tool that can reach it, say so in the note and don't guess. Post nothing —",
      'just decide whether anything new needs a reply.',
      detectContract(ctx),
    ]
      .filter(Boolean)
      .join('\n'),
  buildAnswerPrompt: (ctx) =>
    [
      'Answer tick for a user-defined watch.',
      ctx.binding ? `Watch target / reference: ${ctx.binding}` : '',
      'Reply in the same place the comment was raised, using your available tools.',
      answerContract(ctx),
    ]
      .filter(Boolean)
      .join('\n'),
};

registerWatchSource(aiSource);

export { aiSource };
