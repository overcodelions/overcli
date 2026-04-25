// Codex CLI backend spec. Owns the CLI args and stdin envelope shape
// for `codex exec` (the fallback path used when the proto / app-server
// transport isn't available). The proto/app-server send paths route
// through their own clients in runner.ts and never touch buildEnvelope.

import { codexTransportPermissions } from '../permissionRules';
import type { BackendCtx, BackendSendArgs, BackendSpec } from './types';

export const codexBackend: BackendSpec = {
  name: 'codex',

  buildArgs(args: BackendSendArgs): string[] {
    const { sandbox, approval } = codexTransportPermissions(args.permissionMode);
    const a: string[] = [];
    if (args.model) a.push('-m', args.model);
    a.push('-s', sandbox, '-a', approval, 'exec', '-');
    return a;
  },

  buildEnvelope(args: BackendSendArgs, ctx: BackendCtx): string {
    const transcript = ctx.codexExecTranscriptFor(args.conversationId);
    if (!transcript || transcript.length === 0) return args.prompt;
    const history = transcript
      .map((t) => `User: ${t.user}\n\nAssistant: ${t.assistant}`)
      .join('\n\n---\n\n');
    return `Prior turns in this conversation (for context only — do not repeat them):\n\n${history}\n\n---\n\nNew user message:\n\n${args.prompt}`;
  },
};
