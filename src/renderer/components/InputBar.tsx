import { useStore } from '../store';
import { useRunnerIsRunning } from '../runnersStore';
import { UUID } from '@shared/types';
import { Composer } from './Composer';
import { useChromeCommandGuard } from './ChromeCommandGuard';
import { useConversation, useConversationRoot, useSlashCommands } from '../hooks';

export function InputBar({ conversationId }: { conversationId: UUID }) {
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const setChrome = useStore((s) => s.setChrome);
  const globalChrome = useStore((s) => s.settings.claudeChrome ?? false);
  const isRunning = useRunnerIsRunning(conversationId);
  const rootPath = useConversationRoot(conversationId);
  const conv = useConversation(conversationId);
  const slashCommands = useSlashCommands(conv?.primaryBackend, conversationId);
  const hasSlash = slashCommands.length > 0;
  // `/chrome <prose>` never reaches the model — rewrite it, or offer the
  // switch when the browser tools aren't attached.
  const chrome = useChromeCommandGuard({
    backend: conv?.primaryBackend,
    chromeOn: conv?.chrome ?? globalChrome,
    enableChrome: () => setChrome(conversationId, true),
    send: (prompt) => void send(conversationId, prompt),
  });

  return (
    <>
      {chrome.banner}
      <Composer
        draftKey={conversationId}
        variant="compact"
        isRunning={isRunning}
        rootPath={rootPath ?? undefined}
        slashCommands={slashCommands}
        autoFocus
        onSend={chrome.send}
        onStop={() => void stop(conversationId)}
        placeholder={hasSlash ? 'Message… (type / for commands)' : 'Message…'}
      />
    </>
  );
}
