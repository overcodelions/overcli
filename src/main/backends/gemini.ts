// Gemini CLI backend spec for the headless `gemini -p` path. The
// Gemini ACP transport (used when the CLI supports it) has its own send
// path in runner.ts and does not route through this spec.

import { geminiPermissionMapping } from '../permissionRules';
import type { BackendSendArgs, BackendSpec } from './types';

export const geminiBackend: BackendSpec = {
  name: 'gemini',

  buildArgs(args: BackendSendArgs): string[] {
    const a: string[] = ['-p', '-', '-o', 'stream-json'];
    if (args.model) a.push('-m', args.model);
    if (args.sessionId) a.push('--resume', args.sessionId);
    a.push('--approval-mode', geminiPermissionMapping(args.permissionMode));
    return a;
  },

  buildEnvelope(args: BackendSendArgs): string {
    // Gemini headless mode here is text-only for now, so image
    // attachments are dropped even though the CLI supports image paths.
    return args.prompt;
  },
};
