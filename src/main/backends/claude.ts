// Claude CLI backend spec. Owns the CLI args and stdin envelope shape
// for `claude -p --input-format stream-json`. The parser state is still
// constructed via `makeClaudeParserState` from ../parsers/claude.

import { makeClaudeParserState } from '../parsers/claude';
import { normalizeAllowedDirs } from '../permissionRules';
import type { BackendCtx, BackendSendArgs, BackendSpec } from './types';

export const claudeBackend: BackendSpec = {
  name: 'claude',

  buildArgs(args: BackendSendArgs, ctx: BackendCtx): string[] {
    const a: string[] = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];
    if (args.sessionId) a.push('--resume', args.sessionId);
    if (args.model) a.push('--model', args.model);
    if (args.permissionMode && args.permissionMode !== 'default') {
      a.push('--permission-mode', args.permissionMode);
    }
    if (args.effortLevel) a.push('--thinking-effort', args.effortLevel);
    // In bypassPermissions mode Claude Code auto-allows everything
    // without prompting — wiring our permission-prompt-tool would force
    // it to route tool checks through us anyway, defeating the mode.
    if (args.permissionMode !== 'bypassPermissions') {
      const mcpConfigPath = ctx.mcpConfigPathFor(args.conversationId);
      if (mcpConfigPath) {
        a.push('--mcp-config', mcpConfigPath);
        a.push('--permission-prompt-tool', 'mcp__overcli__approve');
      }
    }
    for (const dir of normalizeAllowedDirs(args.cwd, args.allowedDirs)) {
      a.push('--add-dir', dir);
    }
    return a;
  },

  buildEnvelope(args: BackendSendArgs): string {
    const attachments = args.attachments ?? [];
    // If we have images, send content as an array of typed blocks.
    // Otherwise keep the plain-string form — equivalent on the wire but
    // cheaper to eyeball in logs.
    if (attachments.length === 0) {
      return JSON.stringify({
        type: 'user',
        message: { role: 'user', content: args.prompt },
      });
    }
    const content: any[] = attachments.map((a) => ({
      type: 'image',
      source: { type: 'base64', media_type: a.mimeType, data: a.dataBase64 },
    }));
    // Text always comes last so the user's words aren't buried above
    // the screenshots.
    content.push({ type: 'text', text: args.prompt || '(no text)' });
    return JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
    });
  },

  makeParserState(): unknown {
    return makeClaudeParserState();
  },
};
