/* Smoke-only build: single IIFE bundle jsdom can execute (module scripts
 * are not supported by jsdom). Not part of the shipped webroot. */
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: '.smoke',
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    rollupOptions: {
      input: 'index.html',
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
