import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'clients/node/test/**/*.test.ts',
    ],
    exclude: [
      'node_modules/**',
      'dist/**',
      'out/**',
      '.vscode-test/**',
      'Releases/**',
    ],
  },
});
