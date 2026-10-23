import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  base: './',
  build: {
    outDir: '../android/app/build/generated/webAssets',
    emptyOutDir: true,
    target: 'chrome109',
  },
});
