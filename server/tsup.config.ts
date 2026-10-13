import { defineConfig } from 'tsup';

// Bundles the server (and the shared types package) into dist/index.js for production.
export default defineConfig({
  entry: { index: 'src/index.ts', users: 'src/cli/users.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  noExternal: ['@addendum/shared'],
});
