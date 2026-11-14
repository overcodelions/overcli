// The model half of auto-naming a conversation: one short, hidden turn on
// the fast tier of whichever CLI is signed in. The deciding (when, which
// refs, what to keep) lives in src/shared/conversationTitle.ts and the
// renderer; this only asks.

import { oneShotDraftText, type DraftDeps } from './flows/drafter';
import { tierDefault } from '../shared/modelCatalog';
import { pickDrafterBackend } from '../shared/flows/drafterBackend';
import { readTitleReply, titlePrompt, TITLE_SYSTEM_PROMPT } from '../shared/conversationTitle';
import { healthyBackends } from './health';

export type TitleSuggestion = { ok: true; title: string } | { ok: true; keep: true } | { ok: false; error: string };

export async function suggestConversationTitle(
  deps: DraftDeps,
  args: { current: string | null; excerpt: string },
): Promise<TitleSuggestion> {
  if (!args.excerpt.trim()) return { ok: false, error: 'Nothing to name yet.' };
  const healthy = await healthyBackends(deps.settings.backendPaths);
  const backend = pickDrafterBackend({
    preferred: deps.settings.preferredBackend,
    isHealthy: (b) => healthy.has(b),
    isEnabled: (b) => deps.settings.disabledBackends[b] !== true,
  });
  const model = backend && backend !== 'ollama' ? tierDefault(backend, 'fast', deps.settings.flowModelDefaults) : undefined;
  const res = await oneShotDraftText(deps, {
    buildSystemPrompt: () => TITLE_SYSTEM_PROMPT,
    userMessage: titlePrompt(args),
    verb: 'name the conversation',
    model,
    // A title is a few words; anything slower than this has gone wrong and
    // the placeholder name is a fine answer.
    timeouts: { timeoutMs: 45_000, idleTimeoutMs: 30_000 },
    permissionMode: 'plan',
  });
  if (!res.ok) return res;
  const read = readTitleReply(res.text);
  if (read === null) return { ok: false, error: 'The model gave no usable title.' };
  return read === 'keep' ? { ok: true, keep: true } : { ok: true, title: read };
}
