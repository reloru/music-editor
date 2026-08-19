import { defineConfig } from 'vitest/config';

export default defineConfig({
  // iOS 16+ (iPhone 14 Pro Max shipped with iOS 16) is the oldest target we care about.
  build: {
    target: ['es2022', 'safari16'],
    outDir: 'dist',
    assetsInlineLimit: 0,
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  server: {
    host: true,
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'worker/**/*.test.ts'],
  },
});
