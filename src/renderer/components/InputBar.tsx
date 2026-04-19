import { useStore } from '../store';
import { UUID } from '@shared/types';
import { Composer } from './Composer';

export function InputBar({ conversationId }: { conversationId: UUID }) {
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const isRunning = useStore((s) => s.runners[conversationId]?.isRunning ?? false);
  const lastInit = useStore((s) => s.lastInit);
  const hasSlash = (lastInit?.slashCommands?.length ?? 0) > 0;

  return (
    <Composer
      draftKey={conversationId}
      variant="compact"
      isRunning={isRunning}
      onSend={(prompt) => {
        void send(conversationId, prompt);
      }}
      onStop={() => void stop(conversationId)}
      placeholder={hasSlash ? 'Message… (type / for commands)' : 'Message…'}
    />
  );
}
