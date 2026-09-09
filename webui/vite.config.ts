import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  base: './',
  build: {
    outDir: '../webroot',
    emptyOutDir: true,
    target: 'chrome109',
  },
});
