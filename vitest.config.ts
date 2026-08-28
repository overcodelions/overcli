import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    environment: 'node',
    // Installs a default HostEnv before any test module is imported — see
    // src/main/testHostSetup.ts for why a per-file call is too late.
    setupFiles: ['src/main/testHostSetup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/shared/**', 'src/main/**', 'src/preload/**'],
      exclude: ['**/*.test.ts', '**/*.test.tsx'],
    },
  },
});
