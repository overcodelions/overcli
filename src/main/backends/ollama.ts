// Ollama backend spec — placeholder. Ollama is HTTP-only: there is no
// subprocess to spawn and no stdin envelope. The runner detects the
// backend and routes through `sendOllama` instead, never reaching
// buildArgs / buildEnvelope. The spec exists so the registry has full
// coverage and a future caller that mistakenly invokes either method
// gets a clear, single-source error message.

import type { BackendSendArgs, BackendSpec } from './types';

export const ollamaBackend: BackendSpec = {
  name: 'ollama',

  buildArgs(_args: BackendSendArgs): string[] {
    throw new Error('Ollama backend uses the HTTP path, not subprocess args');
  },

  buildEnvelope(_args: BackendSendArgs): string {
    throw new Error('Ollama backend builds its payload in sendOllama');
  },
};
