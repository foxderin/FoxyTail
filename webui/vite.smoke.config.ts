/* Smoke-only build: single IIFE bundle jsdom can execute (module scripts
 * are not supported by jsdom). Not part of the shipped webroot. */
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  mode: 'smoke',
  plugins: [solid()],
  build: {
    outDir: '.smoke',
    emptyOutDir: true,
    target: 'chrome109',
    minify: false,
    rollupOptions: {
      input: 'dev/smoke.ts',
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
