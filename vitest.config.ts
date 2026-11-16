import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { 'vite-plus/test': fileURLToPath(new URL('./test-support/vitest.ts', import.meta.url)) } },
  test: {
    environment: 'node',
    include: [
      'packages/core/src/**/*.test.ts',
      'packages/contracts/src/orchestratorMcp.test.ts',
      'packages/chat-renderer/src/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/.repos/**', '**/.t3/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ['./packages/shared/src/testing/longTempDir.ts'],
  },
});
