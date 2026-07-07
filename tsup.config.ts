import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  // Runtime deps stay external (installed via package.json); playwright is an
  // optional peer used only by `login --browser`, resolved dynamically at runtime.
  external: ['playwright'],
});
