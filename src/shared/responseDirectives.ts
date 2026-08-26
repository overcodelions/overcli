// The directives that make a turn SWIFT, in one place because two processes
// send them.
//
// The renderer prepends them to a chat prompt when the conversation is on
// Swift or Turbo (`responseMode.ts`); the worker engine prepends the same two
// to an errand so a worker you are sitting in front of answers the way a
// Swift chat does. Same words in both, or "swift" would quietly mean two
// different things depending on which surface you asked from.

export const CONCISE_RESPONSE_DIRECTIVE =
  'Keep progress updates to one short sentence. Give a compact final answer focused on the outcome, important caveats, and any action the user must take. Preserve full reasoning quality; concise refers only to visible output.';

export const EFFICIENT_TOOL_DIRECTIVE =
  'Before calling tools, collect independent reads, searches, and checks and issue them in one larger parallel batch when the tools allow it. Combine related shell checks into one command. Never skip necessary verification or combine dependent steps.';

export const SPEED_FIRST_DIRECTIVE =
  'Prioritize response latency. Take the shortest reliable path to the requested outcome, avoid optional exploration, and begin the useful answer as soon as enough evidence is available. Do not skip required checks.';
