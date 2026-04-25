import { useStore } from '../store';
import { UUID } from '@shared/types';
import { Composer } from './Composer';
import { useConversation, useConversationRoot, useSlashCommands } from '../hooks';

export function InputBar({ conversationId }: { conversationId: UUID }) {
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const isRunning = useStore((s) => s.runners[conversationId]?.isRunning ?? false);
  const rootPath = useConversationRoot(conversationId);
  const conv = useConversation(conversationId);
  const slashCommands = useSlashCommands(conv?.primaryBackend, conversationId);
  const hasSlash = slashCommands.length > 0;

  return (
    <Composer
      draftKey={conversationId}
      variant="compact"
      isRunning={isRunning}
      rootPath={rootPath ?? undefined}
      slashCommands={slashCommands}
      autoFocus
      onSend={(prompt) => {
        void send(conversationId, prompt);
      }}
      onStop={() => void stop(conversationId)}
      placeholder={hasSlash ? 'Message… (type / for commands)' : 'Message…'}
    />
  );
}
