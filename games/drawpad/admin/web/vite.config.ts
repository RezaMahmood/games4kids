import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

/** The admin site serves the shell and the shared bar. Fonts are bundled, because the site's CSP allows font-src 'self' only. */
export default defineConfig({
  base: '/g/drawpad/',
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: { external: ['/shell/v1/index.js'] },
  },
});
