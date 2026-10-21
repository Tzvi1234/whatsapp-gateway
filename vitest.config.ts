import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages,spikes,scripts}/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.claude/**', '**/dist/**', '**/.next/**'],
    environment: 'node',
    coverage: { provider: 'v8', reporter: ['text-summary', 'lcov'] },
  },
});
